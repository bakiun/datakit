<script setup lang="ts">
import { computed, ref } from 'vue';
import ModalDialog from '../components/ModalDialog.vue';
import { useCollection } from './collection';
import { MOD_KEY, plural } from './format';
import ShellCode from './ShellCode.vue';

/**
 * updateMany: a filter and an update document or pipeline, both in shell syntax. The filter starts as the one of the
 * shown page; with an empty filter every document is updated, so the collection name has to be typed first.
 */
const props = defineProps<{ filter: string; count: number | null }>();
const emit = defineEmits<{ close: [] }>();
const col = useCollection();

const filter = ref(props.filter);
const update = ref('{ $set: {  } }');
const typed = ref('');
const dialog = ref<InstanceType<typeof ModalDialog>>();

const name = computed(() => col.state.init!.collection);
const everything = computed(() => !filter.value.trim() || /^\{\s*\}$/.test(filter.value.trim()));
const matches = computed(() => (filter.value === props.filter && props.count !== null ? plural(props.count, 'document') : null));
const ready = computed(() => !!update.value.trim() && (!everything.value || typed.value === name.value));

const run = () => col.write({ kind: 'updateMatching', filter: filter.value.trim(), update: update.value }, { quiet: true });
</script>

<template>
  <ModalDialog ref="dialog" title="Update matching documents" primary="Update documents" :disabled="!ready" :action="run" wide @close="emit('close')">
    <label class="field">
      Filter
      <div class="code-box small">
        <ShellCode v-model="filter" compact label="Filter in shell syntax" placeholder='{ status: "pending" }' @run="dialog?.submit()" />
      </div>
      <span v-if="matches" class="hint">Matches {{ matches }}, as the last Find counted.</span>
    </label>
    <label class="field">
      Update
      <div class="code-box large">
        <ShellCode v-model="update" compact label="Update document or pipeline in shell syntax" @run="dialog?.submit()" />
      </div>
      <span class="hint">An update document such as <span class="mono">{ $set: { status: "shipped" } }</span>, or a pipeline in brackets. {{ MOD_KEY }}+Enter runs it.</span>
    </label>
    <template v-if="everything">
      <p class="warn-line">An empty filter updates every document in {{ name }}.</p>
      <label class="field">
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
