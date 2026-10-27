<script setup lang="ts">
import {
  formatScanCommand,
  parseScanCommand,
  REDIS_KEY_TYPES,
  splitCommandLine,
  type RedisEdit,
  type RedisExportFormat,
  type RedisKeyDetail,
  type RedisKeyInfo,
  type RedisKeysHostMessage,
  type RedisKeysInit,
  type RedisKeysWebviewMessage,
  type RedisPageStart,
  type RedisText,
  type RedisValuePage,
  type ScanCommand,
  type StreamRow,
} from '@datakit/core';
import { computed, nextTick, onMounted, onUnmounted, ref, useTemplateRef } from 'vue';
import Icon from '../components/Icon.vue';
import IconButton from '../components/IconButton.vue';
import { onHostMessage, postToHost } from '../host';
import { describeValue, keyId, textOf } from './format';
import KeyHeader from './KeyHeader.vue';
import KeyList from './KeyList.vue';
import NewKeyForm from './NewKeyForm.vue';
import RedisCli, { type CliEntry } from './RedisCli.vue';
import StringValue from './StringValue.vue';
import ValueDetail from './ValueDetail.vue';
import ValueTable, { type CollectionType, type ValueRow } from './ValueTable.vue';

/**
 * The Redis key browser: the command at the top lists keys (SCAN or KEYS) on the left, the picked key's value is on
 * the right, a CLI is below. Other commands typed at the top run like CLI lines.
 */
const init = ref<RedisKeysInit | null>(null);
const initError = ref<string | null>(null);
const database = ref(0);
const databases = ref<{ index: number; keys: number }[]>([]);

const command = ref('');
/** The command line could not run; its border turns red until the next run. */
const commandInvalid = ref(false);
/** The SCAN behind the key list; “Load more” and refreshes repeat it. */
const listScan = ref<ScanCommand>({ cursor: '0', match: '*', count: null, type: null });
const commandHistory: string[] = [];
let historyAt = -1;
const keys = ref<RedisKeyInfo[]>([]);
const cursor = ref('0');
const total = ref(0);
const scanning = ref(false);
const scanError = ref<string | null>(null);

const selected = ref<RedisText | null>(null);
const detail = ref<RedisKeyDetail | null>(null);
const page = ref<RedisValuePage | null>(null);
const rows = ref<ValueRow[]>([]);
const next = ref<RedisPageStart>(null);
const active = ref(0);
const loadingKey = ref(false);
const keyError = ref<string | null>(null);

const creating = ref(false);
const writing = ref(false);
const writeError = ref<string | null>(null);
/** Why an edit was not written when the page could handle it, e.g. it read a changed list again. */
const writeNote = ref<string | null>(null);
let pendingEdit: RedisEdit | null = null;
/** An edit that met a changed value; it is offered again once the value has been read again. */
let retryAfterLoad: RedisEdit | null = null;
/** Show JSON as stored instead of indented; shared by the string editor and the item detail. */
const rawView = ref(false);

interface Restorable {
  restore(edit: RedisEdit): boolean;
}
const valueTable = useTemplateRef<Restorable>('valueTable');
const keyHeader = useTemplateRef<Restorable>('keyHeader');

const cli = ref<CliEntry[]>([]);
const cliBusy = ref(false);
/** The last message under the command line; it stays until the next one. */
const lastMessage = ref<{ text: string; error: boolean } | null>(null);
/** The key list came from a KEYS command, which the message about the result mentions. */
let listedByKeys = false;
/** A command from the top line that runs like a CLI line; its reply sets the message. */
let topLineRun: string | null = null;
/** A scan that keeps the message line, e.g. the refresh after a CLI write. */
let quietScan = false;

const post = (message: RedisKeysWebviewMessage) => postToHost(message);
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const sameKey = (a: RedisText | null, b: RedisText | null) => a !== null && b !== null && keyId(a) === keyId(b);

