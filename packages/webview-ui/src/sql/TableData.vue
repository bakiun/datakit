<script setup lang="ts">
import {
  changesData,
  draftOf,
  isPageableQuery,
  splitSqlScript,
  type SqlDialect,
  type StructureDraft,
  type TableDataHostMessage,
  type TableDataInit,
  type TableStructure,
} from '@datakit/core';
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue';
import ConfirmDialog from '../components/ConfirmDialog.vue';
import Icon from '../components/Icon.vue';
import IconButton from '../components/IconButton.vue';
import ResizeHandle from '../components/ResizeHandle.vue';
import { SUBMIT_KEY } from '../components/shortcuts';
import { fingerprint, keepText, savedValue, usePersistedState } from '../composables/usePersistedState';
import { onHostMessage } from '../host';
import ResultPanel from './ResultPanel.vue';
import ScriptEditor from './ScriptEditor.vue';
import StructureView from './StructureView.vue';
import { useSqlView } from './useSqlView';

/** The data view of a table: a SQL script whose last query fills the grid, and the Structure tab. */
const init = ref<TableDataInit | null>(null);
const initError = ref<string | null>(null);
/** The data source could not be connected to; the error offers its settings next to Retry. */
const initConnection = ref(false);
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

/**
 * What comes back after a reload of the page or the window: the script as edited, the cursor, the tab and the
 * Structure tab's unapplied draft. Grid edits are not kept: the rows are read again and may have changed.
 */
interface SavedView {
  /** The table the state belongs to. */
  table: string;
  /** Only when it differs from the script the view opens with. */
  script?: string;
  selection?: { anchor: number; head: number };
  mode: 'data' | 'structure';
  /** `base` fingerprints the table the draft was made on; a table changed since does not take it. */
  structure?: { base: string; draft: StructureDraft };
}
const MAX_SCRIPT = 100_000;
const tableKey = (s: TableStructure) => [s.database, s.schema ?? '', s.table].join('\n');
const selection = ref<{ anchor: number; head: number } | null>(null);
/** The Structure tab's draft while it has changes, and the one it starts with after a reload. */
const structureDraft = ref<StructureDraft | null>(null);
const restoredDraft = ref<StructureDraft | null>(null);
const structureBase = computed(() => (structure.value ? fingerprint(draftOf(structure.value)) : ''));
let restoredOnce = false;

const persisted = usePersistedState<SavedView>('tableData', {
  version: 1,
  value: () => {
    const s = structure.value;
    if (!init.value || !s) return undefined;
    const edited = script.value !== init.value.script ? keepText(script.value, MAX_SCRIPT) : undefined;
    return {
      table: tableKey(s),
      ...(edited !== undefined ? { script: edited } : {}),
      ...(selection.value && (selection.value.anchor || selection.value.head) ? { selection: selection.value } : {}),
      mode: mode.value,
      ...(structureDraft.value ? { structure: { base: structureBase.value, draft: structureDraft.value } } : {}),
    };
  },
  validate: (saved) => {
    const o = savedValue.object(saved);
    const table = savedValue.string(o?.table);
    if (!o || table === undefined) return undefined;
    const range = savedValue.object(o.selection);
    const anchor = savedValue.integer(range?.anchor);
    const head = savedValue.integer(range?.head);
    const draft = savedValue.object(o.structure);
    const base = savedValue.string(draft?.base);
    const value = savedValue.object(draft?.draft);
    const lists = value && ['columns', 'indexes', 'foreignKeys', 'checks'].every((k) => Array.isArray(value[k]));
    return {
      table,
      script: savedValue.string(o.script, MAX_SCRIPT),
      selection: anchor !== undefined && head !== undefined ? { anchor, head } : undefined,
      mode: savedValue.oneOf(o.mode, ['data', 'structure'] as const) ?? 'data',
      structure: base !== undefined && lists ? { base, draft: value as unknown as StructureDraft } : undefined,
    };
  },
});

/** Whether a restored script may run by itself: only queries that read, never one that writes. */
function onlyReads(text: string, dialect: SqlDialect): boolean {
  const parts = splitSqlScript(text, dialect);
  return parts.length > 0 && parts.every((p) => isPageableQuery(p.text, dialect) && !changesData(p.text, dialect));
}

