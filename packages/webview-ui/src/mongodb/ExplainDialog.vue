<script setup lang="ts">
import { computed } from 'vue';
import Icon from '../components/Icon.vue';
import IconButton from '../components/IconButton.vue';
import ModalDialog from '../components/ModalDialog.vue';
import { useCollection, type ExplainView } from './collection';
import { num } from './format';
import ShellCode from './ShellCode.vue';

/** How the server runs a find or a pipeline: the winning plan's stages, the index it uses, what it read, and the full output. */
const props = defineProps<{ view: ExplainView }>();
const emit = defineEmits<{ close: [] }>();
const col = useCollection();

const e = computed(() => props.view.explain);
/** Documents read per document returned; a high ratio means the query reads far more than it needs. */
const ratio = computed(() => {
  const x = e.value;
  if (!x || !x.docsExamined) return null;
  return x.returned ? x.docsExamined / x.returned : Infinity;
});
const facts = computed(() => {
  const x = e.value;
  if (!x) return [];
  return [
    { label: 'Returned', value: num(x.returned) },
    { label: 'Documents examined', value: num(x.docsExamined) },
    { label: 'Keys examined', value: num(x.keysExamined) },
    { label: 'Time', value: `${num(x.timeMs)} ms` },
  ];
});
</script>

<template>
  <ModalDialog :title="`Explain · ${view.title}`" wide @close="emit('close')">
    <p v-if="view.loading" class="note">Asking the server for the plan…</p>
    <p v-else-if="view.error" class="error-line" role="alert"><Icon name="error" :size="14" /> {{ view.error }}</p>
    <template v-else-if="e">
      <div class="stages" aria-label="Winning plan, from the root down">
        <template v-for="(stage, i) in e.stages" :key="i">
          <span v-if="i" class="arrow" aria-hidden="true">←</span>
          <span class="chip stage" :class="stage === 'COLLSCAN' ? 'tone-warn' : stage === 'IXSCAN' ? 'tone-ok' : 'tone-info'">{{ stage }}</span>
        </template>
      </div>
      <p v-if="e.index" class="index">
        <Icon name="check" :size="14" class="t-ok" /> Uses the index <span class="mono name">{{ e.index }}</span>
      </p>
      <p v-else class="warn-line index">
        <Icon name="info" :size="14" /> COLLSCAN: no index is used, so the server reads every document of the collection.
      </p>
      <dl class="facts">
        <div v-for="f in facts" :key="f.label" class="fact">
          <dt>{{ f.label }}</dt>
          <dd class="mono">{{ f.value }}</dd>
        </div>
      </dl>
      <p v-if="ratio !== null && ratio > 10" class="warn-line">
        {{ ratio === Infinity ? 'Documents were read but none returned' : `${num(Math.round(ratio))} documents read per document returned` }}: an index on the
        filtered fields would help.
      </p>
      <div class="output-head">
        <span class="caps">Full output</span>
        <IconButton icon="copy" label="Copy the explain output" @click="col.copy(e.text, 'the explain output')" />
      </div>
      <div class="code-box output">
        <ShellCode :model-value="e.text" read-only label="Explain output in shell syntax" />
      </div>
    </template>
  </ModalDialog>
</template>

<style scoped>
.stages {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.stage {
  height: 22px;
  padding: 0 9px;
  border-radius: 11px;
  font-family: var(--vscode-editor-font-family);
  font-size: 11px;
}
.arrow {
  color: var(--m-muted);
}
.index {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  font-size: 12px;
}
.name {
  color: var(--vscode-foreground);
}
.facts {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
  gap: 8px;
  margin: 0;
}
.fact {
  padding: 8px 10px;
  border: 1px solid var(--m-border);
  border-radius: 4px;
  background: var(--vscode-editor-background);
}
dt {
  font-size: 11px;
  color: var(--m-muted);
}
dd {
  margin: 2px 0 0;
  font-size: 14px;
}
.output-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: -6px;
}
.output {
  height: min(300px, 40vh);
}
</style>
