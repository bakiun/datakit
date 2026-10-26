<script setup lang="ts">
import { MONGO_EXPORT_FORMATS, type MongoCollectionHostMessage, type MongoDocument, type MongoExportFormat, type MongoFindQuery } from '@datakit/core';
import { computed, nextTick, onUnmounted, ref, watch } from 'vue';
import ConfirmDialog from '../components/ConfirmDialog.vue';
import Icon from '../components/Icon.vue';
import IconButton from '../components/IconButton.vue';
import SplitHandle from '../components/SplitHandle.vue';
import { onHostMessage } from '../host';
import { useCollection } from './collection';
import DocumentList from './DocumentList.vue';
import DocumentPane from './DocumentPane.vue';
import DocumentsJson from './DocumentsJson.vue';
import DocumentTable from './DocumentTable.vue';
import { documentKey, errorField, lastPageIndex, num, oneLine, pageRange, pageSizeChoices, parseSkip, plural, startPageSize, type QueryField } from './format';
import InsertDialog from './InsertDialog.vue';
import QueryBar, { emptyDraft, type QueryDraft } from './QueryBar.vue';
import ShellText from './ShellText.vue';
import { withoutId } from './shellSyntax';
import UpdateMatchingDialog from './UpdateMatchingDialog.vue';

/**
 * The Documents tab: the query bar, then the page of documents as cards, a table or one array, and the picked
 * document in a pane beside them. Paging moves the skip by the page size from the Skip of the query.
 */
const props = defineProps<{ active: boolean }>();
const col = useCollection();
const s = col.state;

const startSize = startPageSize(s.init!.pageSize);
const sizes = pageSizeChoices(startSize);
const pageSize = ref(startSize);
const draft = ref<QueryDraft>(emptyDraft());
/** The query of the page on show; paging and exports use it, not what the bar holds now. */
const applied = ref<MongoFindQuery>({ filter: '', projection: '', sort: '', collation: '', skip: 0, limit: startSize });
const pageIndex = ref(0);
const current = ref(0);
const loading = ref(false);
const loaded = ref(false);
const error = ref<string | null>(null);
const invalid = ref<QueryField | null>(null);
const documents = ref<MongoDocument[]>([]);
const count = ref<number | null>(null);
const durationMs = ref(0);
/** The documents version the page was read at; a newer one reads it again. */
let readVersion = -1;

type Mode = 'list' | 'table' | 'json';
const MODES: { id: Mode; label: string }[] = [
  { id: 'list', label: 'List' },
  { id: 'table', label: 'Table' },
  { id: 'json', label: 'JSON' },
];
const mode = ref<Mode>('list');

const pickedKey = ref<string | null>(null);
const picked = computed(() => documents.value.find((d, i) => documentKey(d, i) === pickedKey.value) ?? null);
const focusRequest = ref(0);

type Dialog = { kind: 'insert'; title: string; text: string } | { kind: 'delete'; document: MongoDocument } | { kind: 'updateMatching' } | { kind: 'deleteMatching' };
const dialog = ref<Dialog | null>(null);

const DEFAULT_PANE_WIDTH = 420;
const paneWidth = ref(DEFAULT_PANE_WIDTH);
const content = ref<HTMLElement>();
const maxPaneWidth = () => Math.max(280, (content.value?.clientWidth ?? 900) - 260);

const canWrite = computed(() => col.canWrite.value);
const pageSkip = computed(() => applied.value.skip + pageIndex.value * pageSize.value);
const lastIndex = computed(() => lastPageIndex(count.value, applied.value.skip, pageSize.value));
const hasNext = computed(() => (count.value === null ? documents.value.length === pageSize.value : pageSkip.value + documents.value.length < count.value));
const hasFilter = computed(() => !!applied.value.filter && !/^\{\s*\}$/.test(applied.value.filter));

