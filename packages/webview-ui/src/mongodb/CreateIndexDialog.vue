<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import ModalDialog from '../components/ModalDialog.vue';
import { SUBMIT_KEY } from '../components/shortcuts';
import { useCollection } from './collection';
import ShellCode from './ShellCode.vue';

/**
 * createIndex: the key pattern in shell syntax and the index options; an empty name lets the server name it. `keys`
 * is the pattern it starts with, e.g. the fields of a query Explain showed.
 */
const props = withDefaults(defineProps<{ keys?: string }>(), { keys: '{  }' });
const emit = defineEmits<{ close: [] }>();
const col = useCollection();

const keys = ref(props.keys);
const name = ref('');
const unique = ref(false);
const sparse = ref(false);
const hidden = ref(false);
const ttl = ref('');
const partialFilter = ref('');
const keysEditor = ref<InstanceType<typeof ShellCode>>();
// Inside the empty braces, or at the end of given keys; after the dialog has focused its first field.
onMounted(() => setTimeout(() => keysEditor.value?.focus(/^\{\s*\}$/.test(keys.value) ? 2 : keys.value.length), 0));

const keysEmpty = computed(() => /^\{?\s*\}?$/.test(keys.value.trim()));
const ttlSeconds = computed((): number | null | undefined => {
  const t = ttl.value.replace(/[,_\s]/g, '');
  if (!t) return null;
  return /^\d{1,10}$/.test(t) ? Number(t) : undefined;
});
const ttlProblem = computed(() => (ttlSeconds.value === undefined ? 'TTL is a whole number of seconds.' : null));

const create = () =>
  col.write(
    {
      kind: 'createIndex',
      spec: {
        keys: keys.value.trim(),
        name: name.value.trim(),
        unique: unique.value,
        sparse: sparse.value,
        hidden: hidden.value,
        ttlSeconds: ttlSeconds.value ?? null,
        partialFilter: partialFilter.value.trim(),
      },
    },
    { quiet: true },
  );
</script>

<template>
  <ModalDialog title="Create index" primary="Create index" :disabled="keysEmpty || !!ttlProblem" :action="create" @close="emit('close')">
    <label class="field">
      Keys
      <div class="code-box keys">
        <ShellCode ref="keysEditor" v-model="keys" compact label="Index keys in shell syntax" />
      </div>
      <span class="hint">Fields with 1 (ascending), -1 (descending), "text", "2dsphere" or "hashed", e.g. <span class="mono">{ customer: 1, createdAt: -1 }</span>.</span>
    </label>
    <div class="row">
      <label class="field">
        Name
        <input v-model="name" class="fld mono" placeholder="Named by the server" spellcheck="false" autocomplete="off" />
      </label>
      <label class="field">
        TTL (seconds)
        <input v-model="ttl" class="fld mono" :class="{ invalid: ttlProblem }" placeholder="No expiry" inputmode="numeric" autocomplete="off" />
      </label>
    </div>
    <span v-if="ttlProblem" class="t-error problem">{{ ttlProblem }}</span>
    <div class="checks">
      <label class="check"><input v-model="unique" type="checkbox" /> Unique</label>
      <label class="check"><input v-model="sparse" type="checkbox" /> Sparse</label>
      <label class="check"><input v-model="hidden" type="checkbox" /> Hidden from the query planner</label>
    </div>
    <label class="field">
      Partial filter
      <div class="code-box partial">
        <ShellCode v-model="partialFilter" compact label="Partial filter expression in shell syntax" placeholder='{ status: "paid" }' />
      </div>
      <span class="hint">Only documents that match are indexed. Leave it empty to index all. {{ SUBMIT_KEY }} creates the index.</span>
    </label>
  </ModalDialog>
</template>

<style scoped>
.keys,
.partial {
  height: 56px;
}
.checks {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 18px;
  font-size: 12px;
}
.check {
  font-weight: 400;
}
.problem {
  margin-top: -6px;
  font-size: 12px;
}
</style>
