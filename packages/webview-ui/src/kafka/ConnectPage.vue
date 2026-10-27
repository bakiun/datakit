<script setup lang="ts">
import type { Connector, ConnectorAction } from '@datakit/core';
import { computed, onMounted, ref } from 'vue';
import Icon from '../components/Icon.vue';
import IconButton from '../components/IconButton.vue';
import ConfirmDialog from './ConfirmDialog.vue';
import ConnectorDialog from './ConnectorDialog.vue';
import { connectorTone, firstLine, plural, shortClass } from './format';
import { useWorkspace } from './workspace';

/** The Kafka Connect cluster: one card per connector with its state, tasks and actions; failed tasks show why. */
const ws = useWorkspace();
const s = ws.state;

type Dialog = { kind: 'new' } | { kind: 'edit'; name: string } | { kind: 'resetOffsets'; name: string; stopped: boolean };
const dialog = ref<Dialog | null>(null);
/** Connectors with a write on the way. */
const busy = ref(new Set<string>());

const readOnly = computed(() => s.init!.readOnly);
const connectors = computed(() => [...(s.connect?.connectors ?? [])].sort((a, b) => a.name.localeCompare(b.name)));
const failedCount = computed(() => connectors.value.reduce((n, c) => n + (c.state === 'FAILED' ? 1 : 0) + c.tasks.filter((t) => t.state === 'FAILED').length, 0));
const host = computed(() => s.init!.connectUrl?.replace(/^https?:\/\//, '').replace(/\/$/, '') ?? '');

const running = (c: Connector) => c.tasks.filter((t) => t.state === 'RUNNING').length;
const paused = (c: Connector) => c.state === 'PAUSED' || c.state === 'STOPPED';
/** Failed tasks and a failed connector, with the first line of their trace. */
const failures = (c: Connector) => [
  ...(c.state === 'FAILED' ? [{ task: null as number | null, line: c.trace ? firstLine(c.trace) : 'The connector failed.' }] : []),
  ...c.tasks.filter((t) => t.state === 'FAILED').map((t) => ({ task: t.id as number | null, line: t.trace ? firstLine(t.trace) : 'The task failed.' })),
];

async function act(name: string, action: ConnectorAction): Promise<void> {
  busy.value = new Set(busy.value).add(name);
  // Pause and resume show in the card's state; a restart does not, so it is announced.
  await ws.write({ kind: 'connector', name, action }, { announce: action === 'restart' });
  const next = new Set(busy.value);
  next.delete(name);
  busy.value = next;
}

async function restartTask(name: string, task: number): Promise<void> {
  busy.value = new Set(busy.value).add(name);
  await ws.write({ kind: 'restartTask', name, task });
  const next = new Set(busy.value);
  next.delete(name);
  busy.value = next;
}

function resetOffsets(c: Connector): void {
  dialog.value = { kind: 'resetOffsets', name: c.name, stopped: c.state === 'STOPPED' };
}

/** Connect resets stopped connectors only; the host stops a running one first. */
const resetText = (name: string, stopped: boolean) =>
  `${stopped ? `Removes the offsets ${name} has committed.` : `Stops ${name}, then removes the offsets it has committed.`} When it is resumed it starts over: a source reads from the beginning, a sink from its consumer group's reset policy.`;

const confirmAction = (name: string, action: ConnectorAction) => () => ws.write({ kind: 'connector', name, action }, { quiet: true });

onMounted(() => ws.load('connectors'));
</script>

<template>
  <section class="page">
    <header class="page-head">
      <h1>Kafka Connect</h1>
      <span class="note">{{ host }}<template v-if="s.connect"> · {{ plural(s.connect.workers, 'worker') }} · {{ s.connect.version }}</template></span>
      <div class="actions">
        <IconButton icon="reload" label="Read the connectors again" :disabled="s.loading.connectors" @click="ws.load('connectors')" />
        <template v-if="!readOnly">
          <button type="button" class="btn" :disabled="!failedCount" @click="ws.write({ kind: 'restartFailed' })">Restart all failed tasks</button>
          <button type="button" class="btn btn-primary" @click="dialog = { kind: 'new' }"><Icon name="plus" :size="14" /> New connector</button>
        </template>
      </div>
    </header>
    <div class="page-body">
      <p v-if="s.errors.connectors" class="error-line" role="alert"><Icon name="error" :size="14" /> {{ s.errors.connectors }}</p>
      <p v-else-if="!s.connect" class="empty-state">{{ s.loading.connectors ? 'Reading the connectors…' : '' }}</p>
      <p v-else-if="!connectors.length" class="empty-state">
        No connectors yet.
        <button v-if="!readOnly" type="button" class="lnk" @click="dialog = { kind: 'new' }">Create a connector</button>
      </p>
      <article v-for="c in connectors" :key="c.name" class="card" :class="{ failed: failures(c).length, busy: busy.has(c.name) }">
        <div class="card-head">
          <span class="dot" :class="`tone-${connectorTone(c.state)}`" />
          <span class="mono name">{{ c.name }}</span>
          <span class="chip" :class="`tone-${connectorTone(c.state)}`">{{ c.state }}</span>
          <span class="note" :title="c.className">{{ c.type }} · {{ shortClass(c.className) }} · tasks {{ running(c) }}/{{ c.tasks.length }}</span>
          <div v-if="!readOnly" class="card-actions">
            <IconButton
              :icon="paused(c) ? 'run' : 'pause'"
              :label="`${paused(c) ? 'Resume' : 'Pause'} ${c.name}`"
              :filled="paused(c)"
              :disabled="busy.has(c.name)"
              @click="act(c.name, paused(c) ? 'resume' : 'pause')"
            />
            <IconButton icon="reload" :label="`Restart ${c.name} and its tasks`" :disabled="busy.has(c.name)" @click="act(c.name, 'restart')" />
            <IconButton icon="edit" :label="`Edit the config of ${c.name}`" @click="dialog = { kind: 'edit', name: c.name }" />
            <IconButton icon="revert" :label="`Reset the offsets of ${c.name}`" :disabled="busy.has(c.name)" @click="resetOffsets(c)" />
          </div>
        </div>
        <div v-for="f in failures(c)" :key="f.task ?? 'connector'" class="failure">
          <span class="mono trace" :title="f.line">{{ f.task === null ? 'connector' : `task ${f.task}` }} · {{ f.line }}</span>
          <template v-if="!readOnly">
            <button v-if="f.task !== null" type="button" class="btn sm" :disabled="busy.has(c.name)" @click="restartTask(c.name, f.task)">Restart task {{ f.task }}</button>
            <button v-else type="button" class="btn sm" :disabled="busy.has(c.name)" @click="act(c.name, 'restart')">Restart connector</button>
          </template>
        </div>
      </article>
    </div>

    <ConnectorDialog v-if="dialog?.kind === 'new'" :name="null" :existing="connectors.map((c) => c.name)" @close="dialog = null" />
    <ConnectorDialog v-else-if="dialog?.kind === 'edit'" :name="dialog.name" :existing="[]" @close="dialog = null" />
    <ConfirmDialog
      v-else-if="dialog?.kind === 'resetOffsets'"
      :title="`Reset the offsets of ${dialog.name}`"
      :text="resetText(dialog.name, dialog.stopped)"
      :target="dialog.name"
      :primary="dialog.stopped ? 'Reset offsets' : 'Stop and reset offsets'"
      :action="confirmAction(dialog.name, 'resetOffsets')"
      @close="dialog = null"
    />
  </section>
</template>

<style scoped>
.page-body {
  gap: 10px;
}
.card {
  flex: none;
  border: 1px solid var(--k-border);
  border-radius: 6px;
  background: var(--k-surface);
}
.card.failed {
  border-color: color-mix(in srgb, var(--k-error) 55%, transparent);
}
.card.busy {
  opacity: 0.7;
}
.card-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 14px;
  padding: 8px 8px 8px 12px;
}
.name {
  font-weight: 500;
  overflow-wrap: anywhere;
}
.card-actions {
  margin-left: auto;
  display: flex;
  gap: 2px;
}
.failure {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-top: 1px solid color-mix(in srgb, var(--k-error) 40%, transparent);
  background: color-mix(in srgb, var(--k-error) 10%, transparent);
  font-size: 12px;
}
.trace {
  flex: 1 1 300px;
  min-width: 0;
  color: var(--k-error);
  overflow-wrap: anywhere;
}
</style>