const status = computed((): { text: string; tone: 'ok' | 'error' | 'muted' } => {
  if (error.value) return { text: error.value, tone: 'error' };
  if (!loaded.value) return { text: 'Finding documents…', tone: 'muted' };
  const parts: string[] = [];
  const where = s.init!.type === 'view' ? 'in the view' : 'in the collection';
  if (count.value !== null) parts.push(`${plural(count.value, 'document')} ${hasFilter.value || applied.value.skip ? 'match' : where}`);
  if (!documents.value.length && count.value) parts.push('nothing on this page');
  parts.push(`read in ${num(Math.round(durationMs.value))} ms`);
  if (count.value === null) parts.push('the total is not known (counting took too long)');
  return { text: parts.join(' · ').replace(/^./, (c) => c.toUpperCase()), tone: loading.value ? 'muted' : 'ok' };
});

function queryFromDraft(): MongoFindQuery | null {
  const d = draft.value;
  const skip = parseSkip(d.skip);
  if (skip === null) {
    error.value = 'Skip: a whole number of documents, e.g. 100.';
    invalid.value = 'skip';
    return null;
  }
  return { filter: d.filter.trim(), projection: d.projection.trim(), sort: d.sort.trim(), collation: d.collation.trim(), skip, limit: pageSize.value };
}

function fetchPage(): void {
  current.value = col.nextRequestId();
  loading.value = true;
  readVersion = s.documentsVersion;
  col.post({ type: 'find', requestId: current.value, query: { ...applied.value, skip: pageSkip.value, limit: pageSize.value } });
}

function find(): void {
  const query = queryFromDraft();
  if (!query) return;
  applied.value = query;
  pageIndex.value = 0;
  error.value = null;
  invalid.value = null;
  fetchPage();
}

function reset(): void {
  draft.value = emptyDraft();
  find();
}

function explain(): void {
  const query = queryFromDraft();
  if (query) col.explain(query, 'find');
}

function goTo(index: number): void {
  pageIndex.value = Math.max(0, index);
  fetchPage();
}

watch(pageSize, (size) => {
  applied.value = { ...applied.value, limit: size };
  pageIndex.value = 0;
  fetchPage();
});

// Writes from this tab, other tabs or the shell: the page is read again now, or when the tab is shown next.
watch(
  () => [s.documentsVersion, props.active] as const,
  ([version, active]) => {
    if (active && loaded.value && version !== readVersion) fetchPage();
  },
);

function pick(_d: MongoDocument, key: string): void {
  pickedKey.value = key;
}

function edit(_d: MongoDocument, key: string): void {
  pickedKey.value = key;
  void nextTick(() => focusRequest.value++);
}

function copyDocument(d: MongoDocument): void {
  col.copy(d.text, `the document ${d.idText ?? ''}`.trim());
}

function exportAs(event: Event): void {
  const select = event.target as HTMLSelectElement;
  const format = select.value as MongoExportFormat | '';
  select.value = '';
  if (!format) return;
  const { filter, projection, sort } = applied.value;
  col.post({ type: 'export', query: { filter, projection, sort }, format });
}

const deleteOne = () => {
  const d = (dialog.value as { document: MongoDocument }).document;
  return col.write({ kind: 'delete', ids: [d.id!] }, { quiet: true });
};
const deleteMatching = () => col.write({ kind: 'deleteMatching', filter: applied.value.filter }, { quiet: true });

const stop = onHostMessage<MongoCollectionHostMessage>((message) => {
  if ((message.type !== 'page' && message.type !== 'pageFailed') || message.requestId !== current.value) return;
  loading.value = false;
  if (message.type === 'pageFailed') {
    error.value = message.message;
    invalid.value = errorField(message.message);
    return;
  }
  // A write emptied the last page: show the page that is now the last one.
  if (!message.page.documents.length && pageIndex.value > 0) {
    goTo(lastPageIndex(message.page.count, applied.value.skip, pageSize.value) ?? pageIndex.value - 1);
    return;
  }
  loaded.value = true;
  error.value = null;
  invalid.value = null;
  documents.value = message.page.documents;
  count.value = message.page.count;
  durationMs.value = message.durationMs;
  if (pickedKey.value !== null && !documents.value.some((d, i) => documentKey(d, i) === pickedKey.value)) pickedKey.value = null;
});
onUnmounted(stop);

