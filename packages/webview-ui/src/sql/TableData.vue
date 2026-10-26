<script setup lang="ts">
import type { TableDataHostMessage, TableDataInit } from '@datakit/core';
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue';
import Icon from '../components/Icon.vue';
import IconButton from '../components/IconButton.vue';
import ResizeHandle from '../components/ResizeHandle.vue';
import { onHostMessage } from '../host';
import ResultPanel from './ResultPanel.vue';
import ScriptEditor from './ScriptEditor.vue';
import StructureView from './StructureView.vue';
import { useSqlView } from './useSqlView';

/** The data view of a table: a SQL script whose last query fills the grid, and the Structure tab. */
const init = ref<TableDataInit | null>(null);
const initError = ref<string | null>(null);
const script = ref('');
const editor = ref<InstanceType<typeof ScriptEditor>>();
const view = useSqlView(init, editor, script);
const mode = ref<'data' | 'structure'>('data');
const applying = ref(false);
const alterError = ref<string | null>(null);

const DEFAULT_EDITOR_HEIGHT = 120;
const MIN_EDITOR_HEIGHT = 48;
const editorHeight = ref(DEFAULT_EDITOR_HEIGHT);
/** The editor may take the window's height except room for the toolbar and a few rows. */
const maxEditorHeight = () => window.innerHeight - 220;

const structure = computed(() => init.value?.structure ?? null);
const completion = computed(() => {
  const s = structure.value;
  return s ? { [s.table]: s.columns.map((c) => c.name) } : {};
});

const structureReadOnly = computed(() => {
  if (init.value?.readOnly) return 'The data source is read-only.';
  if (structure.value?.kind === 'materializedView') return 'Materialized views are changed by dropping and creating them again in the script.';
  return structure.value?.kind === 'view' ? 'Views are changed with CREATE OR REPLACE VIEW in the script.' : null;
});

function applyStructure(statements: string[]): void {
  applying.value = true;
  alterError.value = null;
  view.post({ type: 'alterTable', statements });
}

const stop = onHostMessage<TableDataHostMessage>((message) => {
  if (view.handle(message)) return;
  switch (message.type) {
    case 'init':
      init.value = message.init;
      view.autoCommit = message.init.autoCommit;
      script.value = message.init.script;
      editorHeight.value = Math.max(MIN_EDITOR_HEIGHT, Math.min(message.init.editorHeight ?? DEFAULT_EDITOR_HEIGHT, maxEditorHeight()));
      // The query the view opens with is not something the user ran, so it stays out of the history.
      void nextTick(() => view.run({ record: false }));
      break;
    case 'initFailed':
      initError.value = message.message;
      break;
    case 'structure':
      if (init.value) init.value = { ...init.value, structure: message.structure };
      applying.value = false;
      alterError.value = null;
      if (message.summary) view.showNotice(message.summary);
      break;
    case 'alterFailed':
      applying.value = false;
      alterError.value = message.message;
      break;
  }
});

function retry(): void {
  initError.value = null;
  view.post({ type: 'ready' });
}

onMounted(() => {
  view.post({ type: 'ready' });
  window.addEventListener('keydown', view.onKey);
});
onUnmounted(() => {
  stop();
  window.removeEventListener('keydown', view.onKey);
});
</script>

<template>
  <div v-if="initError" class="failed">
    <p role="alert"><Icon name="error" :size="14" /> {{ initError }}</p>
    <button type="button" class="btn" @click="retry">Retry</button>
  </div>
  <div v-else-if="!init || !structure" class="opening note">Opening table…</div>
  <div v-else class="table-data">
    <div class="top">
      <nav class="crumbs" aria-label="Location">
        <span>{{ init.dataSourceName }}</span><span aria-hidden="true">›</span><span>{{ structure.database }}</span
        ><template v-if="structure.schema"><span aria-hidden="true">›</span><span>{{ structure.schema }}</span></template
        ><span aria-hidden="true">›</span><span class="current">{{ structure.table }}</span>
      </nav>
      <span v-if="view.notice" role="status" class="notice">{{ view.notice }}</span>
      <div v-if="mode === 'data'" class="actions">
        <IconButton icon="run" label="Run (Ctrl+Enter) — the selection if there is one" filled tone="ok" :disabled="view.locked" @click="view.run()" />
        <IconButton icon="external" label="Open in query console" @click="view.post({ type: 'openConsole', script })" />
        <IconButton icon="copy" label="Copy SQL" @click="view.post({ type: 'copySql', sql: script })" />
      </div>
      <div role="group" aria-label="View" class="segments">
        <button type="button" :aria-pressed="mode === 'data'" @click="mode = 'data'">Data</button>
        <button type="button" :aria-pressed="mode === 'structure'" @click="mode = 'structure'">Structure</button>
      </div>
    </div>

    <section v-show="mode === 'data'" class="script" aria-label="SQL script" :style="{ height: `${editorHeight}px` }">
      <ScriptEditor ref="editor" v-model="script" :dialect="view.dialect" :schema="completion" :default-table="structure.table" @run="view.run()" />
    </section>
    <ResizeHandle
      v-show="mode === 'data'"
      v-model="editorHeight"
      class="script-resize"
      label="Resize the SQL editor"
      :min="MIN_EDITOR_HEIGHT"
      :max="maxEditorHeight"
      :default-height="DEFAULT_EDITOR_HEIGHT"
      @change="view.post({ type: 'editorHeight', height: $event })"
    />

    <ResultPanel v-if="mode === 'data'" :view="view" @goto="editor?.focusAt($event)" />

    <StructureView
      v-show="mode === 'structure'"
      :structure="structure"
      :read-only-reason="structureReadOnly"
      :tables="init.tables"
      :applying="applying"
      :error="alterError"
      @apply="applyStructure"
      @copy="view.post({ type: 'copySql', sql: $event })"
      @view-ddl="view.post({ type: 'viewDdl' })"
    />
  </div>
</template>

<style scoped>
.table-data {
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
.top {
  flex: none;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
  padding: 8px 12px 0;
}
.crumbs {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
}
.crumbs .current {
  color: var(--vscode-foreground);
}
.crumbs + .segments,
.crumbs + .notice {
  margin-left: auto;
}
.notice + .actions {
  margin-left: 0;
}
.actions {
  margin-left: auto;
  display: flex;
  gap: 2px;
}
.segments {
  display: flex;
  overflow: hidden;
  border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
  border-radius: 4px;
}
.segments button {
  height: 26px;
  padding: 0 12px;
  border: 0;
  background: var(--vscode-editorWidget-background);
  color: var(--vscode-foreground);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.segments button + button {
  border-left: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
}
.segments button[aria-pressed='true'] {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
}
.script {
  box-sizing: border-box;
  flex: none;
  overflow: hidden;
  margin: 8px 12px 0;
  border: 1px solid var(--vscode-panel-border);
  border-radius: 4px;
  background: var(--vscode-editor-background);
}
.script-resize {
  margin: 0 12px;
}
.notice {
  padding: 0 6px;
  font-size: 12px;
  color: var(--vscode-testing-iconPassed);
}
</style>
