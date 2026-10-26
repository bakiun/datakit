<script lang="ts">
/** Run ids are unique for the whole page, so rows of an earlier run are never mixed in. */
let runSeq = 0;
</script>

<script setup lang="ts">
import type { KafkaWorkspaceHostMessage, KsqlColumn, KsqlResult } from '@datakit/core';
import { computed, onActivated, onDeactivated, onUnmounted, ref } from 'vue';
import Icon from '../components/Icon.vue';
import IconButton from '../components/IconButton.vue';
import { onHostMessage } from '../host';
import { formatElapsed, num, plural } from './format';
import { useWorkspace } from './workspace';

/**
 * A ksqlDB statement editor. Queries stream rows until they end or are stopped: Table shows the newest rows first,
 * Live appends them as they come, JSON shows one object per row. Other statements answer with JSON text.
 */
const ws = useWorkspace();
const s = ws.state;
/** Rows kept at most; older ones are dropped. */
const MAX_ROWS = 1000;
/** What a read-only data source may run. */
const READ_ONLY_STATEMENT = /^\s*(SELECT|SHOW|LIST|DESCRIBE|EXPLAIN|PRINT)\b/i;

type Mode = 'table' | 'json' | 'live';
const MODES: { id: Mode; label: string }[] = [
  { id: 'table', label: 'Table' },
  { id: 'json', label: 'JSON' },
  { id: 'live', label: 'Live' },
];

const statement = ref('SHOW STREAMS;');
const offsetReset = ref<'earliest' | 'latest'>('latest');
const mode = ref<Mode>('table');
const runId = ref(0);
const running = ref(false);
const startedAt = ref(0);
const now = ref(Date.now());
const columns = ref<KsqlColumn[]>([]);
const rows = ref<{ n: number; values: unknown[] }[]>([]);
const received = ref(0);
const result = ref<KsqlResult | null>(null);
const durationMs = ref(0);
const error = ref<string | null>(null);
const live = ref<HTMLElement>();
let clock: ReturnType<typeof setInterval> | undefined;

const blocked = computed(() => s.init!.readOnly && !READ_ONLY_STATEMENT.test(statement.value));
const push = computed(() => /\bEMIT\s+CHANGES\b/i.test(statement.value));
const tableRows = computed(() => [...rows.value].reverse());
const json = computed(() => rows.value.map((r) => JSON.stringify(Object.fromEntries(columns.value.map((c, i) => [c.name, r.values[i] ?? null])))).join('\n'));

const status = computed((): { text: string; error: boolean } => {
  if (error.value) return { text: error.value, error: true };
  if (running.value) return { text: `${plural(received.value, 'row')} · ${push.value ? 'push query' : 'query'} running ${formatElapsed(now.value - startedAt.value)}`, error: false };
  if (result.value?.kind === 'query') return { text: `${plural(result.value.rows, 'row')} · ${num(Math.round(durationMs.value))} ms`, error: false };
  if (result.value?.kind === 'statement') return { text: `Statement ran in ${num(Math.round(durationMs.value))} ms`, error: false };
  return { text: s.init!.readOnly ? 'Read-only: SELECT, SHOW, LIST, DESCRIBE, EXPLAIN and PRINT statements run.' : 'Ctrl+Enter runs the statement.', error: false };
});

function run(): void {
  if (blocked.value || !statement.value.trim()) return;
  if (running.value) stopRun();
  runId.value = ++runSeq;
  running.value = true;
  startedAt.value = Date.now();
  now.value = startedAt.value;
  columns.value = [];
  rows.value = [];
  received.value = 0;
  result.value = null;
  error.value = null;
  clearInterval(clock);
  clock = setInterval(() => (now.value = Date.now()), 1000);
  ws.post({ type: 'ksql', runId: runId.value, statement: statement.value, properties: { 'auto.offset.reset': offsetReset.value } });
}

function finish(): void {
  running.value = false;
  clearInterval(clock);
}

function stopRun(): void {
  if (!running.value) return;
  ws.post({ type: 'ksqlStop', runId: runId.value });
  finish();
  result.value = { kind: 'query', rows: received.value };
  durationMs.value = Date.now() - startedAt.value;
}

function onKey(event: KeyboardEvent): void {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    run();
  }
}

function cell(value: unknown): { text: string; kind: 'null' | 'num' | 'str' | 'other' } {
  if (value === null || value === undefined) return { text: 'null', kind: 'null' };
  if (typeof value === 'number' || typeof value === 'bigint') return { text: String(value), kind: 'num' };
  if (typeof value === 'string') return { text: value, kind: 'str' };
  return { text: JSON.stringify(value), kind: 'other' };
}

const stop = onHostMessage<KafkaWorkspaceHostMessage>((message) => {
  if (!('runId' in message) || message.runId !== runId.value) return;
  switch (message.type) {
    case 'ksqlColumns':
      columns.value = message.columns;
      break;
    case 'ksqlRows': {
      const start = received.value;
      received.value += message.rows.length;
      rows.value = [...rows.value, ...message.rows.map((values, i) => ({ n: start + i, values }))].slice(-MAX_ROWS);
      if (mode.value === 'live') requestAnimationFrame(() => live.value?.scrollTo({ top: live.value.scrollHeight }));
      break;
    }
    case 'ksqlDone':
      if (!running.value) break;
      finish();
      result.value = message.result;
      durationMs.value = message.durationMs;
      break;
    case 'ksqlFailed':
      finish();
      error.value = message.message;
      break;
  }
});

