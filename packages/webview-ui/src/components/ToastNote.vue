<script setup lang="ts">
import { onBeforeUnmount, watch } from 'vue';
import Icon from './Icon.vue';
import IconButton from './IconButton.vue';

export interface Toast {
  /** A new id shows the toast again, even with the same text. */
  id: number;
  text: string;
  error: boolean;
}

/** A write result or notice, bottom right; it goes after a few seconds, unless the pointer rests on it. */
const props = defineProps<{ toast: Toast | null }>();
const emit = defineEmits<{ dismiss: [] }>();
let timer: ReturnType<typeof setTimeout> | undefined;

function pause(): void {
  clearTimeout(timer);
}

function schedule(): void {
  clearTimeout(timer);
  timer = setTimeout(() => emit('dismiss'), props.toast?.error ? 7000 : 3500);
}

watch(
  () => props.toast?.id,
  (id) => (id === undefined ? pause() : schedule()),
  { immediate: true },
);
onBeforeUnmount(() => clearTimeout(timer));
</script>

<template>
  <div v-if="toast" class="toast" :class="{ error: toast.error }" :role="toast.error ? 'alert' : 'status'" @mouseenter="pause" @mouseleave="schedule">
    <Icon :name="toast.error ? 'error' : 'info'" class="sign" />
    <span class="text">{{ toast.text }}</span>
    <IconButton icon="close" label="Dismiss notification" class="dismiss" @click="emit('dismiss')" />
  </div>
</template>

<style scoped>
.toast {
  position: fixed;
  right: 16px;
  bottom: 40px;
  z-index: 30;
  box-sizing: border-box;
  width: min(400px, calc(100% - 32px));
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 8px 10px 14px;
  border: 1px solid var(--vscode-notifications-border, var(--vscode-panel-border));
  border-radius: 6px;
  background: var(--vscode-notifications-background, var(--vscode-editorWidget-background));
  color: var(--vscode-notifications-foreground, var(--vscode-foreground));
  box-shadow: 0 8px 24px var(--vscode-widget-shadow, transparent);
}
.sign {
  margin-top: 1px;
  color: var(--vscode-notificationsInfoIcon-foreground, var(--vscode-textLink-foreground));
}
.error .sign {
  color: var(--vscode-notificationsErrorIcon-foreground, var(--vscode-errorForeground));
}
.text {
  flex: 1;
  min-width: 0;
  padding-top: 1px;
  line-height: 1.45;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
.dismiss {
  width: 22px;
  height: 22px;
}
</style>
