<script lang="ts">
/** Only the first time the page is shown after it loaded does it go back to the saved group. */
let firstMount = true;
</script>

<script setup lang="ts">
import type { KafkaGroupDetail, KafkaGroupOffset, KafkaOffsetTarget, KafkaWorkspaceHostMessage } from '@datakit/core';
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import Icon from '../components/Icon.vue';
import IconButton from '../components/IconButton.vue';
import { usePersistedState } from '../composables/usePersistedState';
import { onHostMessage } from '../host';
import ConfirmDialog from './ConfirmDialog.vue';
import { formatTime, groupState, lagText, num, offsetText, parseLocalTime, parseOffset, plural, totalLag } from './format';
import { describeReset } from './offsetReset';
import { consumersToSave, readSavedConsumers } from './savedState';
import { useWorkspace, type WriteResult } from './workspace';

/** The consumer groups; the picked group's committed offsets can be moved, all at once or the selected partitions. */
const ws = useWorkspace();
const s = ws.state;
/** Offset rows drawn at most. */
const MAX_ROWS = 1000;

const picked = ref<string | null>(null);
const detail = ref<KafkaGroupDetail | null>(null);
const selected = ref(new Set<string>());
type TargetKind = KafkaOffsetTarget['kind'];
const targetKind = ref<TargetKind>('earliest');
const targetValue = ref('');
const resetting = ref(false);
const deleting = ref(false);
/** The group and selected rows come back after a reload of the page; reading the group writes nothing. */
const saved = usePersistedState('kafka.consumers', {
  version: 1,
  value: () => consumersToSave(picked.value, selected.value),
  validate: readSavedConsumers,
});
/** Rows to select again once the restored group's offsets have arrived. */
let restoreSelection: string[] | null = null;

const readOnly = computed(() => s.init!.readOnly);
const groups = computed(() =>
  [...(s.groups ?? s.overview?.overview.groups ?? [])].sort((a, b) => a.id.localeCompare(b.id)).map((g) => ({ ...g, chip: groupState(g.state), lag: totalLag(g) })),
);
const offsets = computed(() => [...(detail.value?.offsets ?? [])].sort((a, b) => a.topic.localeCompare(b.topic) || a.partition - b.partition));
const rowKey = (o: KafkaGroupOffset) => `${o.topic}\u0000${o.partition}`;
const blocked = computed(() => (detail.value?.members ?? 0) > 0);
const blockedWhy = computed(() => (blocked.value && detail.value ? `${detail.value.id} has ${plural(detail.value.members, 'active member')}; stop its consumers first` : undefined));

// A time starts as the current minute, to be edited, rather than an empty field to type in full.
watch(targetKind, (kind) => {
  if (kind === 'timestamp' && !parseLocalTime(targetValue.value).value) targetValue.value = formatTime(Date.now()).slice(0, 16);
  else if (kind === 'offset' && parseOffset(targetValue.value).value === null) targetValue.value = '';
});
const allSelected = computed(() => offsets.value.length > 0 && selected.value.size === offsets.value.length);

function open(id: string): void {
  if (picked.value !== id) {
    detail.value = null;
    selected.value = new Set();
    restoreSelection = null;
  }
  picked.value = id;
  delete s.errors.group;
  ws.post({ type: 'openGroup', groupId: id });
}

watch(
  groups,
  (list) => {
    if (picked.value === null && list[0]) open(list[0].id);
  },
);

function reload(): void {
  ws.load('groups');
  if (picked.value) open(picked.value);
}

function toggle(o: KafkaGroupOffset): void {
  const next = new Set(selected.value);
  const key = rowKey(o);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  selected.value = next;
}

function toggleAll(): void {
  selected.value = allSelected.value ? new Set() : new Set(offsets.value.map(rowKey));
}

/** The target as the write takes it; a problem when its value cannot be read. */
const target = computed((): { target: KafkaOffsetTarget | null; problem: string | null } => {
  switch (targetKind.value) {
    case 'earliest':
    case 'latest':
      return { target: { kind: targetKind.value }, problem: null };
    case 'timestamp': {
      const t = parseLocalTime(targetValue.value);
      return t.value === null ? { target: null, problem: t.error ?? 'Type a time, YYYY-MM-DD HH:MM[:SS].' } : { target: { kind: 'timestamp', time: t.value }, problem: null };
    }
    case 'offset': {
      const o = parseOffset(targetValue.value);
      return o.value === null ? { target: null, problem: o.error ?? 'Type an offset.' } : { target: { kind: 'offset', offset: o.value }, problem: null };
    }
  }
  return { target: null, problem: null };
});
const scope = computed(() => (selected.value.size ? plural(selected.value.size, 'selected partition') : 'all partitions'));
/** The partitions a reset moves: the selected ones, or else every one with a committed offset, as the host does. */
const chosen = computed(() => (selected.value.size ? offsets.value.filter((o) => selected.value.has(rowKey(o))) : offsets.value.filter((o) => o.committed !== null)));
const summary = computed(() => (resetting.value && target.value.target ? describeReset(chosen.value, target.value.target) : null));

