<script lang="ts">
/** Request ids are unique for the whole page, so an answer meant for an earlier topic view is dropped too. */
let requestSeq = 0;
</script>

<script setup lang="ts">
import type { KafkaMessage, KafkaMessagePage, KafkaPositions, KafkaTopicDetail, KafkaWorkspaceHostMessage } from '@datakit/core';
import { compareOffsets } from '@datakit/core';
import { computed, nextTick, onUnmounted, ref, watch } from 'vue';
import Icon from '../components/Icon.vue';
import IconButton from '../components/IconButton.vue';
import { onHostMessage } from '../host';
import { formatTime, messageId, messageJson, num, offsetText, payloadPreview, plural } from './format';
import MessagePane from './MessagePane.vue';
import { buildMessageQuery, FILTER_KINDS, filterKind, type FilterType, type MessageFilter } from './messageQuery';
import { useWorkspace } from './workspace';

/**
 * The messages of a topic, newest first, narrowed by filter chips. Stream adds new messages at the top as they
 * arrive; the picked message is shown in full below the table. The page size is remembered for the data source, the
 * filters for the topic while the workspace is open.
 */
const props = defineProps<{ topic: KafkaTopicDetail }>();
const emit = defineEmits<{ reproduce: [message: KafkaMessage]; sample: [message: KafkaMessage | null]; produce: [] }>();
const ws = useWorkspace();

const PAGE_SIZES = [100, 500, 1000];
/** Rows kept at most, streamed ones included. */
const MAX_ROWS = 1000;
const DEBOUNCE_MS = 400;

const clampSize = (n: number) => Math.max(PAGE_SIZES[0]!, Math.min(PAGE_SIZES[PAGE_SIZES.length - 1]!, n));
const ownSize = clampSize(ws.state.init!.pageSize);
const sizes = [...new Set([...PAGE_SIZES, ownSize])].sort((a, b) => a - b);
const remembered = ws.state.prefs.pageSize;
const pageSize = ref(remembered !== undefined && sizes.includes(remembered) ? remembered : ownSize);

const filters = ref<MessageFilter[]>((ws.memory.filters.get(props.topic.name) ?? []).map((f) => ({ ...f })));
let filterSeq = Math.max(0, ...filters.value.map((f) => f.id));
watch(filters, (list) => ws.memory.filters.set(props.topic.name, list.map((f) => ({ ...f }))), { deep: true });
const built = computed(() => buildMessageQuery(props.topic.name, pageSize.value, props.topic.partitions, filters.value));
const problemText = computed(() => {
  const [id, problem] = [...built.value.problems][0] ?? [];
  const f = filters.value.find((x) => x.id === id);
  return f && problem ? `${filterKind(f.type).label}: ${problem}` : null;
});

const current = ref(0);
const loading = ref(false);
const error = ref<string | null>(null);
const page = ref<KafkaMessagePage | null>(null);
const durationMs = ref(0);
const rows = ref<KafkaMessage[]>([]);
/** Streamed rows are `live`, rows this page produced are `new`; both are highlighted. */
const marks = ref<Record<string, 'live' | 'new'>>({});
const produced = new Set<string>();
const picked = ref<string | null>(null);

const streaming = ref(false);
const streamCount = ref(0);
const streamNote = ref<string | null>(null);
/** Where a stream continues: the page's positions, moved on by streamed messages. */
let positions: KafkaPositions = {};
/** The stream was stopped for new filters and starts again when their page arrives. */
let resume = false;
/** The last query sent, so an unchanged query is not read again. */
let sent = '';
/** Filters that narrowed the page on show; the chips may already say more. */
const pageFilters = ref(0);
let timer: ReturnType<typeof setTimeout> | undefined;

const table = ref<HTMLElement>();
const filterRow = ref<HTMLElement>();

const pickedMessage = computed(() => rows.value.find((m) => messageId(m) === picked.value) ?? null);

function fetch(force = false): void {
  clearTimeout(timer);
  const query = built.value.query;
  const key = JSON.stringify(query);
  if (!force && key === sent) return;
  sent = key;
  if (streaming.value) {
    stopStream();
    resume = true;
  }
  current.value = ++requestSeq;
  pageFilters.value = built.value.active;
  loading.value = true;
  error.value = null;
  ws.post({ type: 'messages', requestId: current.value, query });
}

