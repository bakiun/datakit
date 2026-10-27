<script setup lang="ts">
import type { KafkaMessage, KafkaWorkspaceHostMessage } from '@datakit/core';
import { computed, onUnmounted, ref } from 'vue';
import Icon from '../components/Icon.vue';
import { onHostMessage } from '../host';
import { num, plural, prettyJson } from './format';
import MessageBrowser from './MessageBrowser.vue';
import ProduceForm, { type ProducePrefill } from './ProduceForm.vue';
import StarButton from './StarButton.vue';
import TopicConsumers from './TopicConsumers.vue';
import TopicSettings from './TopicSettings.vue';
import { useWorkspace } from './workspace';

/** One topic: its messages, settings and consumer groups, with the produce panel beside them. */
const props = defineProps<{ name: string }>();
const ws = useWorkspace();
const s = ws.state;

type Tab = 'messages' | 'settings' | 'consumers';
const TABS: { id: Tab; label: string }[] = [
  { id: 'messages', label: 'Messages' },
  { id: 'settings', label: 'Settings' },
  { id: 'consumers', label: 'Consumers' },
];
const tab = ref<Tab>('messages');
const produceOpen = ref(false);
const prefill = ref<ProducePrefill | null>(null);
/** The newest message on the page, which the produce form starts from. */
const sample = ref<KafkaMessage | null>(null);

const detail = computed(() => (s.topicDetail?.name === props.name ? s.topicDetail : null));
const readOnly = computed(() => s.init!.readOnly);
const summary = computed(() => {
  const d = detail.value;
  if (!d) return '';
  return `${plural(d.partitions, 'partition')} · RF ${d.replicationFactor} · ${plural(d.messages, 'message')} · ${s.formats[props.name] ?? '—'}`;
});

/** Edit & re-produce: the message's partition, key, value and headers, as a template. */
function reproduce(message: KafkaMessage): void {
  const v = message.value;
  const text = v === null ? '' : (v.decoded ?? v.text);
  const pretty = prettyJson(text);
  const avro = v?.schemaId !== null && v?.schemaId !== undefined && s.init!.schemaRegistryUrl !== null;
  prefill.value = {
    partition: message.partition,
    key: message.key === null ? null : message.key.text,
    value: pretty ?? text,
    headers: message.headers.map((h) => `${h.key}=${h.value ?? ''}`).join('\n'),
    valueFormat: avro ? 'avro' : pretty !== null ? 'json' : 'string',
  };
  produceOpen.value = true;
}

/** The Produce button opens the form as it was left (or a new one); Edit & re-produce fills it. */
function toggleProduce(): void {
  prefill.value = null;
  produceOpen.value = !produceOpen.value;
}

function openProduce(): void {
  prefill.value = null;
  produceOpen.value = true;
}

const stop = onHostMessage<KafkaWorkspaceHostMessage>((message) => {
  if (message.type === 'produced' && message.topic === props.name) tab.value = 'messages';
});
onUnmounted(stop);
</script>

<template>
  <section class="page topic-detail">
    <header class="head">
      <button type="button" class="lnk" @click="ws.go('topics')">Topics</button>
      <span class="slash">/</span>
      <h1 class="mono">{{ name }}</h1>
      <StarButton :topic="name" :size="16" />
      <span class="note">{{ summary }}</span>
      <span v-if="detail?.underReplicated" class="chip tone-warn">{{ num(detail.underReplicated) }} under-replicated</span>
      <button v-if="!readOnly && detail" type="button" class="btn btn-primary produce" :aria-pressed="produceOpen" @click="toggleProduce">
        {{ produceOpen ? 'Close produce' : 'Produce' }}
      </button>
    </header>
    <div role="tablist" aria-label="Topic" class="tabs">
      <button v-for="t in TABS" :key="t.id" type="button" role="tab" class="tab" :aria-selected="tab === t.id" @click="tab = t.id">{{ t.label }}</button>
    </div>

    <p v-if="s.errors.topic" class="error-line pad" role="alert"><Icon name="error" :size="14" /> {{ s.errors.topic }}</p>
    <p v-else-if="!detail" class="empty-state pad">Opening the topic…</p>
    <div v-else class="body">
      <div class="main">
        <MessageBrowser v-show="tab === 'messages'" :topic="detail" @reproduce="reproduce" @sample="sample = $event" @produce="openProduce" />
        <TopicSettings v-if="tab === 'settings'" :detail="detail" />
        <TopicConsumers v-if="tab === 'consumers'" :topic="name" />
      </div>
      <ProduceForm v-if="produceOpen && !readOnly" :topic="detail" :prefill="prefill" :sample="sample" @close="produceOpen = false" />
    </div>
  </section>
</template>

<style scoped>
.head {
  flex: none;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
  padding: 12px 20px 4px;
}
.slash {
  color: var(--k-muted);
}
h1 {
  margin: 0;
  font-size: 16px;
  font-weight: 500;
  overflow-wrap: anywhere;
}
.produce {
  margin-left: auto;
}
.tabs {
  flex: none;
  display: flex;
  gap: 20px;
  padding: 0 20px;
  border-bottom: 1px solid var(--k-border);
}
.tab {
  height: 34px;
  padding: 0 2px;
  border: 0;
  background: transparent;
  color: var(--vscode-panelTitle-inactiveForeground, var(--k-muted));
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
.pad {
  padding: 12px 20px;
}
.body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-wrap: wrap;
  overflow: auto;
}
.main {
  flex: 999 1 520px;
  min-width: 0;
  min-height: 360px;
  height: 100%;
  display: flex;
  flex-direction: column;
}
</style>
