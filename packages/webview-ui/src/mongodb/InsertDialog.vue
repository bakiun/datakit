<script setup lang="ts">
import { onMounted, ref } from 'vue';
import ModalDialog from '../components/ModalDialog.vue';
import { SUBMIT_KEY } from '../components/shortcuts';
import { useCollection } from './collection';
import ShellCode from './ShellCode.vue';

/** Inserts one document, or an array of them, typed in shell syntax; also used to insert a copy of a document. */
const props = defineProps<{ title: string; text: string }>();
const emit = defineEmits<{ close: [] }>();
const col = useCollection();

const draft = ref(props.text);
/** Starts inside the braces of the empty document. */
const start = props.text.indexOf('\n  ') >= 0 ? props.text.indexOf('\n  ') + 3 : props.text.length;
const editor = ref<InstanceType<typeof ShellCode>>();
// After the dialog has focused its first field.
onMounted(() => setTimeout(() => editor.value?.focus(start), 0));

const insert = () => col.write({ kind: 'insert', text: draft.value }, { quiet: true });
</script>

<template>
  <ModalDialog :title="title" primary="Insert" :disabled="!draft.trim()" :action="insert" wide @close="emit('close')">
    <div class="code-box editor">
      <ShellCode ref="editor" v-model="draft" label="Document to insert, in shell syntax" />
    </div>
    <p class="hint">
      One document, or an array of documents. Values in shell syntax: <span class="mono">ObjectId("…")</span>, <span class="mono">ISODate("…")</span>,
      <span class="mono">NumberDecimal("…")</span>. Without an <span class="mono">_id</span> the server adds one. {{ SUBMIT_KEY }} inserts.
    </p>
  </ModalDialog>
</template>

<style scoped>
.editor {
  height: min(340px, 50vh);
}
.hint {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--m-muted);
}
</style>
