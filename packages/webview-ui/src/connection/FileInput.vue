<script setup lang="ts">
import type { FileField } from '@datakit/core';
import { useForm } from './form';

/** Path input with a Browse… button that opens VS Code's file picker. */
defineProps<{ field: FileField; id: string; placeholder?: string }>();
const model = defineModel<string>({ required: true });
const form = useForm();
</script>

<template>
  <input :id="id" v-model="model" class="fld mono" :class="{ invalid: form.error(field) }" :placeholder="placeholder" spellcheck="false" />
  <button type="button" class="btn" @click="form.browse(field)">Browse…</button>
</template>

<style scoped>
input {
  flex: 1 1 220px;
}
</style>