const collection = computed((): CollectionType | null => {
  const type = page.value?.type;
  return type === 'hash' || type === 'list' || type === 'set' || type === 'zset' || type === 'stream' ? type : null;
});
const readOnly = computed(() => !!init.value?.readOnly);
const prompt = computed(() => `${init.value?.dataSourceName ?? 'redis'}:${database.value}`);
const filtered = computed(() => listScan.value.match !== '*' || listScan.value.type !== null);
/** The fixed start of the listed pattern, e.g. `user:` for `user:*`, as the start of a new key's name. */
const newKeyPrefix = computed(() => {
  const match = listScan.value.match;
  const fixed = match.split(/[*?[\\]/)[0]!;
  return fixed === match ? '' : fixed;
});

/** The picked item of a collection for the detail panel. */
const activeItem = computed((): { label: string; value: RedisText } | null => {
  const row = rows.value[active.value];
  if (!row || !collection.value) return null;
  const r = row as unknown as Record<string, RedisText>;
  switch (collection.value) {
    case 'hash':
      return { label: `field ${textOf(r.field!)}`, value: r.value! };
    case 'list':
      return { label: `index ${String(r.index)}`, value: r.value! };
    case 'set':
      return { label: 'member', value: r.member! };
    case 'zset':
      return { label: `member · score ${String(r.score)}`, value: r.member! };
    case 'stream': {
      const s = row as StreamRow;
      return { label: `entry ${s.id}`, value: JSON.stringify(Object.fromEntries(s.fields.map(([f, v]) => [textOf(f), textOf(v)]))) };
    }
  }
});

function showMessage(text: string, error = false): void {
  lastMessage.value = { text, error };
}

/** Lists keys with the SCAN of the command; `more` continues from where the last round stopped. */
function scan(more = false): void {
  const s = listScan.value;
  scanning.value = true;
  scanError.value = null;
  post({ type: 'scan', match: s.match || '*', keyType: s.type, cursor: more ? cursor.value : s.cursor, count: s.count, append: more });
}

/** Lists every key again, without the pattern and type. */
function showAll(): void {
  listScan.value = { cursor: '0', match: '*', count: listScan.value.count, type: null };
  command.value = formatScanCommand(listScan.value);
  commandInvalid.value = false;
  listedByKeys = false;
  scan();
}

/** A server error of a top line command, with what to type instead when the command is unknown. */
function commandError(output: string): string {
  const text = output.replace(/^\(error\) /, '');
  const unknown = /^ERR unknown command '([^']*)'/i.exec(text);
  return unknown ? `Unknown command “${unknown[1]}”. Type a key pattern such as user:* to list keys, or a Redis command.` : text;
}

/** Runs the command at the top: a pattern, SCAN and KEYS fill the key list, anything else runs like a CLI line. */
function runCommand(): void {
  const line = command.value.trim();
  if (!line) {
    showAll();
    return;
  }
  if (commandHistory[0] !== line) commandHistory.unshift(line);
  historyAt = -1;
  const parsed = parseScanCommand(splitCommandLine(line));
  commandInvalid.value = false;
  if (parsed === null) {
    topLineRun = line;
    runCli(line);
    showMessage('Running…');
    return;
  }
  if (!parsed.ok) {
    commandInvalid.value = true;
    showMessage(parsed.error, true);
    return;
  }
  listedByKeys = parsed.fromKeys;
  listScan.value = parsed.scan;
  scan();
}

function onCommandKey(event: KeyboardEvent): void {
  if (event.key === 'Enter') runCommand();
  else if (event.key === 'ArrowUp' && commandHistory.length) {
    historyAt = Math.min(historyAt + 1, commandHistory.length - 1);
    command.value = commandHistory[historyAt]!;
    event.preventDefault();
  } else if (event.key === 'ArrowDown' && historyAt >= 0) {
    historyAt--;
    command.value = historyAt < 0 ? '' : commandHistory[historyAt]!;
    event.preventDefault();
  }
}

