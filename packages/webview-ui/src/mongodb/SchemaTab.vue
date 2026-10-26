<script setup lang="ts">
import type { MongoFieldStats } from '@datakit/core';
import { computed, ref, watch } from 'vue';
import Icon from '../components/Icon.vue';
import { useCollection } from './collection';
import { num, percent, plural, splitPath, typeChartColor } from './format';
import ShellText from './ShellText.vue';

/**
 * The fields of a sample of documents: their types, how many documents have them and a few example values. The
 * analysis runs when the tab is first shown and again on Analyze; a write afterwards only says it may be out of date.
 */
const props = defineProps<{ active: boolean }>();
const col = useCollection();
const s = col.state;

const SAMPLES = [100, 1000, 5000];
const sample = ref(SAMPLES.includes(s.schemaSample) ? s.schemaSample : 1000);
/** The documents version the analysis on show was made at. */
const analyzedAt = ref(-1);

function analyze(): void {
  analyzedAt.value = s.documentsVersion;
  col.load('schema', sample.value);
}

watch(
  () => props.active,
  (active) => {
    if (active && !s.schema && !s.loading.schema) analyze();
  },
  { immediate: true },
);

const stale = computed(() => !!s.schema && !s.loading.schema && analyzedAt.value !== s.documentsVersion);

interface Row {
  stats: MongoFieldStats;
  parent: string;
  leaf: string;
  depth: number;
  types: { type: MongoFieldStats['types'][number]['type']; share: number; label: string; color: string }[];
  presence: string;
  /** The share of sampled documents with the field, 0 to 1. */
  presenceShare: number;
}

const rows = computed((): Row[] => {
  const schema = s.schema;
  if (!schema) return [];
  return schema.fields.map((f) => {
    const total = f.types.reduce((n, t) => n + t.count, 0);
    return {
      stats: f,
      ...splitPath(f.path),
      types: f.types.map((t) => ({ type: t.type, share: total ? t.count / total : 0, label: percent(t.count, total), color: typeChartColor(t.type) })),
      presence: percent(f.count, schema.sampled),
      presenceShare: schema.sampled ? Math.min(1, f.count / schema.sampled) : 0,
    };
  });
});
</script>

<template>
  <section class="schema-tab">
    <div class="head">
      <span class="note">
        <template v-if="s.schema">{{ plural(s.schema.fields.length, 'field') }} in {{ plural(s.schema.sampled, 'sampled document') }}</template>
        <template v-else-if="s.loading.schema">Sampling documents…</template>
      </span>
      <span class="spacer" />
      <label class="sample">
        Sample
        <select v-model.number="sample" class="sel" aria-label="Documents to sample">
          <option v-for="n in SAMPLES" :key="n" :value="n">{{ num(n) }} documents</option>
        </select>
      </label>
      <button type="button" class="btn sm btn-primary" :disabled="s.loading.schema" @click="analyze">{{ s.loading.schema ? 'Analyzing…' : 'Analyze' }}</button>
    </div>
    <p v-if="s.errors.schema" class="error-line pad" role="alert"><Icon name="error" :size="14" /> {{ s.errors.schema }}</p>
    <p v-else-if="stale" class="warn-line pad">Documents changed since this analysis. Analyze again to see the current fields.</p>
    <div v-if="s.schema" class="table-box list" :class="{ dim: s.loading.schema }">
      <table class="grid">
        <thead>
          <tr>
            <th scope="col">PATH</th>
            <th scope="col" class="types-col">TYPES</th>
            <th scope="col" class="num">PRESENCE</th>
            <th scope="col">EXAMPLES</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in rows" :key="r.stats.path">
            <td class="path" :style="{ paddingLeft: `${10 + r.depth * 14}px` }" :title="r.stats.path">
              <span class="parent">{{ r.parent }}</span><span class="leaf">{{ r.leaf }}</span>
            </td>
            <td class="types-col">
              <div class="bar" role="img" :aria-label="r.types.map((t) => `${t.type} ${t.label}`).join(', ')">
                <span v-for="t in r.types" :key="t.type" class="segment" :style="{ flexGrow: t.share, background: t.color }" />
              </div>
              <div class="legend">
                <span v-for="t in r.types" :key="t.type" class="type" :style="{ color: t.color }">
                  <span class="swatch" :style="{ background: t.color }" />{{ t.type }} <span class="share">{{ t.label }}</span>
                </span>
              </div>
            </td>
            <td class="num presence" :title="`${num(r.stats.count)} of ${num(s.schema.sampled)} documents`">
              {{ r.presence }}
              <span class="meter"><span :style="{ width: `${r.presenceShare * 100}%` }" /></span>
            </td>
            <td class="examples">
              <span v-for="(e, i) in r.stats.examples" :key="i" class="example"><ShellText :text="e" /></span>
              <span v-if="!r.stats.examples.length" class="t-muted">—</span>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-if="!rows.length" class="empty-state">No fields: the sample is empty.</p>
    </div>
  </section>
</template>

<style scoped>
.schema-tab {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: auto;
}
.head {
  flex: none;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 10px 12px 8px;
}
.spacer {
  flex: 1;
}
.sample {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--m-muted);
}
.pad {
  padding: 0 12px 8px;
}
.list {
  flex: none;
  margin: 0 12px 12px;
}
.list.dim {
  opacity: 0.6;
}
.grid td {
  height: auto;
  padding-top: 6px;
  padding-bottom: 6px;
  vertical-align: top;
}
.parent {
  color: var(--m-muted);
}
.leaf {
  color: var(--vscode-symbolIcon-variableForeground);
}
.types-col {
  width: 34%;
  min-width: 200px;
}
.bar {
  display: flex;
  gap: 1px;
  height: 8px;
  margin-top: 4px;
  overflow: hidden;
  border-radius: 2px;
  background: var(--m-border);
}
.segment {
  flex-basis: 0;
  min-width: 3px;
}
.legend {
  display: flex;
  flex-wrap: wrap;
  gap: 2px 12px;
  margin-top: 4px;
  font-family: var(--vscode-font-family);
  font-size: 11px;
  white-space: normal;
}
.type {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.swatch {
  width: 8px;
  height: 8px;
  border-radius: 2px;
  outline: 1px solid var(--vscode-contrastBorder, transparent);
}
.share {
  color: var(--m-muted);
}
.presence {
  width: 90px;
}
.meter {
  display: block;
  height: 3px;
  margin-top: 5px;
  overflow: hidden;
  border-radius: 2px;
  background: var(--m-border);
}
.meter span {
  display: block;
  height: 100%;
  background: var(--vscode-progressBar-background, var(--vscode-focusBorder));
}
.examples {
  white-space: normal;
  min-width: 180px;
}
.example {
  display: inline-block;
  max-width: 100%;
  margin: 0 6px 2px 0;
  padding: 0 6px;
  border-radius: 3px;
  background: var(--m-head);
}
</style>
