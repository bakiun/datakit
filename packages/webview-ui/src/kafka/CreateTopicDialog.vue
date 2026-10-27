<script setup lang="ts">
import { retentionLabel, RETENTION_CHOICES, topicNameProblem, type KafkaTopicSummary } from '@datakit/core';
import { computed, ref } from 'vue';
import KafkaDialog from './KafkaDialog.vue';
import { useWorkspace } from './workspace';

/** Creates a topic, or clones one: the clone gets the source's overrides, the messages stay behind. */
const props = defineProps<{ source: KafkaTopicSummary | null; existing: string[]; brokers: number }>();
const emit = defineEmits<{ close: [] }>();
const ws = useWorkspace();

/** `source` keeps the clone's own retention, which the host copies with the other overrides. */
const SAME = 'source';
const name = ref(props.source ? `${props.source.name}-copy` : '');
const partitions = ref(String(props.source?.partitions ?? 6));
const replication = ref(Math.max(1, Math.min(props.source?.replicationFactor ?? 3, props.brokers)));
const retention = ref<string>(props.source ? SAME : String(RETENTION_CHOICES[1]!.ms));

const nameProblem = computed(() => (name.value.trim() ? topicNameProblem(name.value, props.existing) : null));
const partitionCount = computed(() => (/^\d+$/.test(partitions.value.trim()) ? Number(partitions.value) : NaN));
const partitionProblem = computed(() => (partitionCount.value >= 1 && partitionCount.value <= 100_000 ? null : 'Partitions are a whole number from 1.'));
const valid = computed(() => !!name.value.trim() && !nameProblem.value && !partitionProblem.value);
const sourceRetention = computed(() => (props.source ? retentionLabel(props.source) : ''));

function create() {
  const topic = name.value.trim();
  const configs: Record<string, string> = retention.value === SAME ? {} : { 'retention.ms': retention.value };
  return ws
    .write(
      { kind: 'createTopic', spec: { name: topic, partitions: partitionCount.value, replicationFactor: replication.value, configs }, cloneOf: props.source?.name ?? null },
      // A new topic opens, which says enough; a clone's toast says the messages stayed behind.
      { quiet: true, announce: !!props.source },
    )
    .then((result) => {
      if (result.ok) ws.openTopic(topic);
      return result;
    });
}
</script>

<template>
  <KafkaDialog
    :title="source ? `Clone ${source.name}` : 'Create topic'"
    :primary="source ? 'Clone topic' : 'Create topic'"
    :disabled="!valid"
    :action="create"
    @close="emit('close')"
  >
    <label class="field">
      Name
      <input v-model="name" class="fld mono" :class="{ invalid: nameProblem }" placeholder="orders.refunded" spellcheck="false" autocomplete="off" />
    </label>
    <span v-if="nameProblem" class="t-error problem">{{ nameProblem }}</span>
    <div class="row">
      <label class="field">
        Partitions
        <input v-model="partitions" class="fld mono" :class="{ invalid: partitionProblem }" inputmode="numeric" />
      </label>
      <label class="field">
        Replication factor
        <select v-model.number="replication" class="fld">
          <option v-for="n in Math.max(1, brokers)" :key="n" :value="n">{{ n }}</option>
        </select>
      </label>
      <label class="field">
        Retention
        <select v-model="retention" class="fld">
          <option v-if="source" :value="SAME">Same as source ({{ sourceRetention }})</option>
          <option v-for="c in RETENTION_CHOICES" :key="c.ms" :value="String(c.ms)">{{ c.label }}</option>
        </select>
      </label>
    </div>
    <span v-if="partitionProblem" class="t-error problem">{{ partitionProblem }}</span>
    <span v-if="source" class="note">Settings are copied from {{ source.name }}. Messages are not copied.</span>
  </KafkaDialog>
</template>

<style scoped>
.problem {
  font-size: 12px;
  margin-top: -6px;
}
</style>
