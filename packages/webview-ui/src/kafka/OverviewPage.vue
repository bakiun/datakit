<script setup lang="ts">
import type { KafkaSection } from '@datakit/core';
import { computed, onMounted } from 'vue';
import Icon from '../components/Icon.vue';
import IconButton from '../components/IconButton.vue';
import { groupState, lagText, num, plural, totalLag, type Tone } from './format';
import { useWorkspace } from './workspace';

/** Cards that sum up the cluster and lead to their sections, leaders per broker and the most lagging groups. */
const ws = useWorkspace();
const s = ws.state;
const LAG_ROWS = 8;

onMounted(() => {
  const checkedAt = s.overview?.overview.checkedAt ?? 0;
  if (!s.loading.overview && Date.now() - checkedAt > 10_000) ws.load('overview');
});

interface Card {
  label: string;
  value: string;
  sub: string;
  tone: Tone | null;
  section: KafkaSection;
}

const cards = computed((): Card[] => {
  const data = s.overview;
  const init = s.init!;
  if (!data) return [];
  const o = data.overview;
  const offline = o.brokers.filter((b) => !b.online).length;
  const controller = o.controllerId >= 0 ? `controller broker-${o.controllerId}` : 'no controller';
  const rf = o.replicationFactors;
  const rfText = rf.length === 0 ? '—' : rf.length === 1 ? String(rf[0]) : `${rf[0]}–${rf[rf.length - 1]}`;
  const lagging = o.groups.map((g) => ({ id: g.id, lag: totalLag(g) ?? 0 })).sort((a, b) => b.lag - a.lag)[0];
  const firstIssue = o.offline[0] ?? o.underReplicated[0];

  let connectors: Pick<Card, 'value' | 'sub' | 'tone'>;
  if (init.connectUrl === null) connectors = { value: '—', sub: 'Not configured', tone: 'muted' };
  else if (!data.connectors) connectors = { value: '—', sub: 'Could not be read', tone: 'muted' };
  else {
    const failed = data.connectors.reduce((n, c) => n + (c.state === 'FAILED' ? 1 : 0) + c.tasks.filter((t) => t.state === 'FAILED').length, 0);
    const idle = data.connectors.filter((c) => c.state !== 'RUNNING').length;
    connectors = {
      value: num(data.connectors.length),
      sub: failed ? `${plural(failed, 'failed task')}` : idle ? `${num(data.connectors.length - idle)} running · ${num(idle)} paused or stopped` : 'All running',
      tone: failed ? 'error' : null,
    };
  }

  let schemas: Pick<Card, 'value' | 'sub' | 'tone'>;
  if (init.schemaRegistryUrl === null) schemas = { value: '—', sub: 'Not configured', tone: 'muted' };
  else if (data.subjects === null) schemas = { value: '—', sub: 'Could not be read', tone: 'muted' };
  else schemas = { value: num(data.subjects), sub: data.globalCompatibility ? `global compatibility ${data.globalCompatibility}` : 'subjects', tone: null };

  return [
    { label: 'Brokers', value: num(o.brokers.length), sub: `${offline ? `${num(offline)} offline` : 'All online'} · ${controller}`, tone: offline ? 'error' : null, section: 'brokers' },
    { label: 'Topics', value: num(o.topics), sub: `${plural(o.partitions, 'partition')} · RF ${rfText}`, tone: null, section: 'topics' },
    {
      label: o.offline.length ? 'Offline / under-replicated' : 'Under-replicated',
      value: o.offline.length ? `${num(o.offline.length)} / ${num(o.underReplicated.length)}` : num(o.underReplicated.length),
      sub: firstIssue ? `${firstIssue.topic} p${firstIssue.partition}` : 'Every partition is in sync',
      tone: o.offline.length ? 'error' : o.underReplicated.length ? 'warn' : null,
      section: 'brokers',
    },
    {
      label: 'Consumer groups',
      value: num(o.groups.length),
      sub: lagging && lagging.lag > 0 ? `max lag ${num(lagging.lag)} · ${lagging.id}` : 'No lag',
      tone: null,
      section: 'consumers',
    },
    { label: 'Connectors', ...connectors, section: 'connect' },
    { label: 'Schemas', ...schemas, section: 'schemas' },
  ];
});

