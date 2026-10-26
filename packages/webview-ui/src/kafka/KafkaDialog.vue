<script lang="ts">
/** Open dialogs, newest last; only the newest answers Escape. */
const open: symbol[] = [];
</script>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import Icon from '../components/Icon.vue';
import IconButton from '../components/IconButton.vue';
import type { WriteResult } from './workspace';

/**
 * A modal dialog with Cancel and a primary button. The primary runs `action`, waits for the write's answer and closes
 * when it worked; a failure is shown above the buttons and the dialog stays open.
 */
const props = withDefaults(
  defineProps<{ title: string; primary: string; action: () => Promise<WriteResult>; danger?: boolean; disabled?: boolean; wide?: boolean }>(),
  { danger: false, disabled: false, wide: false },
);
const emit = defineEmits<{ close: []; done: [] }>();

const busy = ref(false);
const error = ref<string | null>(null);
const body = ref<HTMLElement>();

async function submit(): Promise<void> {
  if (props.disabled || busy.value) return;
  busy.value = true;
  error.value = null;
  const result = await props.action();
  busy.value = false;
  if (result.ok) {
    emit('done');
    emit('close');
  } else error.value = result.message;
}

function close(): void {
  if (!busy.value) emit('close');
}

const id = Symbol('dialog');

function onKey(event: KeyboardEvent): void {
  if (event.key === 'Escape' && open[open.length - 1] === id) {
    event.stopPropagation();
    close();
  }
}

let before: Element | null = null;
onMounted(async () => {
  before = document.activeElement;
  open.push(id);
  document.addEventListener('keydown', onKey, true);
  await nextTick();
  const first = body.value?.querySelector<HTMLElement>('input:not([disabled]), select, textarea, [contenteditable="true"]');
  (first ?? body.value?.querySelector<HTMLElement>('button'))?.focus();
});
onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKey, true);
  open.splice(open.indexOf(id), 1);
  if (before instanceof HTMLElement) before.focus();
});
</script>

<template>
  <div class="overlay" @mousedown.self="close">
    <form ref="body" role="dialog" aria-modal="true" :aria-label="title" class="dialog" :class="{ wide }" @submit.prevent="submit">
      <div class="head">
        <h2>{{ title }}</h2>
        <IconButton icon="close" label="Close dialog" class="close" @click="close" />
      </div>
      <slot />
      <p v-if="error" class="failure" role="alert"><Icon name="error" :size="14" /> {{ error }}</p>
      <div class="foot">
        <slot name="foot-start" />
        <button type="button" class="btn cancel" @click="close">Cancel</button>
        <button type="submit" class="btn" :class="danger ? 'danger' : 'btn-primary'" :disabled="disabled || busy">{{ busy ? 'Working…' : primary }}</button>
      </div>
    </form>
  </div>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  z-index: 20;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 72px 16px 16px;
  overflow: auto;
  background: var(--vscode-widget-shadow, color-mix(in srgb, var(--vscode-editor-background) 55%, transparent));
}
.dialog {
  box-sizing: border-box;
  width: min(560px, 100%);
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 18px 20px;
  border: 1px solid var(--vscode-editorWidget-border, var(--vscode-panel-border));
  border-radius: 8px;
  background: var(--vscode-editorWidget-background);
  color: var(--vscode-editorWidget-foreground, var(--vscode-foreground));
  box-shadow: 0 12px 32px var(--vscode-widget-shadow, transparent);
}
.dialog.wide {
  width: min(760px, 100%);
}
.head {
  display: flex;
  align-items: center;
}
h2 {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  overflow-wrap: anywhere;
}
.close {
  margin-left: auto;
}
.failure {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--vscode-errorForeground);
  white-space: pre-wrap;
}
.foot {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.cancel {
  margin-left: auto;
}
</style>
