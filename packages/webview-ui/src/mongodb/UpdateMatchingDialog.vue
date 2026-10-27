<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import ModalDialog from '../components/ModalDialog.vue';
import { SUBMIT_KEY } from '../components/shortcuts';
import { useCollection } from './collection';
import { plural } from './format';
import ShellCode from './ShellCode.vue';

/**
 * updateMany: a filter and an update document or pipeline, both in shell syntax. The filter starts as the one of the
 * shown page, and the cursor waits inside `$set`. With an empty filter every document is updated: the dialog says so
 * and its button names it; on a production data source the collection name has to be typed as well.
 */
const props = defineProps<{ filter: string; count: number | null }>();
const emit = defineEmits<{ close: [] }>();
const col = useCollection();

const filter = ref(props.filter);
const update = ref('{ $set: {  } }');
const typed = ref('');
const updateEditor = ref<InstanceType<typeof ShellCode>>();
// Inside the braces of $set, after the dialog has focused its first field.
onMounted(() => setTimeout(() => updateEditor.value?.focus(10), 0));

const name = computed(() => col.state.init!.collection);
const production = computed(() => col.state.init!.environment === 'production');
const everything = computed(() => !filter.value.trim() || /^\{\s*\}$/.test(filter.value.trim()));
const matches = computed(() => (filter.value === props.filter && props.count !== null ? plural(props.count, 'document') : null));
const ready = computed(() => !!update.value.trim() && (!everything.value || !production.value || typed.value === name.value));
const primary = computed(() => (everything.value ? 'Update every document' : matches.value ? `Update ${matches.value}` : 'Update documents'));

const run = () => col.write({ kind: 'updateMatching', filter: filter.value.trim(), update: update.value }, { quiet: true });
</script>

<template>
  <ModalDialog title="Update matching documents" :primary="primary" :disabled="!ready" :action="run" wide @close="emit('close')">
    <label class="field">
      Filter
      <div class="code-box small">
        <ShellCode v-model="filter" compact label="Filter in shell syntax" placeholder='{ status: "pending" }' />
      </div>
      <span v-if="matches" class="hint">Matches {{ matches }}, as the last Find counted.</span>
    </label>
    <label class="field">
      Update
      <div class="code-box large">
        <ShellCode ref="updateEditor" v-model="update" compact label="Update document or pipeline in shell syntax" />
      </div>
      <span class="hint">An update document such as <span class="mono">{ $set: { status: "shipped" } }</span>, or a pipeline in brackets. {{ SUBMIT_KEY }} runs it.</span>
    </label>
    <template v-if="everything">
      <p class="warn-line">An empty filter updates every document in {{ name }}.</p>
      <label v-if="production" class="field">
        <span class="hint">Type <span class="mono name">{{ name }}</span> to confirm</span>
        <input v-model="typed" class="fld mono" aria-label="Type the collection name to confirm" spellcheck="false" autocomplete="off" />
      </label>
    </template>
  </ModalDialog>
</template>

<style scoped>
.small {
  height: 64px;
}
.large {
  height: 120px;
}
.name {
  color: var(--vscode-foreground);
}
</style>
