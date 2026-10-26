<script setup lang="ts">
import { onBeforeUnmount, watch } from 'vue';
import Icon from '../components/Icon.vue';
import IconButton from '../components/IconButton.vue';
import { useWorkspace } from './workspace';

/** The last write result or notice, bottom right; it goes after a few seconds, unless the pointer rests on it. */
const ws = useWorkspace();
let timer: ReturnType<typeof setTimeout> | undefined;

function pause(): void {
  clearTimeout(timer);
}

function schedule(): void {
  clearTimeout(timer);
  timer = setTimeout(() => (ws.state.toast = null), 3500);
}

watch(
  () => ws.state.toast?.id,
  (id) => (id === undefined ? pause() : schedule()),
);
onBeforeUnmount(() => clearTimeout(timer));
</script>

<template>
  <div
    v-if="ws.state.toast"
    class="toast"
    :class="{ error: ws.state.toast.error }"
    :role="ws.state.toast.error ? 'alert' : 'status'"
    @mouseenter="pause"
    @mouseleave="schedule"
  >
    <Icon :name="ws.state.toast.error ? 'error' : 'info'" class="sign" />
    <span class="text">{{ ws.state.toast.text }}</span>
    <IconButton icon="close" label="Dismiss notification" class="dismiss" @click="ws.state.toast = null" />
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
