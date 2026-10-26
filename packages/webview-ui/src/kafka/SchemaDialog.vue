<script setup lang="ts">
import type { SchemaType } from '@datakit/core';
import { computed, ref, watch } from 'vue';
import CodeView from '../components/CodeView.vue';
import KafkaDialog from './KafkaDialog.vue';
import { useWorkspace } from './workspace';

/**
 * Registers a schema: a new subject, or a new version of `subject` starting from its current schema. The host checks
 * compatibility with the latest version first and refuses an incompatible schema.
 */
const props = defineProps<{ subject: string | null; type: SchemaType; schema: string; existing: string[] }>();
const emit = defineEmits<{ close: []; registered: [subject: string] }>();
const ws = useWorkspace();

const TYPES: SchemaType[] = ['AVRO', 'JSON', 'PROTOBUF'];
const EXAMPLES: Record<SchemaType, string> = {
  AVRO: JSON.stringify(
    { type: 'record', name: 'OrderRefunded', namespace: 'shop.orders', fields: [{ name: 'order_id', type: 'long' }, { name: 'amount', type: 'double' }, { name: 'reason', type: ['null', 'string'], default: null }] },
    null,
    2,
  ),
  JSON: JSON.stringify(
    { $schema: 'http://json-schema.org/draft-07/schema#', title: 'OrderRefunded', type: 'object', required: ['order_id'], properties: { order_id: { type: 'integer' }, amount: { type: 'number' } } },
    null,
    2,
  ),
  PROTOBUF: 'syntax = "proto3";\npackage shop.orders;\n\nmessage OrderRefunded {\n  int64 order_id = 1;\n  double amount = 2;\n  string reason = 3;\n}\n',
};

const name = ref(props.subject ?? '');
const type = ref<SchemaType>(props.type);
const text = ref(props.subject ? props.schema : EXAMPLES[props.type]);

// A new subject starts from an example of its type; an untouched example follows the type.
watch(type, (now, before) => {
  if (!props.subject && text.value === EXAMPLES[before]) text.value = EXAMPLES[now];
});

const problem = computed(() => {
  if (!props.subject) {
    const n = name.value.trim();
    if (!n) return 'Name the subject, e.g. orders.refunded-value.';
    if (props.existing.includes(n)) return 'This subject exists; open it and register a new version instead.';
  }
  if (!text.value.trim()) return 'Write the schema.';
  if (type.value !== 'PROTOBUF') {
    try {
      JSON.parse(text.value);
    } catch {
      return `${type.value === 'AVRO' ? 'Avro' : 'JSON'} schemas are JSON; this is not valid JSON.`;
    }
  }
  return null;
});
/** The empty name of a new subject is not called out; the disabled button says enough. */
const shownProblem = computed(() => (!props.subject && !name.value.trim() ? null : problem.value));
const suggestions = computed(() => (ws.state.topics ?? []).filter((t) => !t.internal).map((t) => `${t.name}-value`));

async function register() {
  const subject = props.subject ?? name.value.trim();
  const result = await ws.write({ kind: 'registerSchema', subject, schemaType: type.value, schema: text.value }, { quiet: true });
  if (result.ok) emit('registered', subject);
  return result;
}
</script>

<template>
  <KafkaDialog
    :title="subject ? `New version of ${subject}` : 'New schema'"
    :primary="subject ? 'Register version' : 'Register schema'"
    :disabled="!!problem"
    :action="register"
    wide
    @close="emit('close')"
  >
    <div class="row">
      <label v-if="!subject" class="field subject">
        Subject
        <input v-model="name" class="fld mono" placeholder="orders.refunded-value" list="schema-subjects" spellcheck="false" autocomplete="off" />
        <datalist id="schema-subjects">
          <option v-for="x in suggestions" :key="x" :value="x" />
        </datalist>
      </label>
      <label class="field">
        Type
        <select v-model="type" class="fld" :disabled="!!subject">
          <option v-for="t in TYPES" :key="t" :value="t">{{ t }}</option>
        </select>
      </label>
    </div>
    <span v-if="subject" class="note">Starts from the current version. Compatibility is checked before the new version is registered.</span>
    <div class="editor">
      <CodeView v-model="text" :language="type === 'PROTOBUF' ? 'text' : 'json'" label="Schema" />
    </div>
    <span v-if="shownProblem" class="t-error problem">{{ shownProblem }}</span>
  </KafkaDialog>
</template>

<style scoped>
.subject {
  flex: 3 1 260px !important;
}
.editor {
  height: min(360px, 45vh);
  overflow: hidden;
  border: 1px solid var(--vscode-input-border, var(--k-border));
  border-radius: 4px;
}
.editor:focus-within {
  border-color: var(--vscode-focusBorder);
}
.problem {
  font-size: 12px;
}
</style>
