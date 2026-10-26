<script setup lang="ts">
import type { SchemaCompatibility, SchemaVersionDetail, KafkaWorkspaceHostMessage } from '@datakit/core';
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import CodeView from '../components/CodeView.vue';
import Icon from '../components/Icon.vue';
import IconButton from '../components/IconButton.vue';
import { onHostMessage } from '../host';
import ConfirmDialog from './ConfirmDialog.vue';
import { prettyJson } from './format';
import SchemaDialog from './SchemaDialog.vue';
import { useWorkspace } from './workspace';

/** The Schema Registry's subjects; the picked subject shows a version's schema and its compatibility level. */
const ws = useWorkspace();
const s = ws.state;

const LEVELS: SchemaCompatibility[] = ['BACKWARD', 'BACKWARD_TRANSITIVE', 'FORWARD', 'FORWARD_TRANSITIVE', 'FULL', 'FULL_TRANSITIVE', 'NONE'];
const picked = ref<string | null>(null);
const detail = ref<SchemaVersionDetail | null>(null);
const dialog = ref<'new' | 'version' | 'soft' | 'hard' | null>(null);
const busy = ref(false);

const readOnly = computed(() => s.init!.readOnly);
const subjects = computed(() => [...(s.subjects ?? [])].sort((a, b) => a.name.localeCompare(b.name)));
const schemaText = computed(() => {
  const d = detail.value;
  if (!d) return '';
  return d.type === 'PROTOBUF' ? d.schema : (prettyJson(d.schema) ?? d.schema);
});

function open(subject: string, version: number | 'latest' = 'latest'): void {
  if (picked.value !== subject) detail.value = null;
  picked.value = subject;
  delete s.errors.schema;
  ws.post({ type: 'schema', subject, version });
}

watch(subjects, (list) => {
  if (picked.value !== null && list.some((x) => x.name === picked.value)) return;
  picked.value = null;
  detail.value = null;
  if (list[0]) open(list[0].name);
});

async function setCompatibility(event: Event): Promise<void> {
  const d = detail.value;
  if (!d) return;
  const select = event.target as HTMLSelectElement;
  busy.value = true;
  const result = await ws.write({ kind: 'setCompatibility', subject: d.subject, level: select.value ? (select.value as SchemaCompatibility) : null });
  busy.value = false;
  if (result.ok) open(d.subject, d.version);
  else select.value = d.compatibility ?? '';
}

async function setGlobal(event: Event): Promise<void> {
  const select = event.target as HTMLSelectElement;
  busy.value = true;
  const result = await ws.write({ kind: 'setGlobalCompatibility', level: select.value as SchemaCompatibility });
  busy.value = false;
  if (!result.ok) select.value = s.globalCompatibility ?? '';
}

const deleteAction = (permanent: boolean) => async () => {
  const d = detail.value!;
  const result = await ws.write({ kind: 'deleteSchemaVersion', subject: d.subject, version: d.version, permanent }, { quiet: true });
  if (result.ok) {
    // The subject goes with its last version; the reloaded list then picks another one.
    if (d.versions.length > 1) open(d.subject);
    else detail.value = null;
  }
  return result;
};

function registered(subject: string): void {
  open(subject);
}

const stop = onHostMessage<KafkaWorkspaceHostMessage>((message) => {
  if (message.type === 'schema' && message.detail.subject === picked.value) detail.value = message.detail;
});
onMounted(() => {
  ws.load('subjects');
  if (subjects.value[0]) open(subjects.value[0].name);
});
onUnmounted(stop);
</script>

