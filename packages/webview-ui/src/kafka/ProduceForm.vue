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
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import Icon from '../components/Icon.vue';
import IconButton from '../components/IconButton.vue';
import { isSubmitShortcut, SUBMIT_KEY } from '../components/shortcuts';
import { num, prettyJson } from './format';
import { useWorkspace, type ProduceDraft } from './workspace';

/** What Edit & re-produce puts into the form. */
export interface ProducePrefill {
  partition: number | null;
  key: string | null;
  value: string;
  headers: string;
  valueFormat: KafkaValueFormat;
}

/**
 * Produces one message, or `count` copies with the placeholders filled in per message. The form keeps what was typed
 * per topic while the workspace is open; a topic's first form starts from its newest message, in its format.
 */
const props = defineProps<{ topic: KafkaTopicDetail; prefill: ProducePrefill | null; sample: KafkaMessage | null }>();
const emit = defineEmits<{ close: [] }>();
const ws = useWorkspace();

const EXAMPLE = '{\n  "id": "${uuid}",\n  "count": ${counter},\n  "createdAt": "${now}"\n}';
const formats = computed(() => KAFKA_VALUE_FORMATS.filter((f) => f.value !== 'avro' || ws.state.init!.schemaRegistryUrl !== null));

/** The first form of a topic: its newest message's value and format, or a JSON example for an empty topic. */
function initialDraft(): ProduceDraft {
  const v = props.sample?.value;
  const text = v ? (v.decoded ?? (v.binary ? null : v.text)) : null;
  const pretty = text === null ? null : prettyJson(text);
  // Schema values are Avro unless the topic's format says JSON Schema or Protobuf, which the form cannot write.
  const label = ws.state.formats[props.topic.name] ?? '';
  const avro = !!v && v.schemaId !== null && v.decoded !== null && ws.state.init!.schemaRegistryUrl !== null && !/^(JSON Schema|Protobuf)/.test(label);
  const valueFormat: KafkaValueFormat = avro ? 'avro' : pretty !== null || text === null ? 'json' : 'string';
  return { partition: 'auto', valueFormat, key: 'key-${counter}', keyNull: false, value: pretty ?? text ?? EXAMPLE, headers: '', count: '1' };
}

const draft = ref<ProduceDraft>({ ...(ws.memory.produce.get(props.topic.name) ?? initialDraft()) });
const busy = ref(false);
const error = ref<string | null>(null);
/** What the last produce did, shown under the button until the form changes. */
const done = ref<string | null>(null);
const valueField = ref<HTMLTextAreaElement>();

function apply(prefill: ProducePrefill | null): void {
  if (!prefill) return;
  draft.value = {
    partition: prefill.partition === null || prefill.partition >= props.topic.partitions ? 'auto' : String(prefill.partition),
    valueFormat: formats.value.some((f) => f.value === prefill.valueFormat) ? prefill.valueFormat : 'string',
    keyNull: prefill.key === null,
    key: prefill.key ?? '',
    value: prefill.value,
    headers: prefill.headers,
    count: '1',
  };
  error.value = null;
  void nextTick(() => valueField.value?.focus());
}
apply(props.prefill);
watch(() => props.prefill, apply);
watch(
  draft,
  (d) => {
    ws.memory.produce.set(props.topic.name, { ...d });
    done.value = null;
  },
  { deep: true },
);
onMounted(() => valueField.value?.focus());

