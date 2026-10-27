<script setup lang="ts">
import {
  MONGO_EXPORT_FORMATS,
  type MongoCollectionHostMessage,
  type MongoDocument,
  type MongoDocumentsView,
  type MongoExportFormat,
  type MongoFindQuery,
} from '@datakit/core';
import { computed, nextTick, onUnmounted, ref, shallowRef, watch } from 'vue';
import ConfirmDialog from '../components/ConfirmDialog.vue';
import Icon from '../components/Icon.vue';
import IconButton from '../components/IconButton.vue';
import SplitHandle from '../components/SplitHandle.vue';
import { keepText, savedValue, usePersistedState } from '../composables/usePersistedState';
import { onHostMessage } from '../host';
import { useCollection } from './collection';
import DocumentList from './DocumentList.vue';
import DocumentPane, { type PaneDraft } from './DocumentPane.vue';
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
 * document in a pane beside them. Paging moves the skip by the page size from the Skip of the query. The view, the
 * page size and the export format are remembered for the next tab. Unsaved edits in the pane are never dropped
 * without asking: picking another document asks first, and paging keeps the pane open.
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

const MODES: { id: MongoDocumentsView; label: string }[] = [
  { id: 'list', label: 'List' },
  { id: 'table', label: 'Table' },
  { id: 'json', label: 'JSON' },
];
const mode = ref<MongoDocumentsView>(s.init!.prefs.view);
watch(mode, (view) => col.remember({ view }));
const exportFormat = ref<MongoExportFormat>(s.init!.prefs.exportFormat);
watch(exportFormat, (format) => col.remember({ exportFormat: format }));

const pickedKey = ref<string | null>(null);
/** The document in the pane, as last read; it stays while the pane has unsaved edits, even when paging moves on. */
const picked = shallowRef<MongoDocument | null>(null);
const paneDirty = ref(false);
const focusRequest = ref(0);
/** The pane's unsaved edits, kept across reloads; `restoredPane` hands them back to the pane once. */
const paneDraft = ref<PaneDraft | null>(null);
const restoredPane = ref<PaneDraft | null>(null);

type Dialog =
  | { kind: 'insert'; title: string; text: string }
  | { kind: 'delete'; document: MongoDocument }
  | { kind: 'updateMatching' }
  | { kind: 'deleteMatching' }
  | { kind: 'discard'; then: () => void };
const dialog = ref<Dialog | null>(null);
const production = computed(() => s.init!.environment === 'production');

const DEFAULT_PANE_WIDTH = 420;
const paneWidth = ref(DEFAULT_PANE_WIDTH);
const content = ref<HTMLElement>();
const maxPaneWidth = () => Math.max(280, (content.value?.clientWidth ?? 900) - 260);

const canWrite = computed(() => col.canWrite.value);
const pageSkip = computed(() => applied.value.skip + pageIndex.value * pageSize.value);
const lastIndex = computed(() => lastPageIndex(count.value, applied.value.skip, pageSize.value));
const hasNext = computed(() => (count.value === null ? documents.value.length === pageSize.value : pageSkip.value + documents.value.length < count.value));
const hasFilter = computed(() => !!applied.value.filter && !/^\{\s*\}$/.test(applied.value.filter));
const deleteMatchingTitle = computed(() => {
  if (!hasFilter.value) return 'Find with a filter first; deleting with an empty filter is refused';
  return count.value === 0 ? 'No documents match the filter' : 'Delete every document that matches the filter';
});

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
  col.remember({ pageSize: size });
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

/** Runs `then`, after asking whether to drop the pane's unsaved edits when it has some. */
function leavePane(then: () => void): void {
  if (paneDirty.value) dialog.value = { kind: 'discard', then };
  else then();
}

function show(d: MongoDocument | null, key: string | null): void {
  if (key !== pickedKey.value) {
    paneDraft.value = null;
    restoredPane.value = null;
  }
  picked.value = d;
  pickedKey.value = key;
}

function pick(d: MongoDocument, key: string): void {
  if (key !== pickedKey.value) leavePane(() => show(d, key));
}

function edit(d: MongoDocument, key: string): void {
  const focus = () => void nextTick(() => focusRequest.value++);
  if (key === pickedKey.value) focus();
  else leavePane(() => (show(d, key), focus()));
}

function closePane(): void {
  leavePane(() => show(null, null));
}

const discard = async () => {
  const then = (dialog.value as { then: () => void }).then;
  paneDirty.value = false;
  then();
  return { ok: true, message: '' };
};

function addDocument(): void {
  dialog.value = { kind: 'insert', title: 'Add document', text: '{\n  \n}' };
}

function copyDocument(d: MongoDocument): void {
  col.copy(d.text, `the document ${d.idText ?? ''}`.trim());
}

function exportDocuments(): void {
  const { filter, projection, sort } = applied.value;
  col.post({ type: 'export', query: { filter, projection, sort }, format: exportFormat.value });
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
    restoredPick = null;
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
  if (restoredPick !== null) {
    // The document open before the reload, if it is still on the page; otherwise the pane just stays closed.
    const { key, draft } = restoredPick;
    restoredPick = null;
    const found = documents.value.find((d, i) => documentKey(d, i) === key);
    if (found) {
      show(found, key);
      restoredPane.value = draft;
    }
    return;
  }
  if (pickedKey.value === null) return;
  const fresh = documents.value.find((d, i) => documentKey(d, i) === pickedKey.value);
  if (fresh) picked.value = fresh;
  else if (!paneDirty.value) show(null, null);
});
onUnmounted(stop);

