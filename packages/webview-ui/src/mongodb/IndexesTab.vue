<script setup lang="ts">
import type { MongoIndex } from '@datakit/core';
import { computed, ref, watch } from 'vue';
import ConfirmDialog from '../components/ConfirmDialog.vue';
import Icon from '../components/Icon.vue';
import IconButton from '../components/IconButton.vue';
import { useCollection } from './collection';
import CreateIndexDialog from './CreateIndexDialog.vue';
import { formatBytes, formatDay, formatSeconds, num, plural } from './format';
import ShellText from './ShellText.vue';

/** The indexes of the collection with their options, size and use; hide, unhide, drop and create them. */
const props = defineProps<{ active: boolean }>();
const col = useCollection();
const s = col.state;

const creating = ref(false);
const dropping = ref<MongoIndex | null>(null);
let readVersion = -1;

const indexes = computed(() => s.indexes ?? []);
const totalBytes = computed(() => (indexes.value.every((i) => i.bytes !== null) ? indexes.value.reduce((n, i) => n + (i.bytes ?? 0), 0) : null));

function load(): void {
  readVersion = s.indexesVersion;
  col.load('indexes');
}

watch(
  () => [props.active, s.indexesVersion] as const,
  ([active, version]) => {
    if (active && version !== readVersion) load();
  },
  { immediate: true },
);

function properties(i: MongoIndex): { label: string; tone: string; title: string }[] {
  const list: { label: string; tone: string; title: string }[] = [];
  if (i.unique) list.push({ label: 'unique', tone: 'tone-info', title: 'No two documents may have the same key' });
  if (i.sparse) list.push({ label: 'sparse', tone: 'tone-muted', title: 'Documents without the fields are left out' });
  if (i.ttlSeconds !== null) {
    list.push({ label: `TTL ${formatSeconds(i.ttlSeconds)}`, tone: 'tone-warn', title: `Documents expire ${num(i.ttlSeconds)} s after the date in the field` });
  }
  if (i.partialFilter) list.push({ label: 'partial', tone: 'tone-info', title: `Only documents matching ${i.partialFilter}` });
  if (i.hidden) list.push({ label: 'hidden', tone: 'tone-warn', title: 'The query planner does not use this index' });
  return list;
}

/**
 * The day most indexes count their use from (the server's start, usually); the header shows it, and only indexes
 * counting from another day (created since) say their own.
 */
const commonSince = computed(() => {
  const days = new Map<string, number>();
  for (const i of indexes.value) if (i.ops !== null && i.usageSince !== null) days.set(formatDay(i.usageSince), (days.get(formatDay(i.usageSince)) ?? 0) + 1);
  return [...days].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
});

function usage(i: MongoIndex): { ops: string; since: string } {
  if (i.ops === null) return { ops: '—', since: '' };
  const day = i.usageSince === null ? null : formatDay(i.usageSince);
  return { ops: plural(i.ops, 'op'), since: day && day !== commonSince.value ? `since ${day}` : '' };
}

const drop = () => col.write({ kind: 'dropIndex', name: dropping.value!.name }, { quiet: true });
</script>

<template>
  <section class="indexes-tab">
    <div class="head">
      <span class="note">
        {{ s.indexes ? `${plural(indexes.length, 'index', 'indexes')}${totalBytes === null ? '' : ` · ${formatBytes(totalBytes)}`}` : 'Reading the indexes…' }}
      </span>
      <span class="spacer" />
      <IconButton icon="reload" label="Read the indexes again" :disabled="s.loading.indexes" @click="load" />
      <button v-if="col.canWrite.value" type="button" class="btn sm btn-primary" @click="creating = true"><Icon name="plus" :size="14" /> Create index…</button>
    </div>
    <p v-if="s.errors.indexes" class="error-line pad" role="alert"><Icon name="error" :size="14" /> {{ s.errors.indexes }}</p>
    <div v-if="s.indexes" class="table-box list" :class="{ dim: s.loading.indexes }">
      <table class="grid">
        <thead>
          <tr>
            <th scope="col">NAME</th>
            <th scope="col">KEYS</th>
            <th scope="col">PROPERTIES</th>
            <th scope="col" class="num">SIZE</th>
            <th scope="col" :title="commonSince ? `Operations that used the index since ${commonSince}` : 'Operations that used the index'">
              USAGE<span v-if="commonSince" class="since"> SINCE {{ commonSince }}</span>
            </th>
            <th v-if="col.canWrite.value" scope="col"><span class="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="i in indexes" :key="i.name" :class="{ hidden: i.hidden }">
            <td class="name">{{ i.name }}</td>
            <td class="keys"><ShellText :text="i.keys" /></td>
            <td>
              <span class="chips">
                <span v-for="p in properties(i)" :key="p.label" class="chip" :class="p.tone" :title="p.title">{{ p.label }}</span>
                <span v-if="!properties(i).length" class="t-muted">—</span>
              </span>
            </td>
            <td class="num">{{ formatBytes(i.bytes) }}</td>
            <td class="usage">
              <span>{{ usage(i).ops }}</span> <span class="t-muted">{{ usage(i).since }}</span>
            </td>
            <td v-if="col.canWrite.value" class="actions">
              <template v-if="i.name !== '_id_'">
                <button type="button" class="btn xs" :title="i.hidden ? 'Let the query planner use the index again' : 'Keep the query planner from using the index, without dropping it'" @click="col.write({ kind: 'hideIndex', name: i.name, hidden: !i.hidden })">
                  {{ i.hidden ? 'Unhide' : 'Hide' }}
                </button>
                <button type="button" class="btn xs danger-text" @click="dropping = i">Drop</button>
              </template>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-if="!indexes.length" class="empty-state">No indexes.</p>
    </div>

    <CreateIndexDialog v-if="creating" @close="creating = false" />
    <ConfirmDialog
      v-if="dropping"
      title="Drop index"
      :text="`Drop the index ${dropping.name} on ${s.init!.collection}? Queries that use it get slower until it is created again.`"
      primary="Drop index"
      :target="dropping.name"
      :action="drop"
      @close="dropping = null"
    />
  </section>
</template>

<style scoped>
.indexes-tab {
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
.name {
  color: var(--vscode-foreground);
  font-weight: 600;
}
tr.hidden .name,
tr.hidden .keys {
  opacity: 0.6;
}
.since {
  font-weight: 400;
}
.usage {
  white-space: normal;
}
.usage span {
  white-space: nowrap;
}
.keys :deep(.shell-text) {
  white-space: pre;
}
.chips {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 4px;
}
.actions {
  text-align: right;
}
.actions .btn + .btn {
  margin-left: 4px;
}
</style>
