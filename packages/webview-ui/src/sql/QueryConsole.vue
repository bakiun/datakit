<script setup lang="ts">
import {
  isExplainable,
  splitSqlScript,
  type LoadedPage,
  type LogLevel,
  type SqlDialect,
  type TableDataHostMessage,
  type TableDataInit,
} from '@datakit/core';
import { format, type SqlLanguage } from 'sql-formatter';
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import ConfirmDialog from '../components/ConfirmDialog.vue';
import Icon from '../components/Icon.vue';
import IconButton from '../components/IconButton.vue';
import ResizeHandle from '../components/ResizeHandle.vue';
import { SUBMIT_KEY } from '../components/shortcuts';
import { savedValue, usePersistedState } from '../composables/usePersistedState';
import { onHostMessage } from '../host';
import DataGrid from './DataGrid.vue';
import ResultPanel from './ResultPanel.vue';
import ScriptEditor from './ScriptEditor.vue';
import { existingRowId, useTableChanges, type RowId } from './tableChanges';
import { useSqlView } from './useSqlView';

/** A query console: a SQL script of a data source, run in the database picked above it. */
const init = ref<TableDataInit | null>(null);
const initError = ref<string | null>(null);
/** The data source could not be connected to; the error offers its settings next to Retry. */
const initConnection = ref(false);
const script = ref('');
const editor = ref<InstanceType<typeof ScriptEditor>>();
const view = useSqlView(init, editor, script);
const database = ref('');
/** PostgreSQL: the schema that comes first in the search path, and the schemas of the database. */
const schema = ref('');
const schemas = ref<string[] | null>(null);
const tables = ref<string[]>([]);
const tab = ref<'result' | 'messages' | 'plan'>('result');
/** PostgreSQL: EXPLAIN ANALYZE, which runs the statement in a transaction that is rolled back. */
const analyze = ref(false);
const FORMATTER_LANGUAGES: Record<SqlDialect, SqlLanguage> = { mysql: 'mysql', mariadb: 'mariadb', postgres: 'postgresql' };

interface LogEntry {
  time: string;
  level: LogLevel;
  text: string;
}
const messages = ref<LogEntry[]>([]);
/** Messages that came in while another tab was shown. */
const unseen = ref(0);

const plan = ref<LoadedPage | null>(null);
const planError = ref<string | null>(null);
/** Nothing to explain at the cursor: an empty state with the next step, not an error. */
const planHint = ref<string | null>(null);
const planLoading = ref(false);
const planChanges = useTableChanges(plan);
const planSelected = ref(new Set<RowId>());
const planRowIds = computed(() => plan.value?.rows.map((_, i) => existingRowId(i)) ?? []);
/** PostgreSQL's text plan is one indented line per row; it reads as text, not as a grid. */
const planText = computed(() => {
  const p = plan.value;
  if (!p || p.columns.length !== 1 || p.columns[0]!.name !== 'QUERY PLAN') return null;
  return p.rows.map((row) => String(row[0] ?? '')).join('\n');
});

const DEFAULT_EDITOR_HEIGHT = 220;
const MIN_EDITOR_HEIGHT = 48;
const editorHeight = ref(DEFAULT_EDITOR_HEIGHT);
const maxEditorHeight = () => window.innerHeight - 200;

const completion = computed(() => Object.fromEntries(tables.value.map((t) => [t, [] as string[]])));
/** A PostgreSQL console reconnects to change database, which an open transaction would not survive. */
const databaseLocked = computed(() =>
  view.dialect === 'postgres' && view.transaction.open ? 'Commit or roll back the open transaction to change the database' : null,
);
const resultCount = computed(() => (view.page ? (view.total ?? view.rowCount).toLocaleString('en-US') : ''));

/**
 * The cursor or selection comes back after a reload of the page or the window. The script itself is kept in the
 * console's file and the editor height in VS Code's state, so neither is kept here.
 */
const selection = ref<{ anchor: number; head: number } | null>(null);
let restoredOnce = false;
const persisted = usePersistedState<{ selection: { anchor: number; head: number } }>('queryConsole', {
  version: 1,
  value: () => (init.value && selection.value && (selection.value.anchor || selection.value.head) ? { selection: selection.value } : undefined),
  validate: (saved) => {
    const range = savedValue.object(savedValue.object(saved)?.selection);
    const anchor = savedValue.integer(range?.anchor);
    const head = savedValue.integer(range?.head);
    return anchor !== undefined && head !== undefined ? { selection: { anchor, head } } : undefined;
  },
});

