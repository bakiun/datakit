<script setup lang="ts">
import {
  KAFKA_VALUE_FORMATS,
  PRODUCE_PLACEHOLDERS,
  produceProblem,
  valueProblem,
  type KafkaMessage,
  type KafkaProduceTemplate,
  type KafkaTopicDetail,
  type KafkaValueFormat,
} from '@datakit/core';
import { computed, ref, watch } from 'vue';
import Icon from '../components/Icon.vue';
import IconButton from '../components/IconButton.vue';
import { num, prettyJson } from './format';
import { useWorkspace } from './workspace';

/** What Edit & re-produce puts into the form. */
export interface ProducePrefill {
  partition: number | null;
  key: string | null;
  value: string;
  headers: string;
  valueFormat: KafkaValueFormat;
}

/** Produces one message, or `count` copies with the placeholders filled in per message. */
const props = defineProps<{ topic: KafkaTopicDetail; prefill: ProducePrefill | null; sample: KafkaMessage | null }>();
const emit = defineEmits<{ close: [] }>();
const ws = useWorkspace();

const EXAMPLE = '{\n  "id": "${uuid}",\n  "count": ${counter},\n  "createdAt": "${now}"\n}';
const formats = computed(() => KAFKA_VALUE_FORMATS.filter((f) => f.value !== 'avro' || ws.state.init!.schemaRegistryUrl !== null));

/** The newest message's value is the starting point when it is JSON. */
const sampleValue = (() => {
  const v = props.sample?.value;
  return v && !v.binary ? prettyJson(v.decoded ?? v.text) : null;
})();
const partition = ref('auto');
const valueFormat = ref<KafkaValueFormat>('json');
const key = ref('key-${counter}');
const keyNull = ref(false);
const value = ref(sampleValue ?? EXAMPLE);
const headers = ref('trace-id=${uuid}');
const count = ref('1');
const busy = ref(false);
const error = ref<string | null>(null);

function apply(prefill: ProducePrefill | null): void {
  if (!prefill) return;
  partition.value = prefill.partition === null || prefill.partition >= props.topic.partitions ? 'auto' : String(prefill.partition);
  valueFormat.value = formats.value.some((f) => f.value === prefill.valueFormat) ? prefill.valueFormat : 'string';
  keyNull.value = prefill.key === null;
  key.value = prefill.key ?? '';
  value.value = prefill.value;
  headers.value = prefill.headers;
  count.value = '1';
  error.value = null;
}
apply(props.prefill);
watch(() => props.prefill, apply);

const template = computed(
  (): KafkaProduceTemplate => ({
    partition: partition.value === 'auto' ? null : Number(partition.value),
    key: keyNull.value ? null : key.value,
    value: value.value,
    headers: headers.value,
    count: Number(count.value.replace(/[,_\s]/g, '') || NaN),
    valueFormat: valueFormat.value,
  }),
);
const problem = computed(() => produceProblem(template.value, props.topic.partitions));
const valueNote = computed((): { text: string; ok: boolean } | null => {
  const bad = valueProblem(value.value, valueFormat.value) !== null;
  if (valueFormat.value === 'json' || valueFormat.value === 'avro') return { text: bad ? '· not valid JSON' : '· valid JSON', ok: !bad };
  if (valueFormat.value === 'int64') return bad ? { text: '· not a whole number', ok: false } : null;
  return null;
});
const label = computed(() => (template.value.count > 1 ? `Produce ${num(template.value.count)} messages` : 'Produce message'));

async function send(): Promise<void> {
  if (problem.value || busy.value) return;
  busy.value = true;
  error.value = null;
  const result = await ws.write({ kind: 'produce', topic: props.topic.name, template: template.value }, { quiet: true });
  busy.value = false;
  if (!result.ok) error.value = result.message;
}
</script>

<template>
  <aside class="produce" aria-label="Produce">
    <div class="title">
      <span class="caps">Produce to <span class="mono topic">{{ topic.name }}</span></span>
      <IconButton icon="close" label="Close produce" class="close" @click="emit('close')" />
    </div>
    <div class="row">
      <label class="field">
        Partition
        <select v-model="partition" class="fld">
          <option value="auto">Auto</option>
          <option v-for="p in topic.partitions" :key="p" :value="String(p - 1)">{{ p - 1 }}</option>
        </select>
      </label>
      <label class="field">
        Value as
        <select v-model="valueFormat" class="fld">
          <option v-for="f in formats" :key="f.value" :value="f.value">{{ f.label }}</option>
        </select>
      </label>
    </div>
    <div class="field">
      <label for="produce-key">Key</label>
      <div class="key">
        <input id="produce-key" v-model="key" class="fld mono" :disabled="keyNull" spellcheck="false" autocomplete="off" />
        <label class="check null"><input v-model="keyNull" type="checkbox" /> null</label>
      </div>
    </div>
    <label class="field">
      <span>Value <span v-if="valueNote" :class="valueNote.ok ? 't-ok' : 't-error'">{{ valueNote.text }}</span></span>
      <textarea v-model="value" class="fld mono value" spellcheck="false" />
    </label>
    <label class="field">
      <span>Headers <span class="hint">one per line, name=value</span></span>
      <textarea v-model="headers" class="fld mono headers" spellcheck="false" />
    </label>
    <div class="count-row">
      <label class="field count">
        Count
        <input v-model="count" class="fld mono" inputmode="numeric" />
      </label>
      <span class="placeholders">Placeholders: <span class="mono">{{ PRODUCE_PLACEHOLDERS.join(' ') }}</span></span>
    </div>
    <p v-if="error" class="error-line" role="alert"><Icon name="error" :size="14" /> {{ error }}</p>
    <p v-else-if="problem" class="t-error problem">{{ problem }}</p>
    <button type="button" class="btn btn-primary send" :disabled="!!problem || busy" @click="send">{{ busy ? 'Producing…' : label }}</button>
  </aside>
</template>

<style scoped>
.produce {
  flex: 1 1 300px;
  max-width: 400px;
  min-width: 0;
  box-sizing: border-box;
  height: 100%;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 16px;
  overflow: auto;
  border-left: 1px solid var(--k-border);
  background: var(--k-surface);
}
.title {
  display: flex;
  align-items: center;
  gap: 8px;
}
.topic {
  text-transform: none;
  letter-spacing: 0;
  color: var(--vscode-foreground);
}
.close {
  margin-left: auto;
  width: 24px;
  height: 24px;
}
.produce .row > .field {
  flex-basis: 100px;
}
.key {
  display: flex;
  align-items: center;
  gap: 8px;
}
.key .fld {
  flex: 1;
}
.null {
  font-weight: 400;
  color: var(--k-muted);
}
.value {
  min-height: 150px;
}
.headers {
  min-height: 52px;
}
.count-row {
  display: flex;
  align-items: flex-end;
  gap: 10px;
}
.count {
  flex: 0 0 110px;
}
.placeholders {
  flex: 1;
  font-size: 11px;
  line-height: 1.5;
  color: var(--k-muted);
}
.problem {
  margin: 0;
  font-size: 12px;
}
.send {
  align-self: flex-start;
}
@media (max-width: 860px) {
  .produce {
    max-width: none;
    height: auto;
    border-left: 0;
    border-top: 1px solid var(--k-border);
  }
}
</style>
