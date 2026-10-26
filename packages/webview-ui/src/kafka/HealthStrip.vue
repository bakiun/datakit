<script setup lang="ts">
import { kafkaHealth } from '@datakit/core';
import { computed, ref } from 'vue';
import Icon from '../components/Icon.vue';
import { formatClock } from './format';
import { useWorkspace } from './workspace';

/** The cluster's health from the last overview; the chevron shows the detail of each item. */
const ws = useWorkspace();
const open = ref(false);
const items = computed(() => (ws.state.overview ? kafkaHealth(ws.state.overview.overview, ws.state.overview.connectors) : []));
const checked = computed(() => (ws.state.overview ? formatClock(ws.state.overview.overview.checkedAt) : null));
</script>

<template>
  <section class="health" aria-label="Health log">
    <button type="button" class="bar" :aria-expanded="open" @click="open = !open">
      <Icon :name="open ? 'down' : 'up'" :size="14" />
      <span class="caps">Health</span>
      <span v-if="ws.state.errors.overview" class="t-error">could not check: {{ ws.state.errors.overview }}</span>
      <span v-else-if="!ws.state.overview" class="t-muted">checking…</span>
      <span v-else-if="!items.length" class="t-ok">healthy</span>
      <span v-for="item in items" :key="item.summary" :class="item.level === 'error' ? 't-error' : 't-warn'">{{ item.summary }}</span>
      <span v-if="checked" class="checked">checked {{ checked }}</span>
    </button>
    <div v-if="open" class="log mono">
      <div v-if="!items.length && ws.state.overview"><span class="time">{{ checked }}</span> no offline or under-replicated partitions, lagging groups or failed connectors</div>
      <div v-for="item in items" :key="item.summary">
        <span class="time">{{ checked }}</span> <span :class="item.level === 'error' ? 't-error' : 't-warn'">{{ item.level }}</span> {{ item.detail }}
      </div>
    </div>
  </section>
</template>

<style scoped>
.health {
  flex: none;
  border-top: 1px solid var(--k-border);
  background: var(--k-surface);
}
.bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 2px 12px;
  box-sizing: border-box;
  width: 100%;
  min-height: 28px;
  padding: 4px 12px;
  border: 0;
  background: transparent;
  color: var(--vscode-foreground);
  font: inherit;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}
.bar:focus-visible {
  outline: 1px solid var(--vscode-focusBorder);
  outline-offset: -1px;
}
.bar .caps {
  color: var(--vscode-foreground);
}
.checked {
  margin-left: auto;
  color: var(--k-muted);
}
.log {
  max-height: 110px;
  overflow: auto;
  padding: 2px 12px 10px 38px;
  line-height: 1.7;
  color: var(--k-muted);
}
.time {
  color: var(--vscode-editorLineNumber-foreground, var(--k-muted));
}
</style>
