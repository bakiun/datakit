<script setup lang="ts">
import { REDIS_KEY_TYPES, type RedisEdit, type RedisKeyType } from '@datakit/core';
import { computed, ref } from 'vue';
import FormRow from '../components/FormRow.vue';

/** Creates a key with its first item; Redis has no empty hashes, lists, sets or streams. */
defineProps<{ busy: boolean; error: string | null }>();
const emit = defineEmits<{ create: [edit: RedisEdit]; cancel: [] }>();

const name = ref('');
const type = ref<RedisKeyType>('string');
const ttl = ref('');
const first = ref('');
const second = ref('');

const labels = computed((): [string, string | null] => {
  switch (type.value) {
    case 'string':
      return ['Value', null];
    case 'hash':
      return ['Field', 'Value'];
    case 'list':
      return ['First element', null];
    case 'set':
      return ['First member', null];
    case 'zset':
      return ['First member', 'Score'];
    case 'stream':
      return ['Field', 'Value'];
  }
});

function pickType(next: RedisKeyType): void {
  type.value = next;
  second.value = next === 'zset' ? '0' : '';
}

function create(): void {
  const seconds = ttl.value.trim() === '' ? null : Number(ttl.value.trim());
  emit('create', { kind: 'createKey', key: name.value, type: type.value, ttl: Number.isNaN(seconds) ? -1 : seconds, first: first.value, second: second.value });
}
</script>

<template>
  <form class="new-key" aria-label="New key" @submit.prevent="create">
    <h2>New key</h2>
    <FormRow label="Key" for="n-name">
      <input id="n-name" v-model="name" class="fld mono grow" placeholder="e.g. session:1042" spellcheck="false" autofocus />
    </FormRow>
    <FormRow label="Type" for="n-type">
      <select id="n-type" class="fld select" :value="type" @change="pickType(($event.target as HTMLSelectElement).value as RedisKeyType)">
        <option v-for="t in REDIS_KEY_TYPES" :key="t" :value="t">{{ t }}</option>
      </select>
    </FormRow>
    <FormRow label="TTL (s)" for="n-ttl">
      <input id="n-ttl" v-model="ttl" class="fld mono ttl" placeholder="empty = no expiry" inputmode="numeric" />
    </FormRow>
    <FormRow :label="labels[0]" for="n-first" :top="type === 'string'">
      <textarea v-if="type === 'string'" id="n-first" v-model="first" class="fld mono grow value" spellcheck="false" />
      <input v-else id="n-first" v-model="first" class="fld mono grow" spellcheck="false" />
    </FormRow>
    <FormRow v-if="labels[1]" :label="labels[1]" for="n-second">
      <input id="n-second" v-model="second" class="fld mono grow" spellcheck="false" />
    </FormRow>
    <div class="actions">
      <button type="submit" class="btn btn-primary" :disabled="busy">Create</button>
      <button type="button" class="btn" @click="emit('cancel')">Cancel</button>
      <span v-if="error" class="error" role="alert">{{ error }}</span>
    </div>
  </form>
</template>

<style scoped>
.new-key {
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-width: 720px;
  padding: 8px 16px;
}
h2 {
  margin: 0 0 4px;
  font-size: 14px;
  font-weight: 600;
}
.ttl {
  flex: 0 1 200px;
}
.value {
  height: 120px;
  padding-top: 6px;
  resize: vertical;
}
.actions {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-left: 130px;
}
.error {
  font-size: 12px;
  color: var(--vscode-errorForeground);
}
</style>