fetchPage();
</script>

<template>
  <div class="documents-tab">
    <QueryBar v-model="draft" v-model:page-size="pageSize" :sizes="sizes" :invalid="invalid" @find="find" @reset="reset" @explain="explain" />
    <div class="status-row">
      <p class="message-line" :class="status.tone" :role="status.tone === 'error' ? 'alert' : 'status'">
        <Icon v-if="status.tone === 'error'" name="error" :size="14" />{{ status.text }}
      </p>
      <div class="paging" role="group" aria-label="Pages">
        <IconButton icon="first" label="First page" :disabled="loading || pageIndex === 0" @click="goTo(0)" />
        <IconButton icon="previous" label="Previous page" :disabled="loading || pageIndex === 0" @click="goTo(pageIndex - 1)" />
        <span class="range mono">{{ pageRange(pageSkip, documents.length, count) }}</span>
        <IconButton icon="next" label="Next page" :disabled="loading || !hasNext" @click="goTo(pageIndex + 1)" />
        <IconButton
          icon="last"
          :label="lastIndex === null ? 'Last page (the count is not known)' : 'Last page'"
          :disabled="loading || lastIndex === null || pageIndex >= lastIndex"
          @click="goTo(lastIndex ?? 0)"
        />
        <IconButton icon="reload" label="Read the page again" :disabled="loading" @click="fetchPage" />
      </div>
    </div>

    <div role="toolbar" aria-label="Documents" class="toolbar">
      <template v-if="canWrite">
        <button type="button" class="btn sm btn-primary" @click="dialog = { kind: 'insert', title: 'Add document', text: '{\n  \n}' }">
          <Icon name="plus" :size="14" /> Add document
        </button>
      </template>
      <select class="sel export" aria-label="Export every document that matches the query" title="Export every document that matches the query, not only this page" value="" @change="exportAs">
        <option value="">Export…</option>
        <option v-for="f in MONGO_EXPORT_FORMATS" :key="f.value" :value="f.value">{{ f.label }}</option>
      </select>
      <template v-if="canWrite">
        <button type="button" class="btn sm" @click="dialog = { kind: 'updateMatching' }">Update matching…</button>
        <button
          type="button"
          class="btn sm danger-text"
          :disabled="!hasFilter"
          :title="hasFilter ? 'Delete every document that matches the filter' : 'Find with a filter first; deleting with an empty filter is refused'"
          @click="dialog = { kind: 'deleteMatching' }"
        >
          Delete matching…
        </button>
      </template>
      <span class="spacer" />
      <div class="seg-group" role="group" aria-label="Show documents as">
        <button v-for="m in MODES" :key="m.id" type="button" class="seg" :aria-pressed="mode === m.id" @click="mode = m.id">{{ m.label }}</button>
      </div>
    </div>

    <div ref="content" class="content" :class="{ 'with-pane': picked }" :style="{ '--pane-width': `${paneWidth}px` }">
      <div class="results" :class="{ dim: loading, json: mode === 'json' }">
        <template v-if="documents.length">
          <DocumentList
            v-if="mode === 'list'"
            :documents="documents"
            :picked="pickedKey"
            :actions="canWrite"
            pickable
            @pick="pick"
            @edit="edit"
            @copy="copyDocument"
            @duplicate="dialog = { kind: 'insert', title: 'Duplicate document', text: withoutId($event.text) }"
            @delete="dialog = { kind: 'delete', document: $event }"
          />
          <DocumentTable v-else-if="mode === 'table'" :documents="documents" :picked="pickedKey" :can-write="canWrite" @pick="pick" @open="edit" />
          <DocumentsJson v-else :documents="documents" />
        </template>
        <p v-else-if="loaded" class="empty-state">
          {{ hasFilter || applied.skip ? 'No documents match this query.' : canWrite ? 'The collection is empty. Add a document to get started.' : 'The collection is empty.' }}
        </p>
      </div>
      <template v-if="picked">
        <SplitHandle
          v-model="paneWidth"
          direction="columns"
          after
          class="pane-handle"
          label="Resize the document pane"
          :min="280"
          :max="maxPaneWidth"
          :default-size="DEFAULT_PANE_WIDTH"
        />
        <DocumentPane class="pane" :document="picked" :read-only-reason="col.readOnlyReason.value" :focus-request="focusRequest" @close="pickedKey = null" />
      </template>
    </div>
    <p v-if="mode === 'table' && canWrite && documents.length" class="hint">
      Click a row to open the document · double-click a value to edit it · Enter writes it with $set · Esc cancels
    </p>

    <InsertDialog v-if="dialog?.kind === 'insert'" :title="dialog.title" :text="dialog.text" @close="dialog = null" />
    <ConfirmDialog
      v-else-if="dialog?.kind === 'delete'"
      title="Delete document"
      :text="`Delete the document ${dialog.document.idText ?? ''}? This cannot be undone.`"
      primary="Delete document"
      :action="deleteOne"
      @close="dialog = null"
    />
    <UpdateMatchingDialog v-else-if="dialog?.kind === 'updateMatching'" :filter="applied.filter" :count="count" @close="dialog = null" />
    <ConfirmDialog
      v-else-if="dialog?.kind === 'deleteMatching'"
      title="Delete matching documents"
      :text="`Deletes every document in ${s.init!.collection} that matches this filter${count === null ? '' : ` (${plural(count, 'document')} at the last Find)`}. This cannot be undone.`"
      primary="Delete documents"
      :target="s.init!.collection"
      :action="deleteMatching"
      @close="dialog = null"
    >
      <pre class="filter-shown" :title="oneLine(applied.filter, 400)"><ShellText :text="applied.filter" /></pre>
    </ConfirmDialog>
  </div>
