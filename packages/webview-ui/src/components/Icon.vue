<script setup lang="ts">
import { computed } from 'vue';
import { ICON_PATHS, type IconName } from './icons';

const props = withDefaults(defineProps<{ name: IconName; size?: number; filled?: boolean }>(), { size: 16 });
const path = computed(() => ICON_PATHS[props.name]);
</script>

<template>
  <svg class="icon" :class="{ filled }" viewBox="0 0 24 24" :width="size" :height="size" aria-hidden="true">
    <path :d="path" />
  </svg>
</template>

<style scoped>
.icon {
  flex: none;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.6;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.icon.filled {
  fill: currentColor;
  stroke: none;
}
</style>