const template = computed(
  (): KafkaProduceTemplate => ({
    partition: draft.value.partition === 'auto' ? null : Number(draft.value.partition),
    key: draft.value.keyNull ? null : draft.value.key,
    value: draft.value.value,
    headers: draft.value.headers,
    count: Number(draft.value.count.replace(/[,_\s]/g, '') || NaN),
    valueFormat: draft.value.valueFormat,
  }),
);
const problem = computed(() => produceProblem(template.value, props.topic.partitions));
const valueNote = computed((): { text: string; ok: boolean } | null => {
  const format = draft.value.valueFormat;
  const bad = valueProblem(draft.value.value, format) !== null;
  if (format === 'json' || format === 'avro') return { text: bad ? '· not valid JSON' : '· valid JSON', ok: !bad };
  if (format === 'int64') return bad ? { text: '· not a whole number', ok: false } : null;
  return null;
});
const label = computed(() => (template.value.count > 1 ? `Produce ${num(template.value.count)} messages` : 'Produce message'));

async function send(): Promise<void> {
  if (problem.value || busy.value) return;
  busy.value = true;
  error.value = null;
  // The new rows show in the table and the result under the button, so no toast repeats it.
  const result = await ws.write({ kind: 'produce', topic: props.topic.name, template: template.value }, { quiet: true, announce: false });
  busy.value = false;
  if (result.ok) done.value = result.message;
  else if (!result.cancelled) error.value = result.message;
}

/** ⌘Enter (Ctrl+Enter off macOS) sends from the value and headers too; Escape closes the form, which keeps what was typed. */
function onKey(event: KeyboardEvent): void {
  if (isSubmitShortcut(event)) {
    event.preventDefault();
    void send();
  } else if (event.key === 'Escape') {
    event.stopPropagation();
    emit('close');
  }
}
</script>

<template>
  <form class="produce" aria-label="Produce" @submit.prevent="send" @keydown="onKey">
    <div class="title">
      <span class="caps">Produce to <span class="mono topic">{{ topic.name }}</span></span>
      <IconButton icon="close" label="Close produce" class="close" @click="emit('close')" />
    </div>
    <div class="row">
      <label class="field">
        Partition
        <select v-model="draft.partition" class="fld">
          <option value="auto">Auto</option>
          <option v-for="p in topic.partitions" :key="p" :value="String(p - 1)">{{ p - 1 }}</option>
        </select>
      </label>
      <label class="field">
        Value as
        <select v-model="draft.valueFormat" class="fld">
          <option v-for="f in formats" :key="f.value" :value="f.value">{{ f.label }}</option>
        </select>
      </label>
    </div>
    <div class="field">
      <label for="produce-key">Key</label>
      <div class="key">
        <input id="produce-key" v-model="draft.key" class="fld mono" :disabled="draft.keyNull" spellcheck="false" autocomplete="off" />
        <label class="check null"><input v-model="draft.keyNull" type="checkbox" /> null</label>
      </div>
    </div>
    <label class="field">
      <span>Value <span v-if="valueNote" :class="valueNote.ok ? 't-ok' : 't-error'">{{ valueNote.text }}</span></span>
      <textarea ref="valueField" v-model="draft.value" class="fld mono value" spellcheck="false" />
    </label>
    <label class="field">
      <span>Headers <span class="hint">one per line, name=value</span></span>
      <textarea v-model="draft.headers" class="fld mono headers" placeholder="trace-id=${uuid}" spellcheck="false" />
    </label>
    <div class="count-row">
      <label class="field count">
        Count
        <input v-model="draft.count" class="fld mono" inputmode="numeric" />
      </label>
      <span class="placeholders">Placeholders: <span class="mono">{{ PRODUCE_PLACEHOLDERS.join(' ') }}</span></span>
    </div>
    <p v-if="error" class="error-line" role="alert"><Icon name="error" :size="14" /> {{ error }}</p>
    <p v-else-if="problem" class="t-error problem">{{ problem }}</p>
    <div class="send-row">
      <button type="submit" class="btn btn-primary" :disabled="!!problem || busy" :title="`${label} (${SUBMIT_KEY})`">{{ busy ? 'Producing…' : label }}</button>
      <span v-if="done" class="t-ok done" role="status"><Icon name="check" :size="14" /> {{ done }}</span>
    </div>
  </form>
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
.send-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 10px;
}
.done {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
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
