<script setup lang="ts">
import Icon from '../components/Icon.vue';
import { useWorkspace } from './workspace';

/** Stars a topic, which pins it under FAVOURITE TOPICS. */
const props = withDefaults(defineProps<{ topic: string; size?: number }>(), { size: 15 });
const ws = useWorkspace();
const on = () => ws.state.favourites.includes(props.topic);
</script>

<template>
  <button
    type="button"
    class="star"
    :class="{ on: on() }"
    :aria-pressed="on()"
    :aria-label="on() ? `Unstar ${topic}` : `Star ${topic}`"
    :title="on() ? 'Unstar' : 'Star to pin under favourite topics'"
    @click.stop="ws.setFavourite(topic, !on())"
  >
    <Icon name="star" :size="size" :filled="on()" />
  </button>
</template>

<style scoped>
.star {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 2px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--vscode-disabledForeground, var(--vscode-descriptionForeground));
  cursor: pointer;
}
.star:hover {
  background: var(--vscode-toolbar-hoverBackground);
}
.star.on {
  color: var(--k-star);
}
.star:focus-visible {
  outline: 1px solid var(--vscode-focusBorder);
}
</style>