/** The type select writes TYPE into the command and lists again. */
function pickType(event: Event): void {
  const type = (event.target as HTMLSelectElement).value || null;
  const parsed = parseScanCommand(splitCommandLine(command.value));
  const base = parsed?.ok && !parsed.fromKeys ? parsed.scan : { ...listScan.value, cursor: '0' };
  listScan.value = { ...base, type };
  command.value = formatScanCommand(listScan.value);
  commandInvalid.value = false;
  listedByKeys = false;
  scan();
}

function pick(key: RedisText): void {
  selected.value = key;
  creating.value = false;
  loadingKey.value = true;
  keyError.value = null;
  writeError.value = null;
  writeNote.value = null;
  retryAfterLoad = null;
  post({ type: 'open', key: clone(key) });
}

function refresh(): void {
  scan();
  if (selected.value !== null) pick(selected.value);
}

function edit(change: RedisEdit): void {
  writing.value = true;
  writeError.value = null;
  writeNote.value = null;
  pendingEdit = change;
  post({ type: 'edit', edit: clone(change) });
}

function dismissWriteMessage(): void {
  writeError.value = null;
  writeNote.value = null;
}

/** Opens an edit that was not written again where it was made, so nothing typed is lost. */
function restore(change: RedisEdit): boolean {
  if (!('key' in change) || !sameKey(change.key, selected.value)) return false;
  return !!(valueTable.value?.restore(change) || keyHeader.value?.restore(change));
}

/** After the value was read again because it had changed: offers the edit on the current value. */
function retryOnCurrent(change: RedisEdit, reason: string): void {
  void nextTick(() => {
    const removal = change.kind.endsWith('Delete');
    if (!restore(change)) writeNote.value = `${reason} It shows the current value now; the item could not be found again.`;
    else if (removal) writeNote.value = `${reason} It shows the current value now, with the items selected again.`;
    else writeNote.value = `${reason} It shows the current value now, with your edit kept: press Enter to write it, or Esc to drop it.`;
  });
}

function moreValue(): void {
  if (selected.value === null || next.value === null) return;
  loadingKey.value = true;
  post({ type: 'more', key: clone(selected.value), start: next.value });
}

function exportValue(format: RedisExportFormat): void {
  if (selected.value !== null) post({ type: 'export', key: clone(selected.value), format });
}

function runCli(line: string): void {
  cliBusy.value = true;
  post({ type: 'cli', line });
}

function selectDatabase(event: Event): void {
  post({ type: 'select', database: Number((event.target as HTMLSelectElement).value) });
}

function startCreate(): void {
  creating.value = true;
  writeError.value = null;
}

/** Keeps the key list in step with an edit that was written; after a deletion the next key is shown. */
function applyToList(change: RedisEdit): void {
  if (change.kind === 'renameKey') {
    keys.value = keys.value.map((k) => (sameKey(k.key, change.key) ? { ...k, key: change.to } : k));
    selected.value = change.to;
  } else if (change.kind === 'deleteKeys') {
    const at = keys.value.findIndex((k) => sameKey(k.key, selected.value));
    keys.value = keys.value.filter((k) => !change.keys.some((gone) => sameKey(gone, k.key)));
    total.value = Math.max(0, total.value - change.keys.length);
    selected.value = null;
    detail.value = null;
    page.value = null;
    const next = at < 0 ? undefined : keys.value[Math.min(at, keys.value.length - 1)];
    if (next) pick(next.key);
  } else if (change.kind === 'createKey') {
    keys.value = [{ key: change.key, type: change.type, ttl: change.ttl }, ...keys.value.filter((k) => !sameKey(k.key, change.key))];
    total.value++;
    selected.value = change.key;
    creating.value = false;
  }
}