/** The editor text is saved to the console's file; the text it opened with needs no save. */
let saved = '';
watch(script, (text) => {
  if (text === saved) return;
  saved = text;
  view.post({ type: 'script', script: text });
});

function useDatabase(event: Event): void {
  const name = (event.target as HTMLSelectElement).value;
  if (!name || name === database.value) return;
  database.value = name;
  view.post({ type: 'useDatabase', database: name });
}

function useSchema(event: Event): void {
  const name = (event.target as HTMLSelectElement).value;
  if (!name || name === schema.value) return;
  schema.value = name;
  view.post({ type: 'useSchema', schema: name });
}

/** Formats the selection, or the whole script, as one edit the user can undo. */
function formatSql(): void {
  if (!editor.value) return;
  const target = editor.value.selection() ?? { from: 0, text: script.value };
  if (!target.text.trim()) return;
  if (view.dialect !== 'postgres' && /^\s*DELIMITER\s/im.test(target.text)) {
    view.showNotice('Scripts with DELIMITER cannot be formatted; select the statements to format.');
    return;
  }
  try {
    const formatted = format(target.text, { language: FORMATTER_LANGUAGES[view.dialect], keywordCase: 'upper', tabWidth: 2 });
    editor.value.replace(target.from, target.from + target.text.length, formatted);
  } catch (error) {
    view.showNotice(`Could not format: ${(error as Error).message.split('\n')[0]}`);
  }
}

/** Explains the selected statement, or the one at the cursor, or else the last one EXPLAIN can describe. */
function explain(): void {
  const selected = editor.value?.selection();
  const explainable = (text: string) => isExplainable(text, view.dialect);
  let statement: string | undefined;
  if (selected && explainable(selected.text)) statement = selected.text.trim().replace(/;\s*$/, '');
  else {
    const parts = splitSqlScript(script.value, view.dialect);
    const cursor = editor.value?.cursor() ?? 0;
    const atCursor = parts.find((p) => cursor >= p.from && cursor <= p.to + 1);
    statement = (atCursor && explainable(atCursor.text) ? atCursor : [...parts].reverse().find((p) => explainable(p.text)))?.text;
  }
  if (!statement) {
    plan.value = null;
    planError.value = null;
    planHint.value = 'Put the cursor in a SELECT, UPDATE, DELETE or INSERT statement to see how the server runs it.';
    return;
  }
  planLoading.value = true;
  planError.value = null;
  planHint.value = null;
  view.post({ type: 'explain', statement, ...(view.dialect === 'postgres' ? { analyze: analyze.value } : {}) });
}

/** Adds a statement after the script, e.g. one picked from the query history, and puts the cursor on it. */
function append(text: string): void {
  if (!editor.value) return;
  const current = script.value;
  const gap = !current.trim() || current.endsWith('\n\n') ? '' : current.endsWith('\n') ? '\n' : '\n\n';
  const statement = /;\s*$/.test(text) ? text : `${text};`;
  editor.value.replace(current.length, current.length, gap + statement);
  editor.value.focusAt(current.length + gap.length);
}

function showTab(next: typeof tab.value): void {
  tab.value = next;
  if (next === 'messages') unseen.value = 0;
  if (next === 'plan') explain();
}

function addMessage(level: LogLevel, text: string): void {
  const time = new Date().toLocaleTimeString('en-GB', { hour12: false });
  messages.value = [...messages.value.slice(-499), { time, level, text }];
  if (tab.value !== 'messages') unseen.value++;
}

