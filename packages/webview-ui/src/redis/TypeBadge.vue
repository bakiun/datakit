<script setup lang="ts">
import { computed } from 'vue';
import { typeBadge } from './format';

const props = defineProps<{ type: string }>();
const badge = computed(() => typeBadge(props.type));
</script>

<template>
  <span class="badge" :style="{ color: badge.color }" :title="type">{{ badge.label }}</span>
</template>

<style scoped>
.badge {
  flex: none;
  box-sizing: border-box;
  min-width: 40px;
  padding: 1px 5px;
  border: 1px solid currentColor;
  border-radius: 3px;
  font-family: var(--vscode-editor-font-family);
  font-size: 10px;
  font-weight: 600;
  line-height: 14px;
  text-align: center;
}
</style>
