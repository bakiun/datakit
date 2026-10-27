<script setup lang="ts">
import type { MongoDocument } from '@datakit/core';
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import ConfirmDialog from '../components/ConfirmDialog.vue';
import Icon from '../components/Icon.vue';
import IconButton from '../components/IconButton.vue';
import { SUBMIT_KEY } from '../components/shortcuts';
import { useCollection } from './collection';
import { formatBytes } from './format';
import ShellCode from './ShellCode.vue';

/**
 * The picked document in an editor. Save replaces the whole document (its `_id` stays), Revert goes back to the read
 * text. Documents cut short (over 1 MiB) and read-only collections are shown read-only.
 * `focusRequest` focuses the editor whenever it changes, e.g. after Edit on a card. `dirty` tells the page whether
 * there are unsaved edits, so it can ask before they would be dropped.
 */
const props = defineProps<{ document: MongoDocument; readOnlyReason: string | null; focusRequest: number }>();
const emit = defineEmits<{ close: []; deleted: []; dirty: [dirty: boolean] }>();
const col = useCollection();

const original = ref(props.document.text);
const draft = ref(props.document.text);
const saving = ref(false);
const error = ref<string | null>(null);
/** The document changed on the server while there were edits here. */
const stale = ref(false);
const deleting = ref(false);
/** A quiet “Saved” beside the buttons, until the next edit or a few seconds later. */
const saved = ref(false);
let savedTimer: ReturnType<typeof setTimeout> | undefined;
const editor = ref<InstanceType<typeof ShellCode>>();

const locked = computed(() => props.readOnlyReason !== null || props.document.truncated || !props.document.id);
const dirty = computed(() => draft.value !== original.value);
watch(dirty, (value) => {
  emit('dirty', value);
  if (value) saved.value = false;
});
onBeforeUnmount(() => {
  clearTimeout(savedTimer);
  emit('dirty', false);
});
const note = computed(() => {
  if (props.document.truncated) return 'This document is over 1 MiB: only its start is shown, and it cannot be edited here.';
  if (!props.document.id) return 'This document has no _id, so it cannot be saved.';
  return null;
});

watch(
  () => props.document.id,
  () => {
    original.value = draft.value = props.document.text;
    error.value = null;
    stale.value = false;
    saved.value = false;
  },
);
watch(
  () => props.document.text,
  (text) => {
    if (text === original.value) return;
    if (!dirty.value) draft.value = text;
    else stale.value = true;
    original.value = text;
  },
);
watch(
  () => props.focusRequest,
  () => void nextTick(() => editor.value?.focus(0)),
);

async function save(): Promise<void> {
  if (locked.value || !dirty.value || saving.value) return;
  saving.value = true;
  error.value = null;
  const sent = draft.value;
  const result = await col.write({ kind: 'replace', id: props.document.id!, text: sent }, { quiet: true });
  saving.value = false;
  if (result.ok) {
    original.value = sent;
    stale.value = false;
    saved.value = true;
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => (saved.value = false), 3000);
  } else error.value = result.message || null;
}

function revert(): void {
  draft.value = original.value;
  error.value = null;
  stale.value = false;
}

function deleteAction() {
  return col.write({ kind: 'delete', ids: [props.document.id!] }, { quiet: true }).then((result) => {
    if (result.ok) emit('deleted');
    return result;
  });
}
</script>

<template>
  <section class="document-pane" aria-label="Document">
    <div class="bar">
      <span class="caps">Document</span>
      <span class="mono id" :title="document.idText ?? ''">{{ document.idText ?? 'no _id' }}</span>
      <span class="size">{{ formatBytes(document.size) }}</span>
      <span class="spacer" />
      <IconButton icon="copy" label="Copy the document" @click="col.copy(draft, `the document ${document.idText ?? ''}`.trim())" />
      <IconButton v-if="!readOnlyReason && document.id" icon="trash" label="Delete the document" tone="danger" @click="deleting = true" />
      <IconButton icon="close" label="Close the document pane" @click="emit('close')" />
    </div>
    <p v-if="note" class="warn-line pad">{{ note }}</p>
    <div class="editor">
      <ShellCode ref="editor" v-model="draft" :read-only="locked" label="Document in shell syntax" @run="save" />
    </div>
    <p v-if="stale" class="warn-line pad">The document changed on the server while you edited it. Revert to see the new version.</p>
    <p v-if="error" class="error-line pad" role="alert"><Icon name="error" :size="14" /> Not saved: {{ error }}</p>
    <div v-if="!locked" class="actions">
      <button type="button" class="btn sm btn-primary" :disabled="!dirty || saving" :title="`Replace the document (${SUBMIT_KEY})`" @click="save">
        {{ saving ? 'Saving…' : 'Save' }}
      </button>
      <button type="button" class="btn sm" :disabled="(!dirty && !stale) || saving" @click="revert">Revert</button>
      <span v-if="dirty" class="t-warn changed">Changed — not saved yet</span>
      <span v-else-if="saved" class="t-muted changed" role="status">Saved</span>
    </div>

    <ConfirmDialog
      v-if="deleting"
      title="Delete document"
      :text="`Delete the document ${document.idText ?? ''}? This cannot be undone.`"
      primary="Delete document"
      :action="deleteAction"
      @close="deleting = false"
    />
  </section>
</template>

<style scoped>
.document-pane {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  background: var(--m-surface);
}
.bar {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 32px;
  padding: 2px 4px 2px 12px;
  border-bottom: 1px solid var(--m-border);
  background: var(--m-head);
}
.id {
  min-width: 0;
  overflow: hidden;
  color: var(--vscode-symbolIcon-typeParameterForeground);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.size {
  flex: none;
  font-size: 12px;
  color: var(--m-muted);
}
.spacer {
  flex: 1;
}
.editor {
  flex: 1;
  min-height: 120px;
  overflow: hidden;
  border-bottom: 1px solid var(--m-border);
  background: var(--vscode-editor-background);
}
.pad {
  padding: 6px 12px;
}
.actions {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
}
.changed {
  font-size: 12px;
}
</style>