watch(
  () => JSON.stringify(built.value.query),
  () => {
    clearTimeout(timer);
    timer = setTimeout(() => fetch(), DEBOUNCE_MS);
  },
);
watch(pageSize, (size) => {
  ws.setPrefs({ pageSize: size });
  fetch();
});

function addFilter(event: Event): void {
  const select = event.target as HTMLSelectElement;
  const type = select.value as FilterType | '';
  select.value = '';
  if (!type) return;
  filters.value = [...filters.value, { id: ++filterSeq, type, from: '', to: '' }];
  void nextTick(() => filterRow.value?.querySelector<HTMLInputElement>('.fchip:last-of-type input')?.focus());
}

function removeFilter(id: number): void {
  filters.value = filters.value.filter((f) => f.id !== id);
  void nextTick(() => fetch());
}

function clearFilters(): void {
  filters.value = [];
  void nextTick(() => fetch());
}

function startStream(): void {
  if (!page.value) return;
  streaming.value = true;
  streamCount.value = 0;
  streamNote.value = null;
  const q = built.value.query;
  ws.post({ type: 'stream', topic: props.topic.name, positions, partition: q.partition, text: q.text });
}

function stopStream(): void {
  if (!streaming.value) return;
  streaming.value = false;
  ws.post({ type: 'stopStream' });
}

function markProduced(list: KafkaMessage[]): void {
  for (const m of list) if (produced.has(messageId(m))) marks.value[messageId(m)] = 'new';
}

/** Streamed messages go on top; the table keeps the newest MAX_ROWS. */
function prepend(list: KafkaMessage[]): void {
  const known = new Set(rows.value.map(messageId));
  const fresh = list.filter((m) => !known.has(messageId(m)));
  for (const m of fresh) {
    marks.value[messageId(m)] = 'live';
    const at = positions[String(m.partition)];
    const next = (BigInt(m.offset) + 1n).toString();
    if (at === undefined || compareOffsets(next, at) > 0) positions[String(m.partition)] = next;
  }
  markProduced(fresh);
  streamCount.value += fresh.length;
  rows.value = [...fresh, ...rows.value].slice(0, MAX_ROWS);
  if (picked.value === null && rows.value[0]) picked.value = messageId(rows.value[0]);
}

const stop = onHostMessage<KafkaWorkspaceHostMessage>((message) => {
  switch (message.type) {
    case 'messages':
      if (message.requestId !== current.value) return;
      loading.value = false;
      page.value = message.page;
      durationMs.value = message.durationMs;
      positions = { ...message.page.positions };
      rows.value = message.page.messages.slice(0, MAX_ROWS);
      marks.value = {};
      markProduced(rows.value);
      if (!rows.value.some((m) => messageId(m) === picked.value)) picked.value = rows.value[0] ? messageId(rows.value[0]) : null;
      emit('sample', rows.value[0] ?? null);
      if (resume) {
        resume = false;
        startStream();
      }
      break;
    case 'messagesFailed':
      if (message.requestId !== current.value) return;
      loading.value = false;
      resume = false;
      error.value = message.message;
      break;
    case 'streamed':
      if (message.topic === props.topic.name && streaming.value) prepend(message.messages);
      break;
    case 'streamStopped':
      if (message.topic !== props.topic.name) return;
      streaming.value = false;
      streamNote.value = message.message;
      break;
    case 'produced':
      if (message.topic !== props.topic.name) return;
      for (const r of message.results) produced.add(messageId(r));
      // A running stream brings the new messages; otherwise the page is read again.
      if (!streaming.value) fetch(true);
      break;
  }
});

// A write that empties or replaces the topic makes the page stale.
ws.onDone((write) => {
  if ((write?.kind === 'clearTopic' || write?.kind === 'recreateTopic') && write.topic === props.topic.name) fetch(true);
});

fetch(true);
onUnmounted(() => {
  clearTimeout(timer);
  stopStream();
  stop();
});

function onTableKey(event: KeyboardEvent): void {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
  event.preventDefault();
  const at = rows.value.findIndex((m) => messageId(m) === picked.value);
  const next = rows.value[Math.max(0, Math.min(rows.value.length - 1, at + (event.key === 'ArrowDown' ? 1 : -1)))];
  if (!next) return;
  picked.value = messageId(next);
  void nextTick(() => table.value?.querySelector<HTMLElement>('tr.picked button')?.focus());
}

