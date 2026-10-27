<script setup lang="ts">
import type { KafkaTopicDetail } from '@datakit/core';
import { computed, ref } from 'vue';
import Icon from '../components/Icon.vue';
import ConfigTable from './ConfigTable.vue';
import ConfirmDialog from './ConfirmDialog.vue';
import KafkaDialog from './KafkaDialog.vue';
import { useWorkspace } from './workspace';

/** Every setting of the topic, overrides first; partitions and replication factor change in a dialog. */
const props = defineProps<{ detail: KafkaTopicDetail }>();
const ws = useWorkspace();
const s = ws.state;

const saving = ref<string | null>(null);
const dialog = ref<'partitions' | 'recreate' | null>(null);
const partitions = ref('');
const replication = ref(1);

const readOnly = computed(() => s.init!.readOnly);
const brokers = computed(() => Math.max(1, (s.brokers ?? s.overview?.overview.brokers ?? []).length));
const newPartitions = computed(() => (/^\d+$/.test(partitions.value.trim()) ? Number(partitions.value) : NaN));
const partitionsValid = computed(() => newPartitions.value >= props.detail.partitions);
const changed = computed(() => newPartitions.value !== props.detail.partitions || replication.value !== props.detail.replicationFactor);

async function set(name: string, value: string | null): Promise<void> {
  saving.value = name;
  // The table shows the new value once the settings are read again, so no toast repeats it.
  await ws.write({ kind: 'setTopicConfig', topic: props.detail.name, name, value }, { announce: false });
  saving.value = null;
}

function openPartitions(): void {
  partitions.value = String(props.detail.partitions);
  replication.value = Math.min(props.detail.replicationFactor, brokers.value);
  dialog.value = 'partitions';
}

const repartition = () =>
  ws.write({ kind: 'repartition', topic: props.detail.name, partitions: newPartitions.value, replicationFactor: replication.value }, { quiet: true });
const recreate = () => ws.write({ kind: 'recreateTopic', topic: props.detail.name }, { quiet: true });
</script>

<template>
  <div class="topic-settings">
    <div class="tools">
      <span class="note">{{ readOnly ? 'Read-only: settings can be looked at, not changed.' : 'Click a value to change it; Escape cancels the edit.' }}</span>
      <div v-if="!readOnly" class="actions">
        <button type="button" class="btn" @click="openPartitions">Partitions / RF…</button>
        <button type="button" class="btn danger-text" @click="dialog = 'recreate'">Re-create topic…</button>
      </div>
    </div>
    <p v-if="s.errors.topicConfigs" class="error-line" role="alert"><Icon name="error" :size="14" /> {{ s.errors.topicConfigs }}</p>
    <p v-else-if="!s.topicConfigs" class="empty-state">Reading the settings…</p>
    <ConfigTable v-else :entries="s.topicConfigs" override-source="topic" name-label="SETTING" :editable="!readOnly" :saving="saving" @set="set" />

    <KafkaDialog
      v-if="dialog === 'partitions'"
      :title="`Partitions and replication · ${detail.name}`"
      primary="Apply"
      :disabled="!partitionsValid || !changed"
      :action="repartition"
      @close="dialog = null"
    >
      <div class="row">
        <label class="field">
          Partitions (now {{ detail.partitions }})
          <input v-model="partitions" class="fld mono" :class="{ invalid: !partitionsValid }" inputmode="numeric" />
        </label>
        <label class="field">
          Replication factor (now {{ detail.replicationFactor }})
          <select v-model.number="replication" class="fld">
            <option v-for="n in brokers" :key="n" :value="n">{{ n }}</option>
          </select>
        </label>
      </div>
      <p class="warn-line">Partitions can only grow. Changing RF starts a reassignment that copies data between brokers.</p>
    </KafkaDialog>
    <ConfirmDialog
      v-else-if="dialog === 'recreate'"
      :title="`Re-create ${detail.name}`"
      text="Deletes and immediately re-creates the topic with the same settings. All messages are lost."
      :target="detail.name"
      primary="Re-create topic"
      :action="recreate"
      @close="dialog = null"
    />
  </div>
</template>

<style scoped>
.topic-settings {
  flex: 1;
  min-height: 0;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 12px 20px 16px;
}
.tools {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.actions {
  margin-left: auto;
  display: flex;
  gap: 6px;
}
</style>
