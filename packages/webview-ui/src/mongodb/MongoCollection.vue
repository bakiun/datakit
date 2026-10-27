<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import Icon from '../components/Icon.vue';
import IconButton from '../components/IconButton.vue';
import SplitHandle from '../components/SplitHandle.vue';
import ToastNote from '../components/ToastNote.vue';
import AggregationTab from './AggregationTab.vue';
import { createCollection, provideCollection, type Tab } from './collection';
import DocumentsTab from './DocumentsTab.vue';
import ExplainDialog from './ExplainDialog.vue';
import { formatBytes, plural } from './format';
import IndexesTab from './IndexesTab.vue';
import MongoShell from './MongoShell.vue';
import SchemaTab from './SchemaTab.vue';
import ShellText from './ShellText.vue';
import './mongo.css';

/**
 * One MongoDB collection in an editor tab: its documents, aggregation, indexes and schema, with a shell below.
 * Views have no Indexes tab and no writes; read-only data sources show no write controls.
 */
const col = createCollection();
provideCollection(col);
const s = col.state;

const tabs = computed((): { id: Tab; label: string }[] => [
  { id: 'documents', label: 'Documents' },
  { id: 'aggregation', label: 'Aggregation' },
  ...(s.init?.type === 'view' ? [] : [{ id: 'indexes' as const, label: 'Indexes' }]),
  { id: 'schema', label: 'Schema' },
]);
/** Tabs are created when first shown and kept, so their query and results stay when another tab is open. */
const visited = ref(new Set<Tab>(['documents']));
watch(
  () => s.tab,
  (tab) => (visited.value = new Set([...visited.value, tab])),
);

const facts = computed(() => {
  const info = s.info;
  if (!info) return '';
  const parts: string[] = [];
  if (info.documents !== null) parts.push(plural(info.documents, 'document'));
  if (info.bytes !== null) parts.push(formatBytes(info.bytes));
  return parts.join(' · ');
});
const typeChip = computed(() => {
  const info = s.info;
  if (info?.type === 'view') return { label: 'VIEW', tone: 'tone-info', title: 'A read-only view defined by a pipeline' };
  if (info?.type === 'timeseries') return { label: 'TIME SERIES', tone: 'tone-info', title: 'A time series collection' };
  if (info?.capped) return { label: 'CAPPED', tone: 'tone-warn', title: 'A capped collection: the oldest documents go when it is full' };
  return null;
});
const showPipeline = ref(false);

const DEFAULT_SHELL_HEIGHT = 200;
const shellHeight = ref(DEFAULT_SHELL_HEIGHT);
const maxShellHeight = () => Math.max(120, window.innerHeight - 220);

function retry(): void {
  s.initError = null;
  col.post({ type: 'ready' });
}

onMounted(() => col.post({ type: 'ready' }));
onUnmounted(col.stop);
</script>

