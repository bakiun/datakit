<script setup lang="ts">
import { retentionLabel, type KafkaTopicSummary } from '@datakit/core';
import { computed, onMounted, ref } from 'vue';
import Icon from '../components/Icon.vue';
import IconButton from '../components/IconButton.vue';
import ConfirmDialog from './ConfirmDialog.vue';
import CreateTopicDialog from './CreateTopicDialog.vue';
import { formatBytes, num, plural, textTable } from './format';
import StarButton from './StarButton.vue';
import { useWorkspace } from './workspace';

/** The topics of the cluster with their size and settings; a row opens the topic. */
const ws = useWorkspace();
const s = ws.state;
/** Rows drawn at most; the filter narrows a larger list. */
const MAX_ROWS = 1000;

const filter = ref('');
const internal = ref(false);
type Dialog = { kind: 'create'; source: KafkaTopicSummary | null } | { kind: 'clear' | 'delete'; topic: string };
const dialog = ref<Dialog | null>(null);

const readOnly = computed(() => s.init!.readOnly);
const brokers = computed(() => (s.brokers ?? s.overview?.overview.brokers ?? []).length);
const rows = computed(() => {
  const needle = filter.value.trim().toLowerCase();
  return (s.topics ?? []).filter((t) => (internal.value || !t.internal) && (!needle || t.name.toLowerCase().includes(needle))).sort((a, b) => a.name.localeCompare(b.name));
});
const shown = computed(() => rows.value.slice(0, MAX_ROWS));
const format = (t: KafkaTopicSummary) => s.formats[t.name] ?? '—';

function copySummary(): void {
  const text = textTable(
    ['TOPIC', 'PARTITIONS', 'RF', 'MESSAGES', 'SIZE', 'RETENTION', 'FORMAT'],
    rows.value.map((t) => [t.name, String(t.partitions), String(t.replicationFactor), num(t.messages), formatBytes(t.bytes), retentionLabel(t), format(t)]),
    [false, true, true, true, true, false, false],
  );
  ws.copy(text, plural(rows.value.length, 'topic'));
}

const clearAction = (topic: string) => () => ws.write({ kind: 'clearTopic', topic }, { quiet: true });
const deleteAction = (topic: string) => () => ws.write({ kind: 'deleteTopic', topic }, { quiet: true });

onMounted(() => ws.load('topics'));
</script>

<template>
  <section class="page">
    <header class="page-head">
      <h1>Topics</h1>
      <input v-model="filter" class="fld filter" aria-label="Filter topics" placeholder="Filter topics" spellcheck="false" />
      <label class="check internal"><input v-model="internal" type="checkbox" /> Internal</label>
      <div class="actions">
        <IconButton icon="reload" label="Read the topics again" :disabled="s.loading.topics" @click="ws.load('topics')" />
        <button type="button" class="btn" :disabled="!rows.length" @click="copySummary">Copy summary</button>
        <button v-if="!readOnly" type="button" class="btn btn-primary" @click="dialog = { kind: 'create', source: null }"><Icon name="plus" :size="14" /> Create topic</button>
      </div>
    </header>
    <p v-if="s.errors.topics" class="error-line pad" role="alert"><Icon name="error" :size="14" /> {{ s.errors.topics }}</p>
    <div class="table-box list">
      <table class="grid">
        <thead>
          <tr>
            <th scope="col" class="star-col"><span class="sr-only">Favourite</span></th>
            <th scope="col">TOPIC</th>
            <th scope="col" class="num">PARTITIONS</th>
            <th scope="col" class="num">RF</th>
            <th scope="col" class="num">MESSAGES</th>
            <th scope="col" class="num">SIZE</th>
            <th scope="col">RETENTION</th>
            <th scope="col">FORMAT</th>
            <th scope="col"><span class="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="t in shown" :key="t.name">
            <td class="pad0 star-col"><StarButton :topic="t.name" /></td>
            <td class="pad0 topic">
              <button type="button" class="rowb" :class="{ 't-muted': t.internal }" :title="t.name" @click="ws.openTopic(t.name)">
                <span class="name">{{ t.name }}</span>
                <span v-if="t.underReplicated" class="chip tone-warn">{{ num(t.underReplicated) }} under-replicated</span>
              </button>
            </td>
            <td class="num">{{ num(t.partitions) }}</td>
            <td class="num">{{ t.replicationFactor }}</td>
            <td class="num c-num">{{ num(t.messages) }}</td>
            <td class="num t-muted">{{ formatBytes(t.bytes) }}</td>
            <td>{{ retentionLabel(t) }}</td>
            <td class="t-muted">{{ format(t) }}</td>
            <td class="pad0">
              <div class="row-actions">
                <IconButton v-if="!readOnly" icon="copy" :label="`Clone ${t.name}`" @click="dialog = { kind: 'create', source: t }" />
                <IconButton icon="download" :label="`Dump ${t.name} to a file`" @click="ws.post({ type: 'dump', topic: t.name })" />
                <IconButton v-if="!readOnly" icon="clear" :label="`Clear the messages of ${t.name}`" @click="dialog = { kind: 'clear', topic: t.name }" />
                <IconButton v-if="!readOnly" icon="trash" :label="`Delete ${t.name}`" tone="danger" @click="dialog = { kind: 'delete', topic: t.name }" />
              </div>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-if="!s.topics" class="empty-state">{{ s.loading.topics ? 'Reading the topics…' : '' }}</p>
      <p v-else-if="!rows.length" class="empty-state">{{ s.topics.length ? 'No topic matches the filter.' : 'The cluster has no topics yet.' }}</p>
      <p v-else-if="rows.length > shown.length" class="empty-state">Showing {{ num(shown.length) }} of {{ num(rows.length) }} topics. Filter to narrow them down.</p>
    </div>

    <CreateTopicDialog
      v-if="dialog?.kind === 'create'"
      :source="dialog.source"
      :existing="(s.topics ?? []).map((t) => t.name)"
      :brokers="brokers"
      @close="dialog = null"
    />
    <ConfirmDialog
      v-else-if="dialog?.kind === 'clear'"
      :title="`Clear ${dialog.topic}`"
      :text="`Deletes every message in ${dialog.topic}. The topic, its settings and consumer offsets stay.`"
      primary="Clear messages"
      :action="clearAction(dialog.topic)"
      @close="dialog = null"
    />
    <ConfirmDialog
      v-else-if="dialog?.kind === 'delete'"
      title="Delete topic"
      text="Deletes the topic, all partitions and messages. Producers writing to it will fail."
      :target="dialog.topic"
      primary="Delete"
      :action="deleteAction(dialog.topic)"
      @close="dialog = null"
    />
  </section>
</template>

<style scoped>
.filter {
  flex: 0 1 260px;
  margin-left: 12px;
}
.internal {
  font-weight: 400;
  font-size: 12px;
  color: var(--k-muted);
}
.pad {
  padding: 0 20px 8px;
}
.list {
  flex: 1;
  min-height: 0;
  margin: 0 20px 16px;
}
.star-col {
  width: 34px;
  text-align: center;
}
.topic {
  max-width: 420px;
}
.name {
  overflow: hidden;
  text-overflow: ellipsis;
}
.row-actions {
  display: flex;
  justify-content: flex-end;
  padding-right: 6px;
}
.row-actions :deep(.icon-btn) {
  width: 26px;
  height: 26px;
}
</style>
