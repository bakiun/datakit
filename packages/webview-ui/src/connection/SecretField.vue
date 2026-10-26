<script setup lang="ts">
import type { SecretKey } from '@datakit/core';
import { computed } from 'vue';
import { useForm } from './form';

/** Password input: shows a stored secret as hidden and only sends a new value once it is typed. */
const props = withDefaults(defineProps<{ secret: SecretKey; id: string; emptyText?: string; flex?: string }>(), {
  emptyText: '',
  flex: '1 1 200px',
});
const form = useForm();

const value = computed({
  get: () => form.secrets[props.secret],
  set: (v: string) => {
    form.secrets[props.secret] = v;
    form.touched[props.secret] = true;
  },
});
const placeholder = computed(() =>
  form.storedSecrets.value[props.secret] && !form.touched[props.secret] ? '<hidden>' : props.emptyText,
);
</script>

<template>
  <input :id="id" v-model="value" class="fld mono" type="password" autocomplete="off" :placeholder="placeholder" :style="{ flex }" />
</template>
