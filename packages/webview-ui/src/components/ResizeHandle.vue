<script setup lang="ts">
/**
 * A horizontal splitter that sets the height of the element above it. Drag it, or focus it and use the arrow keys;
 * a double-click restores the default. `change` fires when a resize is finished.
 */
const height = defineModel<number>({ required: true });
const props = defineProps<{ min: number; max: () => number; defaultHeight: number; label: string }>();
const emit = defineEmits<{ change: [height: number] }>();

// The model only shows a new value after the parent re-renders, so the latest one is kept here.
let drag: { y: number; height: number; current: number } | null = null;

const clamp = (value: number) => Math.round(Math.min(Math.max(value, props.min), Math.max(props.min, props.max())));

function start(event: PointerEvent): void {
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  drag = { y: event.clientY, height: height.value, current: height.value };
}

function move(event: PointerEvent): void {
  if (!drag) return;
  drag.current = clamp(drag.height + event.clientY - drag.y);
  height.value = drag.current;
}

function end(): void {
  if (!drag) return;
  emit('change', drag.current);
  drag = null;
}

function set(value: number): void {
  const next = clamp(value);
  height.value = next;
  emit('change', next);
}

function onKey(event: KeyboardEvent): void {
  const step = event.shiftKey ? 60 : 20;
  const next = {
    ArrowUp: height.value - step,
    ArrowDown: height.value + step,
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
    class="resize-handle"
    role="separator"
    aria-orientation="horizontal"
    :aria-label="label"
    :aria-valuenow="height"
    :aria-valuemin="min"
    tabindex="0"
    title="Drag to resize · double-click to reset"
    @pointerdown="start"
    @pointermove="move"
    @pointerup="end"
    @pointercancel="end"
    @dblclick="set(defaultHeight)"
    @keydown="onKey"
  >
    <span class="grip" />
  </div>
</template>

<style scoped>
.resize-handle {
  position: relative;
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  height: 8px;
  cursor: row-resize;
  touch-action: none;
  outline: none;
}
.resize-handle::before {
  content: '';
  position: absolute;
  inset: 3px 0;
  border-radius: 1px;
  background: transparent;
}
.resize-handle:hover::before,
.resize-handle:active::before,
.resize-handle:focus-visible::before {
  background: var(--vscode-sash-hoverBorder, var(--vscode-focusBorder));
}
.grip {
  position: relative;
  width: 32px;
  height: 2px;
  border-radius: 1px;
  background: var(--vscode-descriptionForeground);
  opacity: 0.5;
}
</style>