// Inside KeepAlive: this runs on the first mount too.
onActivated(() => ws.load('ksqlInfo'));
// A hidden page does not keep a push query running.
onDeactivated(stopRun);
onUnmounted(() => {
  stopRun();
  stop();
});
</script>

<template>
  <section class="page">
    <header class="page-head">
      <h1>ksqlDB</h1>
      <span class="note">
        {{ s.init!.ksqlDbUrl?.replace(/^https?:\/\//, '').replace(/\/$/, '') }}
        <template v-if="s.ksqlInfo"> · {{ plural(s.ksqlInfo.streams, 'stream') }} · {{ plural(s.ksqlInfo.tables, 'table') }} · {{ plural(s.ksqlInfo.queries, 'persistent query', 'persistent queries') }} · {{ s.ksqlInfo.version }}</template>
      </span>
      <div class="actions">
        <IconButton icon="reload" label="Read the ksqlDB server info again" :disabled="s.loading.ksqlInfo" @click="ws.load('ksqlInfo')" />
      </div>
    </header>
    <div class="page-body">
      <p v-if="s.errors.ksqlInfo" class="error-line" role="alert"><Icon name="error" :size="14" /> {{ s.errors.ksqlInfo }}</p>
      <div class="editor">
        <div class="editor-bar">
          <IconButton v-if="!running" icon="run" label="Run (Ctrl+Enter)" filled tone="ok" :disabled="blocked || !statement.trim()" @click="run" />
          <IconButton v-else icon="stop" label="Stop the query" tone="danger" @click="stopRun" />
          <label class="note reset">
            auto.offset.reset
            <select v-model="offsetReset" class="sel">
              <option value="earliest">earliest</option>
              <option value="latest">latest</option>
            </select>
          </label>
          <span v-if="blocked" class="t-warn note">Read-only data source: this statement could change the server.</span>
        </div>
        <textarea v-model="statement" class="mono statement" aria-label="ksqlDB statement" spellcheck="false" @keydown="onKey" />
      </div>
      <div class="result-bar">
        <div class="seg-group" role="group" aria-label="Result view">
          <button v-for="m in MODES" :key="m.id" type="button" class="seg" :aria-pressed="mode === m.id" @click="mode = m.id">{{ m.label }}</button>
        </div>
        <span class="status" :class="{ 't-error': status.error }" role="status">{{ status.text }}</span>
        <span v-if="received > rows.length" class="note">the newest {{ num(rows.length) }} rows are kept</span>
      </div>

      <pre v-if="result?.kind === 'statement'" class="mono out">{{ result.text }}</pre>
      <template v-else-if="columns.length">
        <pre v-if="mode === 'json'" class="mono out">{{ json || ' ' }}</pre>
        <div v-else ref="live" class="table-box rows" :class="{ live: mode === 'live' }">
          <table class="grid">
            <thead>
              <tr>
                <th v-for="c in columns" :key="c.name" scope="col" :title="c.type">{{ c.name }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in mode === 'live' ? rows : tableRows" :key="r.n" :class="{ fresh: mode === 'live' && r.n === received - 1 }">
                <td v-for="(c, i) in columns" :key="c.name" :class="{ num: cell(r.values[i]).kind === 'num', 'c-num': cell(r.values[i]).kind === 'num', 'c-str': cell(r.values[i]).kind === 'str', 't-muted': cell(r.values[i]).kind === 'null' }">
                  {{ cell(r.values[i]).text }}
                </td>
              </tr>
            </tbody>
          </table>
          <p v-if="!rows.length" class="empty-state">{{ running ? 'Waiting for rows…' : 'No rows.' }}</p>
        </div>
      </template>
    </div>
  </section>
</template>

<style scoped>
.page-body {
  gap: 10px;
}
.editor {
  flex: none;
  border: 1px solid var(--k-border);
  border-radius: 4px;
  background: var(--k-surface);
}
.editor:focus-within {
  border-color: var(--vscode-focusBorder);
}
.editor-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 10px;
  padding: 3px 6px;
  border-bottom: 1px solid var(--k-border);
}
.reset {
  display: flex;
  align-items: center;
  gap: 6px;
  font-family: var(--vscode-editor-font-family);
}
.statement {
  display: block;
  box-sizing: border-box;
  width: 100%;
  height: 110px;
  padding: 10px 12px;
  border: 0;
  outline: none;
  background: transparent;
  color: var(--vscode-editor-foreground);
  font-size: 13px;
  line-height: 1.6;
  resize: vertical;
}
.result-bar {
  flex: none;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 10px;
}
.status {
  font-size: 12px;
  color: var(--k-muted);
}
.out {
  flex: none;
  margin: 0;
  max-height: 480px;
  overflow: auto;
  padding: 10px 12px;
  border: 1px solid var(--k-border);
  border-radius: 4px;
  background: var(--k-surface);
  font-size: 12px;
  line-height: 1.6;
  color: var(--vscode-debugTokenExpression-string);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.rows {
  flex: 1 1 200px;
  min-height: 120px;
}
tr.fresh {
  background: color-mix(in srgb, var(--k-ok) 14%, transparent);
}
</style>