<template>
  <section class="page">
    <header class="page-head">
      <h1>Schema Registry</h1>
      <span class="note mono">{{ s.init!.schemaRegistryUrl }}</span>
      <div class="actions">
        <label class="global note">
          Global compatibility
          <select class="sel" :value="s.globalCompatibility ?? ''" :disabled="readOnly || busy || !s.globalCompatibility" @change="setGlobal">
            <option v-if="!s.globalCompatibility" value="">—</option>
            <option v-for="l in LEVELS" :key="l" :value="l">{{ l }}</option>
          </select>
        </label>
        <IconButton icon="reload" label="Read the subjects again" :disabled="s.loading.subjects" @click="ws.load('subjects')" />
        <button v-if="!readOnly" type="button" class="btn btn-primary" @click="dialog = 'new'"><Icon name="plus" :size="14" /> New schema</button>
      </div>
    </header>
    <div class="page-body split">
      <p v-if="s.errors.subjects" class="error-line wide" role="alert"><Icon name="error" :size="14" /> {{ s.errors.subjects }}</p>
      <div class="subjects table-box" role="listbox" aria-label="Subjects">
        <button
          v-for="x in subjects"
          :key="x.name"
          type="button"
          role="option"
          class="subject mono"
          :aria-selected="x.name === picked"
          :title="`${x.name} · version ${x.latestVersion} · id ${x.latestId}`"
          @click="open(x.name)"
        >
          <span class="name">{{ x.name }}</span>
          <span class="chip tone-muted">{{ x.type }}</span>
        </button>
        <p v-if="!subjects.length" class="empty-state">{{ s.loading.subjects ? 'Reading the subjects…' : 'The registry has no subjects yet.' }}</p>
      </div>

      <div v-if="picked" class="schema">
        <div class="schema-head">
          <span class="mono subject-name">{{ picked }}</span>
          <template v-if="detail">
            <select class="sel" aria-label="Version" :value="detail.version" @change="open(detail.subject, Number(($event.target as HTMLSelectElement).value))">
              <option v-for="v in [...detail.versions].reverse()" :key="v" :value="v">version {{ v }}</option>
            </select>
            <span class="note">id {{ detail.id }} · {{ detail.type }}</span>
            <label class="note compat">
              Compatibility
              <select class="sel" :value="detail.compatibility ?? ''" :disabled="readOnly || busy" @change="setCompatibility">
                <option value="">Use global{{ s.globalCompatibility ? ` (${s.globalCompatibility})` : '' }}</option>
                <option v-for="l in LEVELS" :key="l" :value="l">{{ l }}</option>
              </select>
            </label>
            <div v-if="!readOnly" class="schema-actions">
              <button type="button" class="btn sm" @click="dialog = 'version'">New version</button>
              <button type="button" class="btn sm" @click="dialog = 'soft'">Soft delete</button>
              <button type="button" class="btn sm danger-text" @click="dialog = 'hard'">Hard delete</button>
            </div>
          </template>
        </div>
        <p v-if="s.errors.schema" class="error-line" role="alert"><Icon name="error" :size="14" /> {{ s.errors.schema }}</p>
        <p v-else-if="!detail" class="empty-state">Reading the schema…</p>
        <div v-else class="viewer">
          <CodeView :model-value="schemaText" :language="detail.type === 'PROTOBUF' ? 'text' : 'json'" read-only label="Schema" />
        </div>
      </div>
    </div>

    <SchemaDialog
      v-if="dialog === 'new'"
      :subject="null"
      type="AVRO"
      schema=""
      :existing="subjects.map((x) => x.name)"
      @registered="registered"
      @close="dialog = null"
    />
    <SchemaDialog
      v-else-if="dialog === 'version' && detail"
      :subject="detail.subject"
      :type="detail.type"
      :schema="schemaText"
      :existing="[]"
      @registered="registered"
      @close="dialog = null"
    />
    <ConfirmDialog
      v-else-if="dialog === 'soft' && detail"
      :title="`Soft delete ${detail.subject} v${detail.version}`"
      text="Hides the version from the subject. Consumers can still read it by its id, and a hard delete can remove it for good later."
      primary="Soft delete"
      :action="deleteAction(false)"
      @close="dialog = null"
    />
    <ConfirmDialog
      v-else-if="dialog === 'hard' && detail"
      title="Hard delete schema version"
      text="Permanently removes this schema version. Consumers that still reference its id will fail to deserialize."
      :target="`${detail.subject} v${detail.version}`"
      primary="Delete"
      :action="deleteAction(true)"
      @close="dialog = null"
    />
  </section>
</template>

<style scoped>
.global,
.compat {
  display: flex;
  align-items: center;
  gap: 6px;
}
.split {
  flex-direction: row;
  flex-wrap: wrap;
  align-content: flex-start;
}
.wide {
  flex: 1 1 100%;
}
.subjects {
  flex: 1 1 240px;
  max-width: 320px;
  align-self: flex-start;
  max-height: 100%;
}
.subject {
  display: flex;
  align-items: center;
  gap: 8px;
  box-sizing: border-box;
  width: 100%;
  height: 38px;
  padding: 0 10px;
  border: 0;
  border-bottom: 1px solid var(--k-border);
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}
.subject:last-of-type {
  border-bottom: 0;
}
.subject:hover {
  background: var(--vscode-list-hoverBackground);
}
.subject[aria-selected='true'] {
  background: var(--vscode-list-activeSelectionBackground);
  color: var(--vscode-list-activeSelectionForeground);
}
.subject:focus-visible {
  outline: 1px solid var(--vscode-focusBorder);
  outline-offset: -1px;
}
.name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.schema {
  flex: 3 1 420px;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.schema-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.subject-name {
  font-size: 13px;
  overflow-wrap: anywhere;
}
.schema-actions {
  margin-left: auto;
  display: flex;
  gap: 6px;
}
.viewer {
  height: max(240px, calc(100vh - 260px));
  overflow: hidden;
  border: 1px solid var(--k-border);
  border-radius: 4px;
  background: var(--k-surface);
}
.viewer :deep(.cm-editor),
.viewer :deep(.cm-gutters) {
  background: transparent;
}
</style>
