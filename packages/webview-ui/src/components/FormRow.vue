<script setup lang="ts">
/** A label column and a wrapping row of controls, as on every tab of the design. */
withDefaults(defineProps<{ label: string; for?: string; labelWidth?: number; top?: boolean }>(), { labelWidth: 130 });
</script>

<template>
  <div class="form-row" :class="{ top }">
    <label :for="$props.for" :style="{ flexBasis: `${labelWidth}px` }">{{ label }}</label>
    <div class="controls">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.form-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 12px;
}
.form-row.top {
  align-items: flex-start;
}
.form-row.top > label {
  padding-top: 6px;
}
label {
  flex: 0 0 auto;
}
.controls {
  flex: 1 1 400px;
  min-width: 0;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 10px;
}
</style>