const stop = onHostMessage<RedisKeysHostMessage>((message) => {
  switch (message.type) {
    case 'init':
      init.value = message.init;
      database.value = message.init.database;
      databases.value = message.init.databases;
      // Opens on the pattern and type used last time on this data source.
      listScan.value = { ...(message.init.lastScan ?? { match: '*', type: null, count: null }), cursor: '0' };
      listScan.value.count ??= message.init.scanCount;
      command.value = formatScanCommand(listScan.value);
      scan();
      break;
    case 'initFailed':
      initError.value = message.message;
      break;
    case 'keys':
      keys.value = message.append ? [...keys.value, ...message.keys.filter((k) => !keys.value.some((s) => sameKey(s.key, k.key)))] : message.keys;
      cursor.value = message.cursor;
      total.value = message.total;
      scanning.value = false;
      if (!quietScan)
        showMessage(
          `${keys.value.length.toLocaleString('en-US')} key${keys.value.length === 1 ? '' : 's'} found · ${message.cursor === '0' ? 'scan finished' : 'more to scan'}` +
            (listedByKeys ? ' · KEYS ran as SCAN, so a large database is not blocked' : ''),
        );
      quietScan = false;
      if (selected.value === null && !creating.value && keys.value[0]) pick(keys.value[0].key);
      break;
    case 'keysFailed':
      scanning.value = false;
      quietScan = false;
      scanError.value = message.message;
      break;
    case 'key': {
      if (!sameKey(message.detail.key, selected.value)) break;
      detail.value = message.detail;
      const p = message.page;
      if (!message.append) {
        page.value = p;
        rows.value = 'rows' in p ? (p.rows as ValueRow[]) : [];
        // Like the design: the detail starts on the first item that holds JSON.
        active.value = Math.max(0, rows.value.findIndex((r) => 'value' in r && describeValue(r.value).json !== undefined));
      } else if ('rows' in p) {
        rows.value = [...rows.value, ...(p.rows as ValueRow[])];
      }
      next.value = 'next' in p ? p.next : null;
      loadingKey.value = false;
      keys.value = keys.value.map((k) => (sameKey(k.key, message.detail.key) ? { key: k.key, type: message.detail.type, ttl: message.detail.ttl } : k));
      if (retryAfterLoad && !message.append) {
        retryOnCurrent(retryAfterLoad, writeNote.value ?? '');
        retryAfterLoad = null;
      }
      break;
    }
    case 'keyGone':
      keys.value = keys.value.filter((k) => !sameKey(k.key, message.key));
      if (sameKey(selected.value, message.key)) {
        selected.value = null;
        detail.value = null;
        page.value = null;
      }
      loadingKey.value = false;
      showMessage('The key no longer exists.');
      break;
    case 'keyFailed':
      loadingKey.value = false;
      keyError.value = message.message;
      break;
    case 'written':
      writing.value = false;
      writeNote.value = null;
      for (const command of message.commands) cli.value.push({ line: command, output: message.summary, ok: true, echo: true, durationMs: null });
      if (pendingEdit) applyToList(pendingEdit);
      pendingEdit = null;
      break;
    case 'writeFailed': {
      writing.value = false;
      const failed = pendingEdit;
      pendingEdit = null;
      if (message.reason === 'stale' && failed && 'key' in failed && sameKey(failed.key, selected.value)) {
        // The item changed since it was loaded: read the value again, then offer the edit on what is there now.
        writeNote.value = message.message;
        retryAfterLoad = failed;
        loadingKey.value = true;
        post({ type: 'open', key: clone(selected.value!) });
        break;
      }
      // A declined confirmation needs no message; what was typed comes back either way.
      if (message.reason !== 'cancelled') writeError.value = message.message;
      if (failed) void nextTick(() => restore(failed));
      break;
    }
    case 'database':
      database.value = message.database;
      databases.value = message.databases;
      selected.value = null;
      detail.value = null;
      page.value = null;
      scan();
      break;
    case 'cli':
      cliBusy.value = false;
      cli.value.push({ line: message.line, output: message.output, ok: message.ok, echo: false, durationMs: message.durationMs });
      if (topLineRun === message.line) {
        topLineRun = null;
        commandInvalid.value = !message.ok;
        if (message.ok) showMessage(`Ran in ${message.durationMs.toFixed(1)} ms · the reply is in the CLI below.`);
        else showMessage(commandError(message.output), true);
      }
      if (message.wrote && selected.value !== null) pick(selected.value);
      // A list that was read to its end is small, so it is read again to show keys the command added or removed.
      if (message.wrote && !scanning.value && cursor.value === '0' && listScan.value.cursor === '0') {
        quietScan = true;
        scan();
      }
      break;
    case 'notice':
      showMessage(message.message, !!message.error);
      break;
  }
});

