<script lang="ts">
/** What a dialog's primary action came to; a failure keeps the dialog open and shows `message`. */
export interface ActionResult {
  ok: boolean;
  message: string;
}

/** Open dialogs, newest last; only the newest answers Escape. */
const open: symbol[] = [];
</script>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import Icon from './Icon.vue';
import IconButton from './IconButton.vue';

/**
 * A modal dialog. With an `action`, it has Cancel and a primary button that runs the action, waits for its answer and
 * closes when it worked; a failure is shown above the buttons and the dialog stays open. Without one it only has Close.
 * Content styles (fields, rows) come from the screen that opens it.
 */
const props = withDefaults(
  defineProps<{ title: string; primary?: string; action?: () => Promise<ActionResult>; danger?: boolean; disabled?: boolean; wide?: boolean }>(),
  { primary: 'OK', action: undefined, danger: false, disabled: false, wide: false },
);
const emit = defineEmits<{ close: []; done: [] }>();

const busy = ref(false);
const error = ref<string | null>(null);
const body = ref<HTMLElement>();

async function submit(): Promise<void> {
  if (!props.action || props.disabled || busy.value) return;
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
  // The first field; without one, the primary button, or Cancel when the primary is destructive.
  const first = body.value?.querySelector<HTMLElement>('input:not([disabled]), select, textarea, [contenteditable="true"]');
  const button = body.value?.querySelector<HTMLElement>(props.danger ? '.foot .cancel' : '.foot [type="submit"]:not([disabled]), .foot .cancel');
  (first ?? button)?.focus();
});
onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKey, true);
  open.splice(open.indexOf(id), 1);
  if (before instanceof HTMLElement) before.focus();
});

defineExpose({ submit });
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
        <template v-if="action">
          <button type="button" class="btn cancel" @click="close">Cancel</button>
          <button type="submit" class="btn" :class="danger ? 'danger' : 'btn-primary'" :disabled="disabled || busy">{{ busy ? 'Working…' : primary }}</button>
        </template>
        <button v-else type="button" class="btn cancel" @click="close">Close</button>
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
  padding: 56px 16px 16px;
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
  width: min(780px, 100%);
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
  overflow-wrap: anywhere;
}
.failure .icon {
  margin-top: 2px;
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
.btn.danger {
  border-color: transparent;
  background: var(--vscode-statusBarItem-errorBackground, var(--vscode-errorForeground));
  color: var(--vscode-statusBarItem-errorForeground, var(--vscode-button-foreground));
}
.btn.danger:hover:not(:disabled) {
  background: color-mix(in srgb, var(--vscode-statusBarItem-errorBackground, var(--vscode-errorForeground)) 85%, var(--vscode-editor-background));
}
</style>