/** A reset can make consumers read messages again or skip them, so it is confirmed first. */
function confirmReset(): void {
  if (detail.value && target.value.target && chosen.value.length && !blocked.value) resetting.value = true;
}

async function reset(): Promise<WriteResult> {
  const d = detail.value!;
  const partitions = selected.value.size ? chosen.value.map((o) => ({ topic: o.topic, partition: o.partition })) : null;
  const result = await ws.write({ kind: 'resetOffsets', groupId: d.id, partitions, target: target.value.target! }, { quiet: true });
  if (result.ok) {
    selected.value = new Set();
    open(d.id);
  }
  return result;
}

const deleteAction = (groupId: string) => () => ws.write({ kind: 'deleteGroup', groupId }, { quiet: true });
ws.onDone((write) => {
  if (write?.kind === 'deleteGroup' && write.groupId === picked.value) {
    picked.value = null;
    detail.value = null;
  }
});

const stop = onHostMessage<KafkaWorkspaceHostMessage>((message) => {
  if (message.type === 'group' && message.detail.id === picked.value) {
    detail.value = message.detail;
    if (restoreSelection) {
      const rows = new Set(offsets.value.map(rowKey));
      selected.value = new Set(restoreSelection.filter((key) => rows.has(key)));
      restoreSelection = null;
    }
  } else if (message.type === 'groupGone' && message.groupId === picked.value) {
    // The list is read again and the first group is picked; the gone one drops out of it.
    restoreSelection = null;
    picked.value = null;
    detail.value = null;
    ws.load('groups');
  }
});

onMounted(() => {
  ws.load('groups');
  const wanted = s.group;
  s.group = null;
  const restored = saved.restore();
  const back = firstMount && !wanted ? restored : undefined;
  firstMount = false;
  if (wanted) open(wanted);
  else if (back?.picked) {
    open(back.picked);
    restoreSelection = back.selected;
  } else if (groups.value[0]) open(groups.value[0].id);
});
onUnmounted(stop);
</script>