function retry(): void {
  initError.value = null;
  post({ type: 'ready' });
}

onMounted(() => post({ type: 'ready' }));
onUnmounted(stop);
</script>

<template>
  <div v-if="initError" class="failed">
    <p role="alert"><Icon name="error" :size="14" /> {{ initError }}</p>
    <button type="button" class="btn" @click="retry">Retry</button>
  </div>
  <div v-else-if="!init" class="opening note">Opening key browser…</div>
  <div v-else class="redis-keys">
    <div role="toolbar" aria-label="Keys" class="toolbar">
      <label class="match" :class="{ invalid: commandInvalid }">
        <span class="match-label">Command</span>
        <input
          v-model="command"
          class="mono"
          aria-label="Command: a key pattern, SCAN or KEYS lists the keys, other commands run like the CLI"
          placeholder="user:* or SCAN 0 MATCH user:* COUNT 500"
          spellcheck="false"
          autocomplete="off"
          @keydown="onCommandKey"
        />
      </label>
      <IconButton icon="run" label="Run (Enter) — a key pattern, SCAN or KEYS lists keys; other commands answer in the CLI" filled tone="ok" @click="runCommand" />
      <select class="sel" aria-label="Key type" :value="listScan.type ?? ''" @change="pickType">
        <option value="">All types</option>
        <option v-for="t in REDIS_KEY_TYPES" :key="t" :value="t">{{ t }}</option>
      </select>
      <select class="sel" aria-label="Database" :value="database" @change="selectDatabase">
        <option v-for="d in databases" :key="d.index" :value="d.index">db{{ d.index }} · {{ d.keys.toLocaleString('en-US') }} keys</option>
      </select>
      <IconButton icon="reload" label="Scan again" :disabled="scanning" @click="refresh" />
      <button type="button" class="btn btn-primary new" :disabled="readOnly" :title="readOnly ? 'The data source is read-only' : undefined" @click="startCreate">
        <Icon name="plus" :size="14" /> New key
      </button>
    </div>

    <!-- Shows the last message until the next one replaces it, so the line never comes and goes. -->
    <p v-if="lastMessage" class="command-message" :class="{ error: lastMessage.error }" :role="lastMessage.error ? 'alert' : 'status'">
      <Icon v-if="lastMessage.error" name="error" :size="14" /> {{ lastMessage.text }}
    </p>

    <div class="body">
      <aside class="keys">
        <KeyList
          :keys="keys"
          :selected="selected"
          :total="total"
          :cursor="cursor"
          :scanning="scanning"
          :error="scanError"
          :filtered="filtered"
          :can-create="!readOnly"
          @pick="pick"
          @more="scan(true)"
          @retry="scan()"
          @show-all="showAll"
          @create="startCreate"
        />
      </aside>
      <main class="value">
        <NewKeyForm v-if="creating" :busy="writing" :error="writeError" :prefix="newKeyPrefix" @create="edit" @cancel="creating = false" />
        <p v-else-if="keyError" class="message error" role="alert">
          <Icon name="error" :size="14" /> {{ keyError }}
          <button v-if="selected !== null" type="button" class="link" @click="pick(selected)">Try again</button>
        </p>
        <template v-else-if="detail && page && selected !== null">
          <KeyHeader ref="keyHeader" :detail="detail" :read-only="readOnly" @edit="edit" @dismiss="dismissWriteMessage" />
          <p v-if="writeError" class="message error" role="alert"><Icon name="error" :size="14" /> Not written: {{ writeError }}</p>
          <p v-else-if="writeNote" class="message note" role="status"><Icon name="info" :size="14" /> {{ writeNote }}</p>
          <StringValue
            v-if="page.type === 'string'"
            v-model:raw="rawView"
            :detail="detail"
            :value="page.value"
            :truncated="page.truncated"
            :read-only="readOnly"
            :keep-ttl="init.keepTtl"
            :busy="writing"
            @edit="edit"
          />
          <template v-else-if="collection">
            <ValueTable
              ref="valueTable"
              v-model:active="active"
              :key-name="selected"
              :type="collection"
              :rows="rows"
              :length="detail.length"
              :has-more="next !== null"
              :field-ttl="init.fieldTtl"
              :read-only="readOnly"
              :busy="writing || loadingKey"
              @edit="edit"
              @dismiss="dismissWriteMessage"
              @more="moreValue"
              @reload="pick(selected)"
              @export="exportValue"
            />
            <ValueDetail v-if="activeItem" v-model:raw="rawView" :label="activeItem.label" :value="activeItem.value" @copy="post({ type: 'copy', text: $event })" />
          </template>
          <p v-else-if="page.type === 'other'" class="message">{{ page.message }}</p>
        </template>
        <p v-else-if="loadingKey" class="message">Loading…</p>
        <p v-else-if="keys.length" class="message">Pick a key to see its value.</p>
        <p v-else-if="!scanning" class="message">
          No key to show.
          <button v-if="!readOnly" type="button" class="link" @click="startCreate">Create a key</button>
        </p>
      </main>
    </div>

    <RedisCli :prompt="prompt" :entries="cli" :busy="cliBusy" @run="runCli" />
  </div>
