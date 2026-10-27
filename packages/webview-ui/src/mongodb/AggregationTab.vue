<script setup lang="ts">
import type { MongoCollectionHostMessage, MongoDocument } from '@datakit/core';
import { computed, nextTick, onUnmounted, ref, watch } from 'vue';
import Icon from '../components/Icon.vue';
import { SUBMIT_KEY } from '../components/shortcuts';
import SplitHandle from '../components/SplitHandle.vue';
import { keepText, savedValue, usePersistedState } from '../composables/usePersistedState';
import { onHostMessage } from '../host';
import { useCollection } from './collection';
import DocumentList from './DocumentList.vue';
import DocumentsJson from './DocumentsJson.vue';
import { num, pageSizeChoices, plural, startPageSize, writesStage } from './format';
import ShellCode from './ShellCode.vue';
import { insertStage } from './shellSyntax';

/**
 * The Aggregation tab: a pipeline in shell syntax, buttons that add common stages, and the first documents it returns
 * as cards or one array. A write elsewhere runs the pipeline again when it is shown. A pipeline that writes ($out,
 * $merge) runs in the shell instead, which refuses it on read-only data sources and asks first on production ones.
 */
const props = defineProps<{ active: boolean }>();
const col = useCollection();
const s = col.state;

const STAGES: { name: string; text: string }[] = [
  { name: '$match', text: '{ $match: {} }' },
  { name: '$project', text: '{ $project: { _id: 1 } }' },
  { name: '$group', text: '{ $group: { _id: "$field", count: { $sum: 1 } } }' },
  { name: '$sort', text: '{ $sort: { _id: 1 } }' },
  { name: '$limit', text: '{ $limit: 20 }' },
  { name: '$unwind', text: '{ $unwind: "$field" }' },
  { name: '$lookup', text: '{ $lookup: { from: "collection", localField: "field", foreignField: "_id", as: "joined" } }' },
  { name: '$count', text: '{ $count: "count" }' },
];

const pipeline = ref('[\n  { $match: {} },\n  { $limit: 20 }\n]');
const startLimit = startPageSize(s.init!.pageSize);
const limits = pageSizeChoices(startLimit);
const limit = ref(startLimit);
const editor = ref<InstanceType<typeof ShellCode>>();

const DEFAULT_EDITOR_HEIGHT = 160;
const editorHeight = ref(DEFAULT_EDITOR_HEIGHT);
const maxEditorHeight = () => Math.max(120, window.innerHeight - 280);

const current = ref(0);
const loading = ref(false);
const error = ref<string | null>(null);
const documents = ref<MongoDocument[] | null>(null);
const durationMs = ref(0);
/** The pipeline and limit of the results on show. */
let ran: { pipeline: string; limit: number } | null = null;
let readVersion = -1;

type Mode = 'list' | 'json';
const mode = ref<Mode>('list');

const status = computed((): { text: string; tone: 'ok' | 'error' | 'muted' } | null => {
  if (error.value) return { text: error.value, tone: 'error' };
  if (loading.value && !documents.value) return { text: 'Running the pipeline…', tone: 'muted' };
  if (!documents.value) return null;
  const n = documents.value.length;
  const capped = n >= (ran?.limit ?? Infinity) ? ` (the first ${num(n)}, as the limit says)` : '';
  return { text: `${n ? plural(n, 'document') : 'No documents'}${capped} · ran in ${num(Math.round(durationMs.value))} ms`, tone: loading.value ? 'muted' : 'ok' };
});

const empty = computed(() => !pipeline.value.trim());
const writes = computed(() => writesStage(pipeline.value));
const runTitle = computed(() => {
  if (empty.value) return 'Write a pipeline to run';
  if (!writes.value) return `Run (${SUBMIT_KEY})`;
  if (s.init!.readOnly) return 'Pipelines with $out or $merge write data; the data source is read-only';
  return `Pipelines with $out or $merge write data, so they run in the shell (${SUBMIT_KEY})`;
});

function run(again = false): void {
  const text = again && ran ? ran.pipeline : pipeline.value;
  if (!text.trim()) return;
  if (!again && writesStage(text)) {
    if (s.init!.readOnly) return;
    // The shell may be in another database after `use`.
    if (s.shell.database !== s.init!.database) col.runShell(`use ${s.init!.database}`, true);
    col.runShell(`db.getCollection(${JSON.stringify(s.init!.collection)}).aggregate(${text.trim()})`, true);
    return;
  }
  ran = { pipeline: text, limit: again && ran ? ran.limit : limit.value };
  current.value = col.nextRequestId();
  loading.value = true;
  error.value = null;
  readVersion = s.documentsVersion;
  col.post({ type: 'aggregate', requestId: current.value, pipeline: ran.pipeline, limit: ran.limit });
}

function addStage(text: string): void {
  pipeline.value = insertStage(pipeline.value, text);
  const at = pipeline.value.lastIndexOf(text);
  void nextTick(() => editor.value?.focus(at < 0 ? undefined : at + text.length));
}

watch(
  () => [s.documentsVersion, props.active] as const,
  ([version, active]) => {
    if (active && ran && version !== readVersion && !writesStage(ran.pipeline)) run(true);
  },
);

/** A longer pipeline is not kept across reloads. */
const KEPT_PIPELINE = 100_000;
const ns = `${s.init!.database}.${s.init!.collection}`;

interface SavedAggregation {
  ns: string;
  pipeline?: string;
  limit?: number;
  mode?: Mode;
  editorHeight?: number;
}