const stop = onHostMessage<TableDataHostMessage>((message) => {
  if (view.handle(message)) return;
  switch (message.type) {
    case 'init':
      init.value = message.init;
      view.start(message.init);
      saved = message.init.script;
      script.value = message.init.script;
      database.value = message.init.console?.database ?? '';
      schema.value = message.init.console?.schema ?? '';
      schemas.value = message.init.console?.schemas ?? null;
      tables.value = message.init.tables;
      editorHeight.value = Math.max(MIN_EDITOR_HEIGHT, Math.min(message.init.editorHeight ?? DEFAULT_EDITOR_HEIGHT, maxEditorHeight()));
      if (!restoredOnce) {
        restoredOnce = true;
        const range = persisted.restore()?.selection;
        if (range) void nextTick(() => editor.value?.setSelection(range.anchor, range.head));
      }
      break;
    case 'initFailed':
      initError.value = message.message;
      initConnection.value = message.connection === true;
      break;
    case 'database':
      database.value = message.database;
      tables.value = message.tables;
      if (message.schemas) {
        schema.value = message.schema ?? '';
        schemas.value = message.schemas;
      }
      break;
    case 'log':
      addMessage(message.level, message.text);
      break;
    case 'plan':
      planLoading.value = false;
      planError.value = null;
      plan.value = {
        statement: { text: message.statement, from: 0, to: 0 },
        columns: message.columns,
        rows: message.rows,
        total: message.rows.length,
        durationMs: 0,
        editable: null,
        readOnlyReason: null,
      };
      break;
    case 'planFailed':
      planLoading.value = false;
      plan.value = null;
      planError.value = message.message;
      break;
    case 'insertScript':
      append(message.text);
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
    <div class="failed-actions">
      <button type="button" class="btn btn-primary" @click="retry">Retry</button>
      <button v-if="initConnection" type="button" class="btn" @click="view.post({ type: 'editDataSource' })">Edit Data Source</button>
    </div>
  </div>
  <div v-else-if="!init?.console" class="opening note">Opening console…</div>
  <div v-else class="console">
    <div role="toolbar" aria-label="Query" class="bar">
      <IconButton icon="run" :label="`Run (${SUBMIT_KEY}) — the selection if there is one`" filled tone="ok" :disabled="view.busy" @click="view.run()" />
      <IconButton icon="stop" label="Stop query" tone="danger" :disabled="!view.loading" @click="view.post({ type: 'stop' })" />
      <span class="sep" />
      <label class="field">
        Source
        <span class="source">{{ init.dataSourceName }} /</span>
        <select
          class="sel"
          aria-label="Database"
          :title="databaseLocked ?? undefined"
          :value="database"
          :disabled="view.loading || !!databaseLocked"
          @change="useDatabase"
        >
          <option v-if="!database" value="" disabled>no database</option>
          <option v-for="name in init.console.databases" :key="name" :value="name">{{ name }}</option>
        </select>
        <template v-if="schemas">
          <span class="source">/</span>
          <select class="sel" aria-label="Schema" :value="schema" :disabled="view.loading" @change="useSchema">
            <option v-if="!schema" value="" disabled>no schema</option>
            <option v-for="name in schemas" :key="name" :value="name">{{ name }}</option>
          </select>
        </template>
      </label>
      <label class="field">
        Tx
        <select
          class="sel"
          aria-label="Transaction mode"
          :value="view.autoCommit ? 'auto' : 'manual'"
          :disabled="view.transaction.open"
          @change="view.setTx(($event.target as HTMLSelectElement).value === 'auto')"
        >
          <option value="auto">Auto</option>
          <option value="manual">Manual</option>
        </select>
      </label>
      <span v-if="view.notice" role="status" class="notice">{{ view.notice }}</span>
      <div class="right">
        <IconButton icon="format" label="Format SQL — the selection if there is one" @click="formatSql" />
        <IconButton icon="copy" label="Copy SQL" @click="view.post({ type: 'copySql', sql: script })" />
      </div>
    </div>

    <section class="script" aria-label="SQL script" :style="{ height: `${editorHeight}px` }">
      <ScriptEditor
        ref="editor"
        v-model="script"
        :dialect="view.dialect"
        :schema="completion"
        default-table=""
        @run="view.run()"
        @select="selection = $event"
      />
    </section>
    <ResizeHandle
      v-model="editorHeight"
      class="script-resize"
      label="Resize the SQL editor"
      :min="MIN_EDITOR_HEIGHT"
      :max="maxEditorHeight"
      :default-height="DEFAULT_EDITOR_HEIGHT"
      @change="view.post({ type: 'editorHeight', height: $event })"
    />

    <div role="tablist" aria-label="Results" class="tabs">
      <button role="tab" type="button" :aria-selected="tab === 'result'" @click="showTab('result')">
        Result <span class="count">{{ resultCount }}</span>
      </button>
      <button role="tab" type="button" :aria-selected="tab === 'messages'" @click="showTab('messages')">
        Messages <span class="count" :class="{ fresh: unseen }">{{ unseen || '' }}</span>
      </button>
      <button role="tab" type="button" :aria-selected="tab === 'plan'" @click="showTab('plan')">Execution plan</button>
    </div>

    <ResultPanel
      v-if="tab === 'result'"
      :view="view"
      :run-controls="false"
:empty-text="`Run a statement (${SUBMIT_KEY}) to see its result here.`"
      @goto="editor?.focusAt($event)"
    />

    <div v-else-if="tab === 'messages'" class="messages mono" role="log">
      <p v-if="!messages.length" class="empty">Nothing ran yet.</p>
      <div v-for="(m, i) in messages" :key="i" class="line" :class="m.level">
        <span class="time">[{{ m.time }}]</span> {{ m.text }}
      </div>
      <button v-if="messages.length" type="button" class="link clear" @click="messages = []">Clear</button>
    </div>

    <div v-else class="plan">
      <div class="plan-head">
        <span class="mono statement">{{ plan ? plan.statement.text : '' }}</span>
        <label
          v-if="view.dialect === 'postgres'"
          class="field analyze"
          title="EXPLAIN ANALYZE runs the statement to measure it, in a transaction that is rolled back afterwards"
        >
          <input v-model="analyze" type="checkbox" :disabled="planLoading" @change="explain" /> Analyze
        </label>
        <IconButton icon="reload" label="Explain again — the statement at the cursor" :disabled="planLoading" @click="explain" />
      </div>
      <p v-if="planError" class="plan-error" role="alert"><Icon name="error" :size="14" /> {{ planError }}</p>
      <p v-else-if="planHint" class="empty">{{ planHint }}</p>
      <pre v-else-if="planText !== null" class="grid-area plan-text mono" :class="{ dim: planLoading }">{{ planText }}</pre>
      <div v-else-if="plan" class="grid-area" :class="{ dim: planLoading }">
        <DataGrid
          v-model:selected="planSelected"
          :columns="plan.columns"
          :row-ids="planRowIds"
          :row-key="[]"
          :sort="[]"
          :changes="planChanges"
          :editable="false"
          :sortable="false"
        />
      </div>
      <p v-else class="empty">{{ planLoading ? 'Explaining…' : '' }}</p>
    </div>

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
.console {
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
.bar {
  flex: none;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--vscode-panel-border);
}
.field {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
}
.source {
  color: var(--vscode-foreground);
}
.sel {
  height: 26px;
  padding: 0 4px;
  border: 1px solid var(--vscode-dropdown-border, var(--vscode-panel-border));
  border-radius: 4px;
  background: var(--vscode-dropdown-background);
  color: var(--vscode-dropdown-foreground);
  font: inherit;
  font-size: 12px;
}
.sep {
  flex: none;
  width: 1px;
  height: 18px;
  background: var(--vscode-panel-border);
}
.notice {
  font-size: 12px;
  color: var(--vscode-testing-iconPassed);
}
.right {
  margin-left: auto;
  display: flex;
  gap: 2px;
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
.tabs {
  flex: none;
  display: flex;
  align-items: center;
  gap: 20px;
  padding: 0 16px;
  border-bottom: 1px solid var(--vscode-panel-border);
}
.tabs button {
  height: 32px;
  padding: 0;
  border: 0;
  background: none;
  color: var(--vscode-descriptionForeground);
  font: inherit;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  cursor: pointer;
}
.tabs button[aria-selected='true'] {
  color: var(--vscode-foreground);
  box-shadow: inset 0 -1px 0 var(--vscode-foreground);
}
.count {
  font-weight: 400;
}
.count.fresh {
  color: var(--vscode-editorWarning-foreground);
}
.messages {
  flex: 1;
  overflow: auto;
  padding: 12px 16px;
  font-size: 12px;
  line-height: 1.8;
}
.line.ok .time {
  color: var(--vscode-testing-iconPassed);
}
.line.warning .time {
  color: var(--vscode-editorWarning-foreground);
}
.line.error {
  color: var(--vscode-errorForeground);
}
.time {
  color: var(--vscode-descriptionForeground);
}
.link {
  padding: 0;
  border: 0;
  background: none;
  color: var(--vscode-textLink-foreground);
  font: inherit;
  cursor: pointer;
}
.clear {
  margin-top: 6px;
}
.plan {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: 8px 12px 10px;
  gap: 8px;
}
.plan-head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
}
.analyze {
  flex: none;
}
.statement {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
}
.plan-error {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  font-size: 12px;
  color: var(--vscode-errorForeground);
}
.grid-area {
  flex: 1;
  min-height: 0;
  overflow: auto;
  border: 1px solid var(--vscode-panel-border);
}
.grid-area.dim {
  opacity: 0.45;
}
.plan-text {
  margin: 0;
  padding: 8px 10px;
  font-size: 12px;
  line-height: 1.6;
  white-space: pre;
}
.empty {
  margin: 0;
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
}
</style>