</template>

<style scoped>
.redis-keys {
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
.toolbar {
  flex: none;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--vscode-panel-border);
}
.match {
  flex: 1 1 260px;
  display: flex;
  align-items: center;
  gap: 8px;
  height: 28px;
  padding: 0 8px;
  border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
  border-radius: 4px;
  background: var(--vscode-input-background);
}
.match:focus-within {
  border-color: var(--vscode-focusBorder);
}
.match.invalid {
  border-color: var(--vscode-inputValidation-errorBorder);
}
/* Under the command line: what the last command or action did, or why it could not run. */
.command-message {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  padding: 6px 12px;
  border-bottom: 1px solid var(--vscode-panel-border);
  font-size: 12px;
  color: var(--vscode-testing-iconPassed);
}
.command-message.error {
  color: var(--vscode-errorForeground);
}
.match-label {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--vscode-charts-purple);
}
.match input {
  flex: 1;
  min-width: 0;
  border: 0;
  outline: none;
  background: transparent;
  color: var(--vscode-input-foreground);
}
.sel {
  height: 28px;
  padding: 0 4px;
  border: 1px solid var(--vscode-dropdown-border, var(--vscode-panel-border));
  border-radius: 4px;
  background: var(--vscode-dropdown-background);
  color: var(--vscode-dropdown-foreground);
  font: inherit;
  font-size: 12px;
}
.new {
  height: 28px;
}
.body {
  flex: 1;
  min-height: 0;
  display: flex;
}
.keys {
  flex: 0 0 300px;
  min-width: 0;
  border-right: 1px solid var(--vscode-panel-border);
}
.value {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  padding-bottom: 8px;
}
.message {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 12px;
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
}
.message.error {
  color: var(--vscode-errorForeground);
}
.message.note {
  color: var(--vscode-foreground);
}
.link {
  padding: 0;
  border: 0;
  background: none;
  color: var(--vscode-textLink-foreground);
  font: inherit;
  cursor: pointer;
}
.link:hover {
  color: var(--vscode-textLink-activeForeground);
  text-decoration: underline;
}
</style>