/** Query bar fields, and the pane's draft, longer than these are not kept. */
const KEPT_FIELD = 20_000;
const KEPT_DRAFT = 100_000;
const KEPT_KEY = 2000;
const ns = `${s.init!.database}.${s.init!.collection}`;
type SavedQuery = Omit<MongoFindQuery, 'limit'>;

interface SavedDocuments {
  ns: string;
  draft: QueryDraft;
  applied: SavedQuery;
  pageIndex: number;
  /** The document open in the pane, by its _id; documents without one are not kept. */
  picked: string | null;
  pane: PaneDraft | null;
}

const field = (value: unknown) => savedValue.string(value, KEPT_FIELD) ?? '';
/**
 * The query bar, the query of the page on show and its page, and the open document with its unsaved edits come back
 * after a reload; the page is read again (find only reads). The documents themselves are never kept.
 */
const persisted = usePersistedState<SavedDocuments>('mongo.documents', {
  version: 1,
  value: () => {
    const keep = (text: string) => keepText(text, KEPT_FIELD) ?? '';
    const d = draft.value;
    const a = applied.value;
    const key = pickedKey.value;
    const pane = paneDraft.value;
    return {
      ns,
      draft: { filter: keep(d.filter), projection: keep(d.projection), sort: keep(d.sort), collation: keep(d.collation), skip: keep(d.skip) },
      applied: { filter: keep(a.filter), projection: keep(a.projection), sort: keep(a.sort), collation: keep(a.collation), skip: a.skip },
      pageIndex: pageIndex.value,
      picked: key !== null && !key.startsWith('#') && key.length <= KEPT_KEY ? key : null,
      pane: pane && keepText(pane.text, KEPT_DRAFT) !== undefined ? pane : null,
    };
  },
  validate: (saved) => {
    const o = savedValue.object(saved);
    const name = savedValue.string(o?.ns);
    if (!o || name === undefined) return undefined;
    const d = savedValue.object(o.draft) ?? {};
    const a = savedValue.object(o.applied) ?? {};
    const p = savedValue.object(o.pane);
    const base = savedValue.string(p?.base, 100);
    const text = savedValue.string(p?.text, KEPT_DRAFT);
    return {
      ns: name,
      draft: { filter: field(d.filter), projection: field(d.projection), sort: field(d.sort), collation: field(d.collation), skip: field(d.skip) },
      applied: { filter: field(a.filter), projection: field(a.projection), sort: field(a.sort), collation: field(a.collation), skip: savedValue.integer(a.skip) ?? 0 },
      pageIndex: savedValue.integer(o.pageIndex) ?? 0,
      picked: savedValue.string(o.picked, KEPT_KEY) ?? null,
      pane: base !== undefined && text !== undefined ? { base, text } : null,
    };
  },
});
/** The document to open again once the first page is read. */
let restoredPick: { key: string; draft: PaneDraft | null } | null = null;
const saved = persisted.restore();
if (saved && saved.ns === ns) {
  draft.value = saved.draft;
  applied.value = { ...saved.applied, limit: pageSize.value };
  pageIndex.value = saved.pageIndex;
  if (saved.picked !== null) restoredPick = { key: saved.picked, draft: saved.pane };
}

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
        <button type="button" class="btn sm btn-primary" @click="addDocument"><Icon name="plus" :size="14" /> Add document</button>
      </template>
      <span class="export" role="group" aria-label="Export">
        <select v-model="exportFormat" class="sel" aria-label="Export format">
          <option v-for="f in MONGO_EXPORT_FORMATS" :key="f.value" :value="f.value">{{ f.label }}</option>
        </select>
        <button type="button" class="btn sm" title="Export every document that matches the query, not only this page" @click="exportDocuments">Export…</button>
      </span>
      <template v-if="canWrite">
        <button type="button" class="btn sm" @click="dialog = { kind: 'updateMatching' }">Update matching…</button>
        <button
          type="button"
          class="btn sm danger-text"
          :disabled="!hasFilter || count === 0"
          :title="deleteMatchingTitle"
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
        <p v-else-if="loaded && (hasFilter || applied.skip)" class="empty-state">
          No documents match this query. <button type="button" class="lnk" @click="reset">Clear the query</button>
        </p>
        <p v-else-if="loaded" class="empty-state">
          The collection is empty.<template v-if="canWrite"> <button type="button" class="lnk" @click="addDocument">Add a document</button></template>
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
        <DocumentPane
          class="pane"
          :document="picked"
          :read-only-reason="col.readOnlyReason.value"
          :focus-request="focusRequest"
          :initial-draft="restoredPane"
          @close="closePane"
          @deleted="show(null, null)"
          @dirty="paneDirty = $event"
          @draft="paneDraft = $event"
        />
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
      :primary="count === null ? 'Delete documents' : `Delete ${plural(count, 'document')}`"
      :target="production ? s.init!.collection : null"
      :action="deleteMatching"
      @close="dialog = null"
    >
      <pre class="filter-shown" :title="oneLine(applied.filter, 400)"><ShellText :text="applied.filter" /></pre>
    </ConfirmDialog>
    <ConfirmDialog
      v-else-if="dialog?.kind === 'discard'"
      title="Discard changes"
      :text="`The document ${picked?.idText ?? ''} has changes that are not saved. Discard them?`"
      primary="Discard changes"
      :action="discard"
      @close="dialog = null"
    />
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
  display: inline-flex;
  gap: 4px;
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
