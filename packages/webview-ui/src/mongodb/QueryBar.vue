<script lang="ts">
/** The query as the bar holds it; every text is shell syntax, empty for none. */
export interface QueryDraft {
  filter: string;
  projection: string;
  sort: string;
  collation: string;
  skip: string;
}

export const emptyDraft = (): QueryDraft => ({ filter: '', projection: '', sort: '', collation: '', skip: '' });
</script>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import Icon from '../components/Icon.vue';
import { MOD_KEY, parseSkip, type QueryField } from './format';

/**
 * The find query: Filter on top, Project, Sort, Collation and Skip behind Options. Enter or Ctrl/Cmd+Enter in any
 * field runs Find. `invalid` marks the field an error named.
 */
const draft = defineModel<QueryDraft>({ required: true });
const pageSize = defineModel<number>('pageSize', { required: true });
const props = defineProps<{ sizes: number[]; invalid: QueryField | null }>();
const emit = defineEmits<{ find: []; reset: []; explain: [] }>();

const OPTION_FIELDS: { field: Exclude<QueryField, 'filter' | 'skip'>; label: string; placeholder: string }[] = [
  { field: 'projection', label: 'Project', placeholder: '{ status: 1, total: 1 }' },
  { field: 'sort', label: 'Sort', placeholder: '{ createdAt: -1 }' },
  { field: 'collation', label: 'Collation', placeholder: '{ locale: "en", strength: 2 }' },
];

const optionsOpen = ref(false);
const optionCount = computed(() => OPTION_FIELDS.filter((o) => draft.value[o.field].trim()).length + (draft.value.skip.trim() ? 1 : 0));
const skipInvalid = computed(() => parseSkip(draft.value.skip) === null);

// An error in a field behind Options opens them, so the marked field can be seen.
watch(
  () => props.invalid,
  (field) => {
    if (field && field !== 'filter') optionsOpen.value = true;
  },
);

function onKey(event: KeyboardEvent): void {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  emit('find');
}
</script>

<template>
  <div class="query-bar" role="search" aria-label="Find documents">
    <div class="line">
      <label class="qfield filter" :class="{ invalid: invalid === 'filter' }">
        <span class="qlabel">Filter</span>
        <input
          v-model="draft.filter"
          aria-label="Filter in shell syntax"
          placeholder='{ status: "paid" }'
          spellcheck="false"
          autocomplete="off"
          :aria-invalid="invalid === 'filter'"
          @keydown="onKey"
        />
      </label>
      <button type="button" class="btn sm options" :aria-expanded="optionsOpen" @click="optionsOpen = !optionsOpen">
        Options<span v-if="optionCount" class="count">{{ optionCount }}</span>
        <Icon :name="optionsOpen ? 'up' : 'down'" :size="14" />
      </button>
      <div class="actions">
        <select v-model.number="pageSize" class="sel" aria-label="Documents per page">
          <option v-for="n in sizes" :key="n" :value="n">{{ n }} per page</option>
        </select>
        <button type="button" class="btn sm btn-primary" :disabled="skipInvalid" :title="`Find (Enter or ${MOD_KEY}+Enter)`" @click="emit('find')">
          <Icon name="run" :size="12" filled /> Find
        </button>
        <button type="button" class="btn sm" title="Clear the query and find again" @click="emit('reset')">Reset</button>
        <button type="button" class="btn sm" :disabled="skipInvalid" title="Show how the server runs this query" @click="emit('explain')">Explain</button>
      </div>
    </div>
    <div v-if="optionsOpen" class="line options-line">
      <label v-for="o in OPTION_FIELDS" :key="o.field" class="qfield option" :class="{ invalid: invalid === o.field }">
        <span class="qlabel">{{ o.label }}</span>
        <input
          v-model="draft[o.field]"
          :aria-label="`${o.label} in shell syntax`"
          :placeholder="o.placeholder"
          spellcheck="false"
          autocomplete="off"
          :aria-invalid="invalid === o.field"
          @keydown="onKey"
        />
      </label>
      <label class="qfield skip" :class="{ invalid: invalid === 'skip' || skipInvalid }">
        <span class="qlabel">Skip</span>
        <input v-model="draft.skip" aria-label="Documents to skip" placeholder="0" inputmode="numeric" autocomplete="off" @keydown="onKey" />
      </label>
    </div>
  </div>
</template>

<style scoped>
.query-bar {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--m-border);
}
.line {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 8px;
}
.filter {
  flex: 1 1 280px;
}
.options {
  gap: 4px;
}
.count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 16px;
  height: 16px;
  margin-left: 2px;
  padding: 0 4px;
  box-sizing: border-box;
  border-radius: 8px;
  background: var(--vscode-badge-background, var(--vscode-button-background));
  color: var(--vscode-badge-foreground, var(--vscode-button-foreground));
  font-size: 10px;
  font-weight: 600;
}
.actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.option {
  flex: 1 1 200px;
}
.skip {
  flex: 0 1 120px;
}
</style>