const leaders = computed(() => {
  const brokers = [...(s.overview?.overview.brokers ?? [])].sort((a, b) => a.id - b.id);
  const max = Math.max(1, ...brokers.map((b) => b.leaders));
  return brokers.map((b) => ({ id: b.id, online: b.online, leaders: b.leaders, width: `${Math.round((b.leaders / max) * 100)}%` }));
});

const lag = computed(() => {
  const groups = (s.overview?.overview.groups ?? []).map((g) => ({ id: g.id, state: groupState(g.state), lag: totalLag(g) }));
  return groups.sort((a, b) => (b.lag ?? -1) - (a.lag ?? -1) || a.id.localeCompare(b.id));
});
</script>

<template>
  <section class="page">
    <header class="page-head">
      <h1>Cluster overview</h1>
      <span v-if="s.overview" class="note mono">{{ s.overview.overview.clusterId }}</span>
      <div class="actions">
        <IconButton icon="reload" label="Check again" :disabled="s.loading.overview" @click="ws.load('overview')" />
      </div>
    </header>
    <div class="page-body">
      <p v-if="s.errors.overview" class="error-line" role="alert"><Icon name="error" :size="14" /> {{ s.errors.overview }}</p>
      <p v-else-if="!s.overview" class="empty-state">Reading the cluster…</p>
      <template v-if="s.overview">
        <div class="cards">
          <button v-for="c in cards" :key="c.label" type="button" class="card" @click="ws.go(c.section)">
            <span class="caps">{{ c.label }}</span>
            <span class="value mono" :class="c.tone ? `t-${c.tone}` : ''">{{ c.value }}</span>
            <span class="sub">{{ c.sub }}</span>
          </button>
        </div>
        <div class="lists">
          <div class="list">
            <span class="caps">Partition leaders per broker</span>
            <div v-for="b in leaders" :key="b.id" class="bar-row">
              <span class="mono broker" :class="{ 't-error': !b.online }">broker-{{ b.id }}</span>
              <div class="track"><div class="fill" :style="{ width: b.width }" /></div>
              <span class="mono n">{{ num(b.leaders) }}</span>
            </div>
            <p v-if="!leaders.length" class="empty-state">No brokers.</p>
          </div>
          <div class="list">
            <span class="caps">Consumer lag</span>
            <button v-for="g in lag.slice(0, LAG_ROWS)" :key="g.id" type="button" class="lag-row" @click="ws.openGroup(g.id)">
              <span class="mono id">{{ g.id }}</span>
              <span class="chip" :class="`tone-${g.state.tone}`">{{ g.state.label }}</span>
              <span class="mono n" :class="g.lag ? 't-warn' : 't-ok'">{{ lagText(g.lag) }}</span>
            </button>
            <button v-if="lag.length > LAG_ROWS" type="button" class="lnk more" @click="ws.go('consumers')">{{ plural(lag.length - LAG_ROWS, 'more group') }}</button>
            <p v-if="!lag.length" class="empty-state">No consumer groups.</p>
          </div>
        </div>
      </template>
    </div>
  </section>
</template>

<style scoped>
.page-body {
  gap: 18px;
}
.cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(200px, 100%), 1fr));
  gap: 12px;
}
.card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 14px;
  border: 1px solid var(--k-border);
  border-radius: 6px;
  background: var(--k-surface);
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.card:hover {
  border-color: var(--vscode-focusBorder);
}
.card:focus-visible {
  outline: 1px solid var(--vscode-focusBorder);
}
.value {
  font-size: 24px;
}
.sub {
  font-size: 12px;
  color: var(--k-muted);
  overflow-wrap: anywhere;
}
.lists {
  display: flex;
  flex-wrap: wrap;
  gap: 16px 28px;
}
.list {
  flex: 1 1 320px;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.bar-row,
.lag-row {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12px;
}
.broker {
  width: 72px;
}
.track {
  flex: 1;
  height: 8px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--k-muted) 22%, transparent);
}
.fill {
  height: 8px;
  border-radius: 4px;
  background: var(--vscode-charts-blue);
}
.n {
  min-width: 48px;
  text-align: right;
}
.lag-row {
  box-sizing: border-box;
  width: 100%;
  min-height: 24px;
  padding: 0 4px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.lag-row:hover {
  background: var(--vscode-list-hoverBackground);
}
.lag-row:focus-visible {
  outline: 1px solid var(--vscode-focusBorder);
}
.id {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.more {
  align-self: flex-start;
  font-size: 12px;
}
.empty-state {
  padding: 4px 0;
}
</style>
