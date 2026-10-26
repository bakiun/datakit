<script setup lang="ts">
import { computed } from 'vue';

/**
 * A splitter that sets the size of a neighbouring panel: its height when `direction` is `rows` (a bar between
 * stacked panels), its width when `columns` (a bar between side-by-side panels). By default the panel is before the
 * handle (above or left); `after` sizes the one after it, e.g. a shell at the bottom or a pane on the right.
 * Drag it, or focus it and use the arrow keys; a double-click restores the default. `change` fires when a resize ends.
 */
const size = defineModel<number>({ required: true });
const props = withDefaults(
  defineProps<{ direction?: 'rows' | 'columns'; after?: boolean; min: number; max: () => number; defaultSize: number; label: string }>(),
  { direction: 'rows', after: false },
);
const emit = defineEmits<{ change: [size: number] }>();

// The model only shows a new value after the parent re-renders, so the latest one is kept here.
let drag: { at: number; size: number; current: number } | null = null;

const rows = computed(() => props.direction === 'rows');
const sign = computed(() => (props.after ? -1 : 1));
const clamp = (value: number) => Math.round(Math.min(Math.max(value, props.min), Math.max(props.min, props.max())));
const position = (event: PointerEvent) => (rows.value ? event.clientY : event.clientX);

function start(event: PointerEvent): void {
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  drag = { at: position(event), size: size.value, current: size.value };
}

function move(event: PointerEvent): void {
  if (!drag) return;
  drag.current = clamp(drag.size + sign.value * (position(event) - drag.at));
  size.value = drag.current;
}

function end(): void {
  if (!drag) return;
  emit('change', drag.current);
  drag = null;
}

function set(value: number): void {
  const next = clamp(value);
  size.value = next;
  emit('change', next);
}

function onKey(event: KeyboardEvent): void {
  const step = (event.shiftKey ? 60 : 20) * sign.value;
  const [less, more] = rows.value ? ['ArrowUp', 'ArrowDown'] : ['ArrowLeft', 'ArrowRight'];
  const next = {
    [less]: size.value - step,
    [more]: size.value + step,
    Home: props.min,
    End: props.max(),
  }[event.key];
  if (next === undefined) return;
  event.preventDefault();
  set(next);
}
</script>

<template>
  <div
    class="split-handle"
    :class="direction"
    role="separator"
    :aria-orientation="rows ? 'horizontal' : 'vertical'"
    :aria-label="label"
    :aria-valuenow="size"
    :aria-valuemin="min"
    tabindex="0"
    title="Drag to resize · double-click to reset"
    @pointerdown="start"
    @pointermove="move"
    @pointerup="end"
    @pointercancel="end"
    @dblclick="set(defaultSize)"
    @keydown="onKey"
  >
    <span class="grip" />
  </div>
</template>

<style scoped>
.split-handle {
  position: relative;
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  touch-action: none;
  outline: none;
}
.rows {
  height: 8px;
  cursor: row-resize;
}
.columns {
  width: 8px;
  cursor: col-resize;
}
.split-handle::before {
  content: '';
  position: absolute;
  border-radius: 1px;
  background: transparent;
}
.rows::before {
  inset: 3px 0;
}
.columns::before {
  inset: 0 3px;
}
.split-handle:hover::before,
.split-handle:active::before,
.split-handle:focus-visible::before {
  background: var(--vscode-sash-hoverBorder, var(--vscode-focusBorder));
}
.grip {
  position: relative;
  border-radius: 1px;
  background: var(--vscode-descriptionForeground);
  opacity: 0.5;
}
.rows .grip {
  width: 32px;
  height: 2px;
}
.columns .grip {
  width: 2px;
  height: 32px;
}
</style>