const status = computed((): { text: string; tone: 'ok' | 'warn' | 'error' | 'muted' } => {
  if (error.value) return { text: error.value, tone: 'error' };
  if (streaming.value) {
    const text = built.value.query.text;
    return {
      text: text ? `Streaming — waiting for messages containing "${text}" · ${num(streamCount.value)} matched so far` : `Streaming live · ${plural(streamCount.value, 'new message')}`,
      tone: 'warn',
    };
  }
  if (!page.value || loading.value) return { text: 'Reading messages…', tone: 'muted' };
  const parts = [`Showing ${plural(rows.value.length, 'message')}, newest first`];
  if (pageFilters.value) parts.push(plural(pageFilters.value, 'filter'));
  parts.push(`fetched in ${num(Math.round(durationMs.value))} ms`);
  if (page.value.partial) parts.push(`scanned ${num(page.value.scanned)}, stopped at the search budget`);
  if (streamNote.value) parts.unshift(`Stream stopped: ${streamNote.value}`);
  return { text: parts.join(' · '), tone: page.value.partial || streamNote.value ? 'warn' : 'ok' };
});

const emptyTopic = computed(() => props.topic.messages === 0 && !pageFilters.value);

function copyAll(): void {
  ws.copy(rows.value.map(messageJson).join('\n'), plural(rows.value.length, 'message'));
}
</script>

<template>
  <div class="message-browser">
    <div ref="filterRow" class="filters">
      <span v-for="f in filters" :key="f.id" class="fchip mono" :class="{ invalid: built.problems.has(f.id) }" :title="built.problems.get(f.id)">
        <span class="flabel">{{ filterKind(f.type).label }}</span>
        <input
          v-model="f.from"
          :aria-label="filterKind(f.type).range ? `${filterKind(f.type).label} from` : filterKind(f.type).menu"
          :placeholder="filterKind(f.type).from"
          :style="{ width: `${filterKind(f.type).width}ch` }"
          spellcheck="false"
          autocomplete="off"
        />
        <template v-if="filterKind(f.type).range">
          <span class="t-muted">to</span>
          <input v-model="f.to" :aria-label="`${filterKind(f.type).label} to`" :placeholder="filterKind(f.type).to" :style="{ width: `${filterKind(f.type).width}ch` }" spellcheck="false" autocomplete="off" />
        </template>
        <IconButton icon="close" :label="`Remove the ${filterKind(f.type).label} filter`" class="fremove" @click="removeFilter(f.id)" />
      </span>
      <select class="sel" aria-label="Add filter" value="" @change="addFilter">
        <option value="">+ Add filter</option>
        <option v-for="k in FILTER_KINDS" :key="k.type" :value="k.type" :disabled="filters.some((f) => f.type === k.type)">{{ k.menu }}</option>
      </select>
      <div class="tools">
        <IconButton icon="reload" label="Read the messages again" :disabled="streaming || loading" @click="fetch(true)" />
        <button type="button" class="btn sm stream" :class="{ on: streaming }" :aria-pressed="streaming" :disabled="!streaming && !page" @click="streaming ? stopStream() : startStream()">
          <span class="dot" :class="streaming ? 'tone-error pulse' : 'tone-muted'" />{{ streaming ? 'Stop streaming' : 'Stream' }}
        </button>
        <select v-model.number="pageSize" class="sel" aria-label="Page size">
          <option v-for="n in sizes" :key="n" :value="n">Page size {{ n }}</option>
        </select>
      </div>
    </div>
    <p v-if="problemText" class="error-line problem"><Icon name="error" :size="14" /> {{ problemText }}</p>

    <div class="status" :class="`tone-${status.tone}`" role="status">
      <span class="text">{{ status.text }}</span>
      <button type="button" class="lnk" :disabled="!rows.length" @click="copyAll">Copy all</button>
      <button type="button" class="lnk" @click="ws.post({ type: 'dump', topic: topic.name })">Dump to file…</button>
    </div>

    <div ref="table" class="table-box messages" :class="{ dim: loading && !streaming, joined: pickedMessage }" @keydown="onTableKey">
      <table class="grid">
        <colgroup>
          <col class="p-col" />
          <col class="offset-col" />
          <col class="time-col" />
          <col class="key-col" />
          <col />
        </colgroup>
        <thead>
          <tr>
            <th scope="col">P</th>
            <th scope="col" class="num">OFFSET</th>
            <th scope="col">TIME</th>
            <th scope="col">KEY</th>
            <th scope="col">VALUE</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="m in rows"
            :key="messageId(m)"
            :class="[marks[messageId(m)] ?? '', { picked: picked === messageId(m) }]"
            @click="picked = messageId(m)"
          >
            <td class="pad0"><button type="button" class="rowb" :aria-label="`Open partition ${m.partition} offset ${m.offset}`">{{ m.partition }}</button></td>
            <td class="num c-num">{{ offsetText(m.offset) }}</td>
            <td>{{ formatTime(m.timestamp) }}</td>
            <td class="cut c-name" :class="{ 't-muted': payloadPreview(m.key).muted }" :title="m.key?.text ?? 'null'">{{ payloadPreview(m.key, 120).text }}</td>
            <td class="cut c-str" :class="{ 't-muted': payloadPreview(m.value).muted }">{{ payloadPreview(m.value).text }}</td>
          </tr>
        </tbody>
      </table>
      <p v-if="page && !rows.length && emptyTopic" class="empty-state">
        This topic is empty.
        <button v-if="!ws.state.init!.readOnly" type="button" class="lnk" @click="emit('produce')">Produce a message</button>
      </p>
      <p v-else-if="page && !rows.length" class="empty-state">
        No messages match these filters. <button type="button" class="lnk" @click="clearFilters">Remove the filters</button>
      </p>
    </div>
    <MessagePane v-if="pickedMessage" :message="pickedMessage" @reproduce="emit('reproduce', $event)" />
  </div>