</template>

<style scoped>
.documents-tab {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.toolbar {
  flex: none;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 8px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--m-border);
}
.spacer {
  flex: 1;
}
.status-row {
  flex: none;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0 8px;
  padding-right: 8px;
  border-bottom: 1px solid var(--m-border);
}
.status-row .message-line {
  flex: 1 1 260px;
  border-bottom: 0;
}
.paging {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 2px;
}
.paging :deep(.toolbar-btn) {
  width: 26px;
  height: 26px;
}
.export {
  width: 96px;
}
.range {
  padding: 0 6px;
  white-space: nowrap;
}
.content {
  flex: 1;
  min-height: 0;
  display: flex;
}
.results {
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: auto;
}
.results.json {
  overflow: hidden;
}
.results.dim {
  opacity: 0.55;
}
.pane {
  flex: none;
  width: var(--pane-width);
  border-left: 1px solid var(--m-border);
}
.hint {
  flex: none;
  margin: 0;
  padding: 5px 12px;
  border-top: 1px solid var(--m-border);
  font-size: 12px;
  color: var(--m-muted);
}
.filter-shown {
  margin: 0;
  max-height: 120px;
  overflow: auto;
  padding: 8px 10px;
  border: 1px solid var(--m-border);
  border-radius: 4px;
  background: var(--vscode-editor-background);
  font-size: 12px;
}
@media (max-width: 760px) {
  .content {
    flex-direction: column;
  }
  .results {
    flex: 1 1 200px;
  }
  .pane-handle {
    display: none;
  }
  .pane {
    flex: 0 0 auto;
    width: auto;
    height: min(380px, 45vh);
    border-left: 0;
    border-top: 1px solid var(--m-border);
  }
}
</style>
