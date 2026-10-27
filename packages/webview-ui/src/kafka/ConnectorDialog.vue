<script setup lang="ts">
import type { KafkaWorkspaceHostMessage } from '@datakit/core';
import { computed, onUnmounted, ref } from 'vue';
import CodeView from '../components/CodeView.vue';
import { onHostMessage } from '../host';
import ConfirmDialog from './ConfirmDialog.vue';
import { stringMap } from './format';
import KafkaDialog from './KafkaDialog.vue';
import { useWorkspace } from './workspace';

/** Creates a connector, or edits the config of `name`, which is read first; the edit dialog can also delete it. */
const props = defineProps<{ name: string | null; existing: string[] }>();
const emit = defineEmits<{ close: [] }>();
const ws = useWorkspace();

const EXAMPLE = JSON.stringify(
  {
    'connector.class': 'org.apache.kafka.connect.file.FileStreamSourceConnector',
    'tasks.max': '1',
    file: '/tmp/input.txt',
    topic: 'file-lines',
  },
  null,
  2,
);

const newName = ref('');
const text = ref(props.name ? '' : EXAMPLE);
const loaded = ref(props.name === null);
const deleting = ref(false);

const parsed = computed(() => stringMap(text.value));
const problem = computed(() => {
  if (!props.name) {
    const n = newName.value.trim();
    if (!n) return null;
    if (props.existing.includes(n)) return 'A connector with this name exists.';
  }
  return loaded.value ? parsed.value.error : null;
});
const valid = computed(() => loaded.value && (props.name !== null || (!!newName.value.trim() && !props.existing.includes(newName.value.trim()))) && parsed.value.value !== null);

const save = () => ws.write({ kind: 'saveConnector', name: props.name ?? newName.value.trim(), config: parsed.value.value! }, { quiet: true });
const remove = async () => {
  const result = await ws.write({ kind: 'connector', name: props.name!, action: 'delete' }, { quiet: true });
  if (result.ok) emit('close');
  return result;
};

const stop = onHostMessage<KafkaWorkspaceHostMessage>((message) => {
  if (message.type === 'connectorConfig' && message.name === props.name) {
    text.value = JSON.stringify(message.config, null, 2);
    loaded.value = true;
  }
});
if (props.name) {
  delete ws.state.errors.connectorConfig;
  ws.post({ type: 'connectorConfig', name: props.name });
}
onUnmounted(stop);
</script>

<template>
  <KafkaDialog
    :title="name ? `Edit ${name}` : 'New connector'"
    :primary="name ? 'Save config' : 'Create connector'"
    :disabled="!valid"
    :action="save"
    wide
    @close="emit('close')"
  >
    <label v-if="!name" class="field">
      Name
      <input v-model="newName" class="fld mono" placeholder="s3-sink-refunds" spellcheck="false" autocomplete="off" />
    </label>
    <span class="note">The config is a JSON object of strings{{ name ? '; saving replaces the whole config and restarts the tasks.' : '.' }}</span>
    <p v-if="ws.state.errors.connectorConfig && name" class="error-line" role="alert">{{ ws.state.errors.connectorConfig }}</p>
    <p v-else-if="!loaded" class="empty-state">Reading the config…</p>
    <div v-else class="editor">
      <CodeView v-model="text" language="json" label="Connector config" />
    </div>
    <span v-if="problem" class="t-error problem">{{ problem }}</span>
    <template v-if="name" #foot-start>
      <button type="button" class="btn danger-text" @click="deleting = true">Delete connector…</button>
    </template>
  </KafkaDialog>
  <ConfirmDialog
    v-if="deleting && name"
    :title="`Delete ${name}`"
    text="Deletes the connector and stops its tasks. Its offsets stay in the Connect offsets topic."
    :target="name"
    primary="Delete connector"
    :action="remove"
    @close="deleting = false"
  />
</template>

<style scoped>
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