</template>

<style scoped>
.message-browser {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.filters {
  flex: none;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 10px 20px 8px;
}
.fchip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 2px 0 10px;
  border: 1px solid color-mix(in srgb, var(--vscode-focusBorder) 55%, transparent);
  border-radius: 14px;
  background: color-mix(in srgb, var(--vscode-focusBorder) 12%, transparent);
  font-size: 12px;
}
.fchip.invalid {
  border-color: var(--vscode-inputValidation-errorBorder);
}
.flabel {
  color: var(--vscode-textLink-foreground);
}
.fchip input {
  height: 22px;
  min-width: 0;
  padding: 0 6px;
  border: 0;
  border-radius: 3px;
  outline: none;
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  font: inherit;
}
.fchip input::placeholder {
  color: var(--vscode-input-placeholderForeground);
}
.fchip input:focus {
  box-shadow: 0 0 0 1px var(--vscode-focusBorder);
}
.fremove {
  width: 22px;
  height: 22px;
  border-radius: 11px;
}
.tools {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 6px;
}
.stream {
  gap: 7px;
}
.stream.on {
  border-color: color-mix(in srgb, var(--k-error) 60%, transparent);
  background: color-mix(in srgb, var(--k-error) 16%, transparent);
}
.problem {
  padding: 0 20px 8px;
}
.status {
  flex: none;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 12px;
  margin: 0 20px 8px;
  padding: 6px 10px;
  border: 1px solid color-mix(in srgb, var(--tone) 45%, transparent);
  border-radius: 4px;
  background: color-mix(in srgb, var(--tone) 10%, transparent);
  font-size: 12px;
}
.status .text {
  flex: 1 1 260px;
  min-width: 0;
}
.status .lnk {
  font-size: 12px;
}
.messages {
  flex: 1 1 140px;
  min-height: 80px;
  margin: 0 20px 14px;
}
.messages.joined {
  margin-bottom: 0;
  border-radius: 4px 4px 0 0;
}
.messages.dim {
  opacity: 0.6;
}
.grid {
  table-layout: fixed;
  min-width: 640px;
}
.p-col {
  width: 46px;
}
.offset-col {
  width: 110px;
}
.time-col {
  width: 154px;
}
.key-col {
  width: 150px;
}
.cut {
  overflow: hidden;
  text-overflow: ellipsis;
}
tbody tr {
  cursor: pointer;
}
tr.live {
  background: color-mix(in srgb, var(--k-warn) 12%, transparent);
}
tr.new {
  background: color-mix(in srgb, var(--k-ok) 14%, transparent);
}
</style>