<template>
  <section class="page">
    <header class="page-head">
      <h1>Consumers</h1>
      <div class="actions">
        <IconButton icon="reload" label="Read the groups again" :disabled="s.loading.groups" @click="reload" />
      </div>
    </header>
    <div class="page-body">
      <p v-if="s.errors.groups" class="error-line" role="alert"><Icon name="error" :size="14" /> {{ s.errors.groups }}</p>
      <div class="table-box">
        <table class="grid">
          <thead>
            <tr>
              <th scope="col">GROUP</th>
              <th scope="col">STATE</th>
              <th scope="col" class="num">MEMBERS</th>
              <th scope="col">TOPICS</th>
              <th scope="col" class="num">LAG</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="g in groups" :key="g.id" :class="{ picked: g.id === picked }">
              <td class="pad0">
                <button type="button" class="rowb" :aria-pressed="g.id === picked" :title="g.protocolType && g.protocolType !== 'consumer' ? `${g.id} · ${g.protocolType}` : g.id" @click="open(g.id)">{{ g.id }}</button>
              </td>
              <td><span class="chip" :class="`tone-${g.chip.tone}`" :title="g.state">{{ g.chip.label }}</span></td>
              <td class="num">{{ num(g.members) }}</td>
              <td class="t-muted topics" :title="Object.keys(g.lagByTopic).join(', ')">{{ Object.keys(g.lagByTopic).join(', ') || '—' }}</td>
              <td class="num" :class="g.lag ? 't-warn' : 't-ok'">{{ lagText(g.lag) }}</td>
            </tr>
          </tbody>
        </table>
        <p v-if="!groups.length" class="empty-state">{{ s.loading.groups ? 'Reading the consumer groups…' : 'The cluster has no consumer groups.' }}</p>
      </div>

      <div v-if="picked" class="offsets">
        <div class="offsets-head">
          <span class="caps">Offsets · {{ picked }}</span>
          <div v-if="!readOnly && detail" class="reset">
            <span class="note">Set {{ scope }} to</span>
            <select v-model="targetKind" class="sel" aria-label="Move offsets to">
              <option value="earliest">Earliest</option>
              <option value="latest">Latest</option>
              <option value="timestamp">Timestamp</option>
              <option value="offset">Offset</option>
            </select>
            <input
              v-if="targetKind === 'timestamp' || targetKind === 'offset'"
              v-model="targetValue"
              class="fld mono target"
              :class="{ invalid: targetValue && target.problem }"
              :aria-label="targetKind === 'timestamp' ? 'Time' : 'Offset'"
              :placeholder="targetKind === 'timestamp' ? 'YYYY-MM-DD HH:MM' : 'offset'"
              :title="target.problem ?? undefined"
              @keydown.enter.prevent="confirmReset"
            />
            <button type="button" class="btn btn-primary sm" :disabled="blocked || !target.target || !chosen.length" :title="blockedWhy" @click="confirmReset">Apply</button>
            <button type="button" class="btn sm danger-text" :disabled="blocked" :title="blockedWhy" @click="deleting = true">Delete group</button>
          </div>
        </div>
        <p v-if="blocked && detail && !readOnly" class="warn-line">
          {{ detail.id }} has {{ plural(detail.members, 'active member') }}. Offsets can only be changed after its consumers stop.
        </p>
        <p v-if="s.errors.group" class="error-line" role="alert"><Icon name="error" :size="14" /> {{ s.errors.group }}</p>
        <p v-else-if="!detail" class="empty-state">Reading the offsets…</p>
        <div v-else class="table-box">
          <table class="grid">
            <thead>
              <tr>
                <th v-if="!readOnly" scope="col" class="tick"><input type="checkbox" aria-label="Select all partitions" :checked="allSelected" :disabled="!offsets.length" @change="toggleAll" /></th>
                <th scope="col">TOPIC</th>
                <th scope="col" class="num">PARTITION</th>
                <th scope="col" class="num">COMMITTED</th>
                <th scope="col" class="num">END</th>
                <th scope="col" class="num">LAG</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="o in offsets.slice(0, MAX_ROWS)" :key="rowKey(o)" :class="{ checked: selected.has(rowKey(o)) }">
                <td v-if="!readOnly" class="tick">
                  <input type="checkbox" :aria-label="`Select ${o.topic} partition ${o.partition}`" :checked="selected.has(rowKey(o))" @change="toggle(o)" />
                </td>
                <td>{{ o.topic }}</td>
                <td class="num">{{ o.partition }}</td>
                <td class="num" :class="{ 't-muted': o.committed === null }">{{ o.committed === null ? 'none' : offsetText(o.committed) }}</td>
                <td class="num">{{ offsetText(o.end) }}</td>
                <td class="num" :class="o.lag ? 't-warn' : 't-ok'">{{ lagText(o.lag) }}</td>
              </tr>
            </tbody>
          </table>
          <p v-if="!offsets.length" class="empty-state">The group has no committed offsets.</p>
          <p v-else-if="offsets.length > MAX_ROWS" class="empty-state">Showing {{ num(MAX_ROWS) }} of {{ num(offsets.length) }} partitions.</p>
        </div>
      </div>
    </div>

    <ConfirmDialog
      v-if="resetting && detail && summary"
      :title="`Reset the offsets of ${detail.id}`"
      :target="detail.id"
      primary="Reset offsets"
      :action="reset"
      @close="resetting = false"
    >
      <p class="lead">
        Moves the committed offsets of {{ detail.id }} to {{ summary.to }}<template v-if="summary.value">&nbsp;<span class="mono nowrap">{{ summary.value }}</span></template>.
        <template v-if="summary.clamped">A partition without that offset gets its nearest one.</template>
      </p>
      <ul class="parts">
        <li v-for="t in summary.topics" :key="t.topic">
          <span class="mono">{{ t.topic }}</span> <span class="t-muted">{{ t.partitions }}</span>
        </li>
        <li v-if="summary.more" class="t-muted">and {{ plural(summary.more, 'more topic') }}</li>
      </ul>
      <p class="warn-line">{{ summary.effect }}</p>
    </ConfirmDialog>
    <ConfirmDialog
      v-else-if="deleting && detail"
      :title="`Delete ${detail.id}`"
      text="Deletes the consumer group and its committed offsets."
      :target="detail.id"
      primary="Delete group"
      :action="deleteAction(detail.id)"
      @close="deleting = false"
    />
  </section>
</template>

<style scoped>
.topics {
  max-width: 360px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.offsets {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.offsets-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.reset {
  margin-left: auto;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.target {
  width: 160px;
  height: 26px;
}
.lead {
  margin: 0;
  line-height: 1.5;
}
.nowrap {
  white-space: nowrap;
}
.parts {
  margin: 0;
  padding-left: 18px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}
</style>