/** Starts the view with a new init, and on the first one with what was kept before the reload, if it is this table's. */
function start(value: TableDataInit): void {
  const saved = restoredOnce ? undefined : persisted.restore();
  restoredOnce = true;
  const fits = saved && value.structure && saved.table === tableKey(value.structure) ? saved : undefined;
  script.value = fits?.script ?? value.script;
  if (fits) {
    mode.value = fits.mode;
    restoredDraft.value = fits.structure && value.structure && fits.structure.base === fingerprint(draftOf(value.structure)) ? fits.structure.draft : null;
  }
  void nextTick(() => {
    // The query the view opens with is not something the user ran, so it stays out of the history. A restored script
    // runs the same way only when all it does is read.
    if (!fits?.script || onlyReads(script.value, value.dialect)) view.run({ record: false });
    else view.showNotice('The script was restored but not run, as it changes data.');
    if (fits?.selection) editor.value?.setSelection(fits.selection.anchor, fits.selection.head);
  });
}

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

/** Why the Structure tab cannot end the open transaction now. */
const endBlocked = computed(() => (view.pending ? 'Submit or revert the grid changes on the Data tab first' : view.loading ? 'A query is running' : null));

/** ⌘Enter (Ctrl+Enter off macOS) runs or submits on the Data tab; the Structure tab applies with its button only. */
function onKey(event: KeyboardEvent): void {
  if (mode.value === 'data') view.onKey(event);
}

const stop = onHostMessage<TableDataHostMessage>((message) => {
  // A declined production confirmation of a structure change ends the wait for it too.
  if (message.type === 'declined') applying.value = false;
  if (view.handle(message)) return;
  switch (message.type) {
    case 'init':
      init.value = message.init;
      view.start(message.init);
      editorHeight.value = Math.max(MIN_EDITOR_HEIGHT, Math.min(message.init.editorHeight ?? DEFAULT_EDITOR_HEIGHT, maxEditorHeight()));
      start(message.init);
      break;
    case 'initFailed':
      initError.value = message.message;
      initConnection.value = message.connection === true;
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
  window.addEventListener('keydown', onKey);
});
onUnmounted(() => {
  stop();
  window.removeEventListener('keydown', onKey);
});
</script>

<template>
  <div v-if="initError" class="failed">
    <p role="alert"><Icon name="error" :size="14" /> {{ initError }}</p>
    <div class="failed-actions">
      <button type="button" class="btn btn-primary" @click="retry">Retry</button>
      <button v-if="initConnection" type="button" class="btn" @click="view.post({ type: 'editDataSource' })">Edit Data Source</button>
    </div>
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
        <IconButton icon="run" :label="`Run (${SUBMIT_KEY}) — the selection if there is one`" filled tone="ok" :disabled="view.busy" @click="view.run()" />
        <IconButton icon="external" label="Open in query console" @click="view.post({ type: 'openConsole', script })" />
        <IconButton icon="copy" label="Copy SQL" @click="view.post({ type: 'copySql', sql: script })" />
      </div>
      <div role="group" aria-label="View" class="segments">
        <button type="button" :aria-pressed="mode === 'data'" @click="mode = 'data'">Data</button>
        <button type="button" :aria-pressed="mode === 'structure'" @click="mode = 'structure'">Structure</button>
      </div>
    </div>

    <section v-show="mode === 'data'" class="script" aria-label="SQL script" :style="{ height: `${editorHeight}px` }">
      <ScriptEditor
        ref="editor"
        v-model="script"
        :dialect="view.dialect"
        :schema="completion"
        :default-table="structure.table"
        @run="view.run()"
        @select="selection = $event"
      />
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
      :open-transaction="view.transaction.open ? view.transaction.changes : null"
      :end-blocked="endBlocked"
      :initial-draft="restoredDraft"
      @draft="structureDraft = $event"
      @apply="applyStructure"
      @copy="view.post({ type: 'copySql', sql: $event })"
      @view-ddl="view.post({ type: 'viewDdl' })"
      @end-transaction="view.endTransaction"
    />

    <ConfirmDialog
      v-if="view.discardPrompt"
      title="Discard unsaved changes?"
      :text="view.discardPrompt.text"
      :primary="view.discardPrompt.primary"
      :action="view.discardAndProceed"
      @close="view.discardPrompt = null"
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
.failed-actions {
  display: flex;
  gap: 8px;
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