/**
 * The pipeline, its limit, the result view and the editor height come back after a reload. The pipeline is not run
 * again: it may hold $out or $merge, and its results are never kept.
 */
const persisted = usePersistedState<SavedAggregation>('mongo.aggregation', {
  version: 1,
  value: () => ({ ns, pipeline: keepText(pipeline.value, KEPT_PIPELINE), limit: limit.value, mode: mode.value, editorHeight: editorHeight.value }),
  validate: (saved) => {
    const o = savedValue.object(saved);
    const name = savedValue.string(o?.ns);
    if (!o || name === undefined) return undefined;
    const kept = savedValue.integer(o.limit, 1);
    return {
      ns: name,
      pipeline: savedValue.string(o.pipeline, KEPT_PIPELINE),
      limit: kept !== undefined && limits.includes(kept) ? kept : undefined,
      mode: savedValue.oneOf(o.mode, ['list', 'json'] as const),
      editorHeight: savedValue.number(o.editorHeight),
    };
  },
});
const saved = persisted.restore();
if (saved?.ns === ns) {
  if (saved.pipeline !== undefined) pipeline.value = saved.pipeline;
  if (saved.limit !== undefined) limit.value = saved.limit;
  if (saved.mode) mode.value = saved.mode;
  if (saved.editorHeight !== undefined) editorHeight.value = Math.max(80, Math.min(saved.editorHeight, maxEditorHeight()));
}

const stop = onHostMessage<MongoCollectionHostMessage>((message) => {
  if ((message.type !== 'page' && message.type !== 'pageFailed') || message.requestId !== current.value) return;
  loading.value = false;
  if (message.type === 'pageFailed') {
    error.value = message.message;
    return;
  }
  documents.value = message.page.documents;
  durationMs.value = message.durationMs;
});
onUnmounted(stop);
</script>

<template>
  <div class="aggregation-tab">
    <div role="toolbar" aria-label="Pipeline" class="toolbar">
      <span class="caps">Add stage</span>
      <button v-for="st in STAGES" :key="st.name" type="button" class="btn xs mono stage" :title="`Add ${st.text}`" @click="addStage(st.text)">{{ st.name }}</button>
      <span class="spacer" />
      <label class="limit">
        Limit
        <select v-model.number="limit" class="sel" aria-label="Documents to return at most">
          <option v-for="n in limits" :key="n" :value="n">{{ n }}</option>
        </select>
      </label>
      <button
        type="button"
        class="btn sm"
        :disabled="empty"
        :title="empty ? 'Write a pipeline to explain' : 'Show how the server runs this pipeline'"
        @click="col.explain({ pipeline }, 'aggregate')"
      >
        Explain
      </button>
      <button type="button" class="btn sm btn-primary" :title="runTitle" :disabled="loading || empty || (writes && s.init!.readOnly)" @click="run()">
        <Icon name="run" :size="12" filled /> {{ writes ? 'Run in shell' : 'Run' }}
      </button>
    </div>
    <div class="editor" :style="{ height: `${editorHeight}px` }">
      <ShellCode ref="editor" v-model="pipeline" label="Aggregation pipeline in shell syntax" placeholder="[ { $match: {} } ]" @run="run()" />
    </div>
    <SplitHandle v-model="editorHeight" class="handle" label="Resize the pipeline editor" :min="80" :max="maxEditorHeight" :default-size="DEFAULT_EDITOR_HEIGHT" />
    <p v-if="status" class="message-line top" :class="status.tone" :role="status.tone === 'error' ? 'alert' : 'status'">
      <Icon v-if="status.tone === 'error'" name="error" :size="14" />{{ status.text }}
    </p>
    <div v-if="documents?.length" class="result-bar">
      <span class="caps">Results</span>
      <span class="spacer" />
      <div class="seg-group" role="group" aria-label="Show results as">
        <button type="button" class="seg" :aria-pressed="mode === 'list'" @click="mode = 'list'">List</button>
        <button type="button" class="seg" :aria-pressed="mode === 'json'" @click="mode = 'json'">JSON</button>
      </div>
    </div>
    <div class="results" :class="{ dim: loading, json: mode === 'json' }">
      <template v-if="documents?.length">
        <DocumentList v-if="mode === 'list'" :documents="documents" :picked="null" :actions="false" :pickable="false" @copy="col.copy($event.text, 'the document')" />
        <DocumentsJson v-else :documents="documents" />
      </template>
      <p v-else-if="!documents && !loading && !error" class="empty-state">
        Write a pipeline and run it with {{ SUBMIT_KEY }}. The buttons above add common stages at the end.
      </p>
    </div>
  </div>
</template>

<style scoped>
.aggregation-tab {
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
  gap: 6px;
  padding: 8px 12px;
}
.toolbar .caps {
  margin-right: 2px;
}
.stage {
  color: var(--vscode-charts-blue);
}
.spacer {
  flex: 1;
}
.limit {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--m-muted);
}
.editor {
  flex: none;
  box-sizing: border-box;
  margin: 0 12px;
  overflow: hidden;
  border: 1px solid var(--m-border);
  border-radius: 4px;
  background: var(--vscode-editor-background);
}
.handle {
  margin: 0 12px;
}
.message-line.top {
  border-top: 1px solid var(--m-border);
}
.result-bar {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--m-border);
}
.results {
  flex: 1;
  min-height: 0;
  overflow: auto;
}
.results.json {
  overflow: hidden;
}
.results.dim {
  opacity: 0.55;
}
</style>
