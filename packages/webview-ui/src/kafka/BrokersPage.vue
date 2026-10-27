<script setup lang="ts">
import type { KafkaBroker, KafkaConfigEntry, KafkaLogDir, KafkaWorkspaceHostMessage } from '@datakit/core';
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import Icon from '../components/Icon.vue';
import IconButton from '../components/IconButton.vue';
import { onHostMessage } from '../host';
import ConfigTable from './ConfigTable.vue';
import { formatBytes, num } from './format';
import { useWorkspace } from './workspace';

/** The brokers of the cluster; the picked broker's dynamic settings can be changed while it runs. */
const ws = useWorkspace();
const s = ws.state;

const picked = ref<number | null>(null);
const configs = ref<KafkaConfigEntry[] | null>(null);
const saving = ref<string | null>(null);

const brokers = computed(() => [...(s.brokers ?? s.overview?.overview.brokers ?? [])].sort((a, b) => a.id - b.id));
const dynamic = computed(() => (configs.value ?? []).filter((c) => !c.readOnly));

function pick(id: number): void {
  if (picked.value !== id) configs.value = null;
  picked.value = id;
  delete s.errors.brokerConfigs;
  ws.post({ type: 'brokerConfigs', brokerId: id });
}

async function set(name: string, value: string | null): Promise<void> {
  if (picked.value === null) return;
  saving.value = name;
  // The table shows the new value once the settings are read again, so no toast repeats it.
  const result = await ws.write({ kind: 'setBrokerConfig', brokerId: picked.value, name, value }, { announce: false });
  saving.value = null;
  if (result.ok) pick(picked.value);
}

watch(
  brokers,
  (list) => {
    if (picked.value === null && list.length) pick((list.find((b) => b.online) ?? list[0]!).id);
  },
  { immediate: true },
);

const stop = onHostMessage<KafkaWorkspaceHostMessage>((message) => {
  if (message.type === 'brokerConfigs' && message.brokerId === picked.value) configs.value = message.configs;
});
onMounted(() => ws.load('brokers'));
onUnmounted(stop);

function logDir(dirs: KafkaLogDir[]): { text: string; title: string } {
  if (!dirs.length) return { text: '—', title: 'The broker reports no log directories' };
  const first = dirs[0]!;
  const describe = (d: KafkaLogDir) =>
    `${d.path}${d.bytes === null ? '' : ` · ${formatBytes(d.bytes)}`}${d.totalBytes !== null && d.usableBytes !== null ? ` · ${formatBytes(d.usableBytes)} free of ${formatBytes(d.totalBytes)}` : ''}`;
  return { text: `${first.path}${first.bytes === null ? '' : ` · ${formatBytes(first.bytes)}`}${dirs.length > 1 ? ` +${dirs.length - 1}` : ''}`, title: dirs.map(describe).join('\n') };
}

const isPicked = (b: KafkaBroker) => b.id === picked.value;
</script>

<template>
  <section class="page">
    <header class="page-head">
      <h1>Brokers</h1>
      <span class="note">Click a broker to see and edit its dynamic settings</span>
      <div class="actions">
        <IconButton icon="reload" label="Read the brokers again" :disabled="s.loading.brokers" @click="ws.load('brokers')" />
      </div>
    </header>
    <div class="page-body">
      <p v-if="s.errors.brokers" class="error-line" role="alert"><Icon name="error" :size="14" /> {{ s.errors.brokers }}</p>
      <div class="table-box">
        <table class="grid">
          <thead>
            <tr>
              <th scope="col">BROKER</th>
              <th scope="col">STATUS</th>
              <th scope="col">RACK</th>
              <th scope="col" class="num">LEADERS</th>
              <th scope="col" class="num">IN-SYNC</th>
              <th scope="col" class="num">OUT-OF-SYNC</th>
              <th scope="col" class="num">REPLICAS</th>
              <th scope="col">LOG DIR</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="b in brokers" :key="b.id" :class="{ picked: isPicked(b) }">
              <td class="pad0">
                <button type="button" class="rowb" :aria-pressed="isPicked(b)" @click="pick(b.id)">
                  broker-{{ b.id }} <span class="t-muted">{{ b.host }}:{{ b.port }}</span>
                </button>
              </td>
              <td>
                <span class="chip" :class="b.online ? 'tone-ok' : 'tone-error'">{{ b.online ? 'online' : 'offline' }}</span>
                <span v-if="b.controller" class="t-info controller">controller</span>
              </td>
              <td :class="{ 't-muted': !b.rack }">{{ b.rack ?? '—' }}</td>
              <td class="num">{{ num(b.leaders) }}</td>
              <td class="num">{{ num(b.inSync) }}</td>
              <td class="num" :class="{ 't-warn': b.outOfSync > 0 }">{{ num(b.outOfSync) }}</td>
              <td class="num">{{ num(b.replicas) }}</td>
              <td class="t-muted log-dir" :title="logDir(b.logDirs).title">{{ logDir(b.logDirs).text }}</td>
            </tr>
          </tbody>
        </table>
        <p v-if="!brokers.length" class="empty-state">{{ s.loading.brokers ? 'Reading the brokers…' : 'No brokers.' }}</p>
      </div>

      <div v-if="picked !== null" class="settings">
        <span class="caps">Dynamic settings · broker-{{ picked }}</span>
        <p v-if="s.errors.brokerConfigs" class="error-line" role="alert"><Icon name="error" :size="14" /> {{ s.errors.brokerConfigs }}</p>
        <p v-else-if="!configs" class="empty-state">Reading the settings…</p>
        <ConfigTable v-else :entries="dynamic" override-source="broker" name-label="NAME" :editable="!s.init!.readOnly" :saving="saving" @set="set" />
      </div>
    </div>
  </section>
</template>

<style scoped>
.controller {
  margin-left: 6px;
}
.log-dir {
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.settings {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
</style>
