<script setup lang="ts">
import { editProblem, REDIS_KEY_TYPES, type RedisEdit, type RedisKeyType } from '@datakit/core';
import { computed, ref, watch, type Directive } from 'vue';
import FormRow from '../components/FormRow.vue';
import { isSubmitShortcut, SUBMIT_KEY } from '../components/shortcuts';
import { parseTtl } from './format';

/**
 * Creates a key with its first item; Redis has no empty hashes, lists, sets or streams. The name starts with the
 * fixed part of the listed pattern, e.g. `user:` for `user:*`. Enter in a field, or ⌘Enter (Ctrl+Enter off macOS)
 * anywhere in the form, the value included, creates; Esc cancels.
 */
const props = defineProps<{ busy: boolean; error: string | null; prefix: string }>();
const emit = defineEmits<{ create: [edit: RedisEdit]; cancel: [] }>();

const name = ref(props.prefix);
const type = ref<RedisKeyType>('string');
const ttl = ref('');
const first = ref('');
const second = ref('');
/** Focuses the name with the caret after the prefilled prefix. */
const vFocusEnd: Directive<HTMLInputElement> = { mounted: (el) => (el.focus(), el.setSelectionRange(el.value.length, el.value.length)) };

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

const edit = computed((): RedisEdit => {
  const seconds = parseTtl(ttl.value);
  return { kind: 'createKey', key: name.value, type: type.value, ttl: Number.isNaN(seconds) ? -1 : seconds, first: first.value, second: second.value };
});
/**
 * Why the key cannot be created yet, as the tooltip of Create. It is shown in the form only for something typed
 * wrong, such as a TTL or score that cannot be read, not for a field still to be filled in.
 */
const problem = computed(() => editProblem(edit.value));
const missing = computed(() => name.value === '' || ((type.value === 'hash' || type.value === 'stream') && first.value === ''));
const shownProblem = computed(() => (missing.value ? null : problem.value));
/** The name the extension's error was about; the error goes once the name is changed. */
const erredName = ref<string | null>(null);
watch(
  () => props.error,
  (error) => (erredName.value = error ? name.value : null),
);
const shownError = computed(() => (props.error && name.value === erredName.value ? props.error : shownProblem.value));

function create(): void {
  if (!problem.value && !props.busy) emit('create', edit.value);
}

function onKey(event: KeyboardEvent): void {
  if (isSubmitShortcut(event)) {
    event.preventDefault();
    create();
  } else if (event.key === 'Escape' && !event.defaultPrevented && !event.isComposing) emit('cancel');
}
</script>

<template>
  <form class="new-key" aria-label="New key" @submit.prevent="create" @keydown="onKey">
    <h2>New key</h2>
    <FormRow label="Key" for="n-name">
      <input id="n-name" v-model="name" v-focus-end class="fld mono grow" placeholder="e.g. session:1042" spellcheck="false" />
    </FormRow>
    <FormRow label="Type" for="n-type">
      <select id="n-type" class="fld select" :value="type" @change="pickType(($event.target as HTMLSelectElement).value as RedisKeyType)">
        <option v-for="t in REDIS_KEY_TYPES" :key="t" :value="t">{{ t }}</option>
      </select>
    </FormRow>
    <FormRow label="TTL" for="n-ttl">
      <input id="n-ttl" v-model="ttl" class="fld mono ttl" placeholder="none, or e.g. 3600, 30m, 2h" />
    </FormRow>
    <FormRow :label="labels[0]" for="n-first" :top="type === 'string'">
      <textarea v-if="type === 'string'" id="n-first" v-model="first" class="fld mono grow value" spellcheck="false" />
      <input v-else id="n-first" v-model="first" class="fld mono grow" spellcheck="false" />
    </FormRow>
    <FormRow v-if="labels[1]" :label="labels[1]" for="n-second">
      <input id="n-second" v-model="second" class="fld mono grow" spellcheck="false" />
    </FormRow>
    <div class="actions">
      <button type="submit" class="btn btn-primary" :disabled="busy || !!problem" :title="problem ?? `Create (${SUBMIT_KEY})`">Create</button>
      <button type="button" class="btn" @click="emit('cancel')">Cancel</button>
      <span v-if="shownError" class="error" role="alert">{{ shownError }}</span>
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
  flex: 0 1 260px;
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