<template>
  <div v-if="s.initError" class="failed">
    <p role="alert"><Icon name="error" :size="14" /> {{ s.initError }}</p>
    <button type="button" class="btn" @click="retry">Retry</button>
  </div>
  <div v-else-if="!s.init" class="opening note">Opening collection…</div>
  <div v-else class="mongo-collection">
    <header class="head">
      <div class="title">
        <Icon name="mongodb" :size="18" class="logo" />
        <h1 class="mono" :title="`${s.init.database}.${s.init.collection}`"><span class="db">{{ s.init.database }}.</span>{{ s.init.collection }}</h1>
        <span v-if="typeChip" class="chip" :class="typeChip.tone" :title="typeChip.title">{{ typeChip.label }}</span>
        <span class="note facts">{{ facts }}</span>
        <IconButton icon="reload" label="Read the counts and sizes again" class="small" :disabled="s.loading.info" @click="col.load('info')" />
      </div>
      <div class="server">
        <span class="note" :title="`${s.init.serverLabel} · ${s.init.topology}`">{{ s.init.dataSourceName }} · {{ s.init.serverLabel }} · {{ s.init.topology }}</span>
        <span v-if="s.init.environment === 'production'" class="chip tone-error" title="Changes ask again in VS Code before they run">Production</span>
      </div>
    </header>
    <p v-if="s.errors.info" class="error-line banner" role="alert"><Icon name="error" :size="14" /> Counts and sizes could not be read: {{ s.errors.info }}</p>
    <div v-if="s.info?.type === 'view'" class="banner view-note">
      <span>
        Views are read-only. This view runs a pipeline on <span class="mono source">{{ s.info.viewOn ?? '?' }}</span>.
      </span>
      <button v-if="s.info.pipeline" type="button" class="lnk" :aria-expanded="showPipeline" @click="showPipeline = !showPipeline">
        {{ showPipeline ? 'Hide pipeline' : 'Show pipeline' }}
      </button>
    </div>
    <pre v-if="showPipeline && s.info?.pipeline" class="pipeline"><ShellText :text="s.info.pipeline" /></pre>
    <p v-if="s.init.readOnly && s.init.type !== 'view'" class="banner read-only">{{ col.readOnlyReason.value }}</p>

    <nav role="tablist" aria-label="Collection" class="tabs">
      <button v-for="t in tabs" :key="t.id" type="button" role="tab" class="tab" :aria-selected="s.tab === t.id" @click="s.tab = t.id">{{ t.label }}</button>
    </nav>

    <main class="body">
      <DocumentsTab v-show="s.tab === 'documents'" :active="s.tab === 'documents'" />
      <AggregationTab v-if="visited.has('aggregation')" v-show="s.tab === 'aggregation'" :active="s.tab === 'aggregation'" />
      <IndexesTab v-if="visited.has('indexes') && s.init.type !== 'view'" v-show="s.tab === 'indexes'" :active="s.tab === 'indexes'" />
      <SchemaTab v-if="visited.has('schema')" v-show="s.tab === 'schema'" :active="s.tab === 'schema'" />
    </main>

    <SplitHandle
      v-if="s.shell.open"
      v-model="shellHeight"
      after
      label="Resize the shell"
      :min="80"
      :max="maxShellHeight"
      :default-size="DEFAULT_SHELL_HEIGHT"
    />
    <MongoShell
      v-model:open="s.shell.open"
      :style="s.shell.open ? { height: `${shellHeight}px` } : undefined"
      :entries="s.shell.entries"
      :busy="s.shell.busy"
      :running="s.shell.running"
      :database="s.shell.database"
      :collection="s.init.collection"
      @run="col.runShell"
      @clear="s.shell.entries = []"
    />

    <ExplainDialog v-if="s.explain" :view="s.explain" @close="s.explain = null" />
    <ToastNote :toast="s.toast" @dismiss="s.toast = null" />
  </div>
</template>

<style scoped>
.mongo-collection {
  height: 100vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.opening,
.failed {
  padding: 24px 28px;
}
.failed p {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--vscode-errorForeground);
}
.head {
  flex: none;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 16px;
  padding: 10px 12px 6px;
}
.title {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 10px;
  min-width: 0;
}
.logo {
  color: var(--vscode-charts-green, var(--vscode-testing-iconPassed));
}
h1 {
  margin: 0;
  min-width: 0;
  overflow: hidden;
  font-size: 15px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.db {
  font-weight: 400;
  color: var(--m-muted);
}
.small {
  width: 24px;
  height: 24px;
}
.server {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.server .note {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.banner {
  flex: none;
  margin: 0 12px 6px;
  font-size: 12px;
}
.view-note,
.read-only {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 12px;
  padding: 6px 10px;
  border: 1px solid color-mix(in srgb, var(--m-info) 40%, transparent);
  border-radius: 4px;
  background: color-mix(in srgb, var(--m-info) 8%, transparent);
}
.view-note .lnk {
  font-size: 12px;
}
.source {
  color: var(--vscode-foreground);
}
.pipeline {
  flex: none;
  max-height: 160px;
  margin: 0 12px 8px;
  overflow: auto;
  padding: 8px 10px;
  border: 1px solid var(--m-border);
  border-radius: 4px;
  background: var(--vscode-editor-background);
  font-size: 12px;
}
.tabs {
  flex: none;
  display: flex;
  gap: 20px;
  padding: 0 12px;
  overflow-x: auto;
  border-bottom: 1px solid var(--m-border);
}
.tab {
  flex: none;
  height: 32px;
  padding: 0 2px;
  border: 0;
  background: transparent;
  color: var(--vscode-panelTitle-inactiveForeground, var(--m-muted));
  font: inherit;
  cursor: pointer;
}
.tab[aria-selected='true'] {
  color: var(--vscode-panelTitle-activeForeground, var(--vscode-foreground));
  box-shadow: inset 0 -2px 0 var(--vscode-panelTitle-activeBorder, var(--vscode-focusBorder));
}
.tab:focus-visible {
  outline: 1px solid var(--vscode-focusBorder);
}
.body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
</style>
