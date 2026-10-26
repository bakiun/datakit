<script setup lang="ts">
import type { KafkaMessage } from '@datakit/core';
import { computed, ref } from 'vue';
import CodeView from '../components/CodeView.vue';
import IconButton from '../components/IconButton.vue';
import { formatBytes, hexRows, offsetText, payloadBytes, prettyJson } from './format';
import { useWorkspace } from './workspace';

/** The picked message in full: Pretty indents JSON (or shows a schema payload decoded), Raw shows the text, Hex the bytes. */
const props = defineProps<{ message: KafkaMessage }>();
defineEmits<{ reproduce: [message: KafkaMessage] }>();
const ws = useWorkspace();

type Mode = 'pretty' | 'raw' | 'hex';
const MODES: { id: Mode; label: string }[] = [
  { id: 'pretty', label: 'Pretty' },
  { id: 'raw', label: 'Raw' },
  { id: 'hex', label: 'Hex' },
];
/** Bytes shown in Hex at most. */
const HEX_BYTES = 4096;
const mode = ref<Mode>('pretty');

const value = computed(() => props.message.value);
const keyText = computed(() => {
  const k = props.message.key;
  if (!k) return 'null';
  const text = k.binary ? `0x${k.text}` : k.text;
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
});

/** What Pretty shows; null for binary payloads without a decoded form, which Pretty shows as hex. */
const pretty = computed((): { text: string; json: boolean } | null => {
  const v = value.value;
  if (!v) return { text: '', json: false };
  if (v.decoded !== null) return { text: prettyJson(v.decoded) ?? v.decoded, json: true };
  if (v.binary) return null;
  const p = prettyJson(v.text);
  return p === null ? { text: v.text, json: false } : { text: p, json: true };
});
const showHex = computed(() => mode.value === 'hex' || (mode.value === 'pretty' && pretty.value === null));
const hex = computed(() => (value.value && showHex.value ? hexRows(payloadBytes(value.value), HEX_BYTES) : []));
const text = computed(() => (mode.value === 'raw' ? (value.value?.text ?? '') : (pretty.value?.text ?? '')));

const notes = computed(() => {
  const v = value.value;
  const list: string[] = [];
  if (v?.schemaId !== null && v?.schemaId !== undefined) list.push(`schema id ${v.schemaId}${v.decoded === null ? ' · not decoded' : ''}`);
  if (v?.truncated) list.push(`only the start of ${formatBytes(v.size)} is shown`);
  if (showHex.value && v && v.size > HEX_BYTES) list.push(`first ${formatBytes(HEX_BYTES)} in hex`);
  return list;
});

function copy(): void {
  const shown = showHex.value ? hex.value.map((r) => `${r.offset}  ${r.hex}  ${r.ascii}`).join('\n') : text.value;
  ws.copy(shown, `the value of offset ${props.message.offset}`);
}
</script>

<template>
  <section class="message-pane" aria-label="Picked message">
    <div class="bar">
      <span class="mono where">p{{ message.partition }} · offset {{ offsetText(message.offset) }} · key {{ keyText }} · {{ formatBytes(value?.size ?? 0) }}</span>
      <span v-for="n in notes" :key="n" class="note">{{ n }}</span>
      <div class="seg-group" role="group" aria-label="Value format">
        <button v-for="m in MODES" :key="m.id" type="button" class="seg" :aria-pressed="mode === m.id" @click="mode = m.id">{{ m.label }}</button>
      </div>
      <button v-if="!ws.state.init!.readOnly" type="button" class="btn sm" @click="$emit('reproduce', message)">Edit &amp; re-produce</button>
      <IconButton icon="copy" label="Copy the value as shown" class="copy" @click="copy" />
    </div>
    <div v-if="message.headers.length" class="headers mono">
      <span class="caps">Headers</span>
      <span v-for="(h, i) in message.headers" :key="i" class="header" :title="`${h.key}=${h.value ?? 'null'}`"><span class="c-name">{{ h.key }}</span>=<span :class="h.value === null ? 't-muted' : 'c-str'">{{ h.value ?? 'null' }}</span></span>
    </div>
    <div class="content">
      <p v-if="!value" class="empty-state">The value is null (a tombstone).</p>
      <div v-else-if="showHex" class="hex mono">
        <div v-for="r in hex" :key="r.offset" class="hex-row"><span class="off">{{ r.offset }}</span><span class="c-num">{{ r.hex }}</span><span class="t-muted">{{ r.ascii }}</span></div>
        <p v-if="!hex.length" class="empty-state">The value is empty.</p>
      </div>
      <CodeView v-else :model-value="text" :language="mode === 'pretty' && pretty?.json ? 'json' : 'text'" read-only label="Message value" />
    </div>
  </section>
</template>

<style scoped>
.message-pane {
  flex: none;
  display: flex;
  flex-direction: column;
  margin: 0 20px 14px;
  overflow: hidden;
  border: 1px solid var(--k-border);
  border-top: 0;
  border-radius: 0 0 4px 4px;
  background: var(--k-surface);
}
.bar {
  flex: none;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 10px;
  padding: 4px 6px 4px 10px;
  border-bottom: 1px solid var(--k-border);
  background: var(--k-head);
  font-size: 12px;
}
.where {
  color: var(--k-muted);
  overflow-wrap: anywhere;
}
.seg-group {
  margin-left: auto;
}
.copy {
  width: 24px;
  height: 24px;
}
.headers {
  flex: none;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 14px;
  max-height: 48px;
  overflow: auto;
  padding: 4px 10px;
  border-bottom: 1px solid var(--k-border);
}
.header {
  max-width: 360px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.content {
  height: clamp(110px, 26vh, 200px);
  min-height: 0;
}
.content :deep(.cm-editor) {
  background: transparent;
}
.content :deep(.cm-gutters) {
  background: transparent;
}
.hex {
  height: 100%;
  overflow: auto;
  box-sizing: border-box;
  padding: 6px 0;
  line-height: 19px;
  white-space: pre;
}
.hex-row {
  display: flex;
  gap: 16px;
}
.off {
  flex: none;
  width: 48px;
  padding-right: 4px;
  text-align: right;
  color: var(--vscode-editorLineNumber-foreground);
}
</style>
