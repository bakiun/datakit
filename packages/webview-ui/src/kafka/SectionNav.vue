<script setup lang="ts">
import { KAFKA_SECTIONS, kafkaHealth, type KafkaSection } from '@datakit/core';
import { computed } from 'vue';
import Icon from '../components/Icon.vue';
import type { IconName } from '../components/icons';
import { num } from './format';
import { useWorkspace } from './workspace';

/** The cluster's sections with their counts, and the starred topics. */
const ws = useWorkspace();
const s = ws.state;

const ICONS: Record<KafkaSection, IconName> = {
  overview: 'grid',
  brokers: 'server',
  topics: 'list',
  consumers: 'users',
  acls: 'shield',
  schemas: 'braces',
  connect: 'plug',
  ksql: 'terminal',
};

/** Failed connectors and failed tasks. */
const failedConnectors = computed(() => {
  const list = s.connect?.connectors ?? s.overview?.connectors;
  return list ? list.filter((c) => c.state === 'FAILED' || c.tasks.some((t) => t.state === 'FAILED')).length : 0;
});

function count(section: KafkaSection): { text: string; error: boolean } | null {
  const o = s.overview;
  const n = (value: number | null | undefined) => (value === null || value === undefined ? null : { text: num(value), error: false });
  switch (section) {
    case 'brokers':
      return n((s.brokers ?? o?.overview.brokers)?.length);
    case 'topics':
      return n(s.topics ? s.topics.filter((t) => !t.internal).length : o?.overview.topics);
    case 'consumers':
      return n((s.groups ?? o?.overview.groups)?.length);
    case 'acls':
      return n(s.acls?.list?.length);
    case 'schemas':
      return n(s.subjects ? s.subjects.length : o?.subjects);
    case 'connect':
      if (failedConnectors.value) return { text: `${failedConnectors.value} failed`, error: true };
      return n((s.connect?.connectors ?? o?.connectors)?.length);
    default:
      return null;
  }
}

/** REST sections without a URL stay in the list, dimmed. */
function configured(section: KafkaSection): boolean {
  const init = s.init!;
  if (section === 'schemas') return init.schemaRegistryUrl !== null;
  if (section === 'connect') return init.connectUrl !== null;
  if (section === 'ksql') return init.ksqlDbUrl !== null;
  return true;
}

const items = computed(() => KAFKA_SECTIONS.map((section) => ({ ...section, icon: ICONS[section.id], count: count(section.id), configured: configured(section.id) })));

/** The dot before the cluster name: the worst health item, or an error when the overview could not be read. */
const tone = computed(() => {
  if (s.errors.overview) return 'tone-error';
  if (!s.overview) return 'tone-muted';
  const items = kafkaHealth(s.overview.overview, s.overview.connectors);
  return items.some((i) => i.level === 'error') ? 'tone-error' : items.length ? 'tone-warn' : 'tone-ok';
});
const favourites = computed(() => [...s.favourites].sort((a, b) => a.localeCompare(b)));
</script>

<template>
  <aside class="section-nav" aria-label="Cluster sections">
    <div class="source">
      <span class="dot" :class="tone" />
      <span class="name" :title="s.init!.bootstrapServers">{{ s.init!.dataSourceName }}</span>
      <span class="server">{{ s.init!.serverLabel }} · {{ s.init!.securityProtocol }}</span>
      <span v-if="s.init!.environment === 'production'" class="chip tone-error" title="Changes ask again in VS Code before they run">Production</span>
    </div>
    <p v-if="s.init!.readOnly" class="read-only">Read-only data source: changes are turned off.</p>
    <nav class="items">
      <button
        v-for="item in items"
        :key="item.id"
        type="button"
        class="item"
        :class="{ dim: !item.configured }"
        :aria-current="s.section === item.id ? 'page' : undefined"
        :title="item.configured ? undefined : `${item.label} is not configured`"
        @click="ws.go(item.id)"
      >
        <Icon :name="item.icon" />
        <span class="label">{{ item.label }}</span>
        <span v-if="item.count" class="count mono" :class="{ error: item.count.error }">{{ item.count.text }}</span>
      </button>
    </nav>
    <div class="favourites">
      <div class="caps">Favourite topics</div>
      <button
        v-for="name in favourites"
        :key="name"
        type="button"
        class="item fav mono"
        :aria-current="s.section === 'topics' && s.topic === name ? 'page' : undefined"
        :title="name"
        @click="ws.openTopic(name)"
      >
        <Icon name="star" :size="13" filled class="star" />
        <span class="label">{{ name }}</span>
      </button>
      <span v-if="!favourites.length" class="none">Star a topic to pin it here.</span>
    </div>
  </aside>
</template>

<style scoped>
.section-nav {
  flex: 0 0 230px;
  box-sizing: border-box;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 10px 8px;
  overflow: auto;
  border-right: 1px solid var(--k-border);
  background: var(--k-surface);
}
.source {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
  padding: 2px 6px 10px;
}
.name {
  font-weight: 600;
  overflow-wrap: anywhere;
}
.server {
  font-size: 11px;
  color: var(--k-muted);
}
.read-only {
  margin: 0 6px 8px;
  font-size: 11px;
  line-height: 1.4;
  color: var(--k-warn);
}
.items,
.favourites {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.item {
  display: flex;
  align-items: center;
  gap: 10px;
  box-sizing: border-box;
  width: 100%;
  height: 32px;
  padding: 0 10px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--vscode-foreground);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.item .icon {
  color: var(--k-muted);
}
.item:hover {
  background: var(--vscode-list-hoverBackground);
}
.item[aria-current='page'] {
  background: var(--vscode-list-activeSelectionBackground);
  color: var(--vscode-list-activeSelectionForeground);
  outline: 1px solid var(--vscode-contrastActiveBorder, transparent);
}
.item[aria-current='page'] .icon,
.item[aria-current='page'] .count {
  color: inherit;
}
.item:focus-visible {
  outline: 1px solid var(--vscode-focusBorder);
  outline-offset: -1px;
}
.item.dim {
  opacity: 0.55;
}
.label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.count {
  font-size: 11px;
  color: var(--k-muted);
}
.count.error {
  color: var(--k-error);
}
.favourites {
  margin-top: 12px;
}
.favourites .caps {
  padding: 0 10px 4px;
}
.fav {
  height: 26px;
  gap: 8px;
  font-size: 12px;
}
.fav .star,
.item[aria-current='page'] .star {
  color: var(--k-star);
}
.fav {
  font-family: var(--vscode-editor-font-family);
}
.none {
  padding: 4px 10px;
  font-size: 12px;
  color: var(--k-muted);
}

/* Narrow editors: the sections become a wrapping strip above the page. */
@media (max-width: 720px) {
  .section-nav {
    flex: none;
    flex-direction: row;
    flex-wrap: wrap;
    align-items: center;
    gap: 2px 4px;
    max-height: 40vh;
    padding: 6px 8px;
    border-right: 0;
    border-bottom: 1px solid var(--k-border);
  }
  .source {
    flex: 1 1 100%;
    padding: 0 4px 4px;
  }
  .read-only {
    flex: 1 1 100%;
    margin: 0 4px 4px;
  }
  .items,
  .favourites {
    flex-direction: row;
    flex-wrap: wrap;
    align-items: center;
  }
  .item {
    width: auto;
    height: 28px;
    gap: 6px;
    padding: 0 8px;
  }
  .favourites {
    flex: 1 1 100%;
    margin-top: 4px;
  }
  .favourites .caps {
    padding: 0 4px;
  }
  .fav .label {
    max-width: 180px;
  }
}
</style>
