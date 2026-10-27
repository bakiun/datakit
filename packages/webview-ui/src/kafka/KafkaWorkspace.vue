<script setup lang="ts">
import { KAFKA_SECTIONS } from '@datakit/core';
import { computed, onMounted, onUnmounted } from 'vue';
import Icon from '../components/Icon.vue';
import AclsPage from './AclsPage.vue';
import BrokersPage from './BrokersPage.vue';
import ConnectPage from './ConnectPage.vue';
import ConsumersPage from './ConsumersPage.vue';
import HealthStrip from './HealthStrip.vue';
import KafkaToast from './KafkaToast.vue';
import KsqlPage from './KsqlPage.vue';
import OverviewPage from './OverviewPage.vue';
import SchemasPage from './SchemasPage.vue';
import SectionNav from './SectionNav.vue';
import TopicDetail from './TopicDetail.vue';
import TopicsPage from './TopicsPage.vue';
import { createWorkspace, provideWorkspace } from './workspace';
import './kafka.css';

/**
 * The Kafka workspace of one data source: the section list on the left, the section's page on the right and the
 * cluster's health at the bottom. The overview is read on start and every minute while the page is visible.
 */
const ws = createWorkspace();
provideWorkspace(ws);
const s = ws.state;

const OVERVIEW_EVERY_MS = 60_000;
const label = computed(() => KAFKA_SECTIONS.find((x) => x.id === s.section)?.label ?? '');
/** REST sections without a URL say where to add one. */
const missing = computed(() => {
  const init = s.init;
  if (!init) return null;
  if (s.section === 'schemas' && init.schemaRegistryUrl === null) return 'Schema Registry';
  if (s.section === 'connect' && init.connectUrl === null) return 'Kafka Connect';
  if (s.section === 'ksql' && init.ksqlDbUrl === null) return 'ksqlDB';
  return null;
});

function checkOverview(): void {
  if (!s.init || document.visibilityState !== 'visible' || s.loading.overview) return;
  const checkedAt = s.overview?.overview.checkedAt ?? 0;
  if (Date.now() - checkedAt >= OVERVIEW_EVERY_MS - 1000) ws.load('overview');
}

const timer = setInterval(checkOverview, OVERVIEW_EVERY_MS);
document.addEventListener('visibilitychange', checkOverview);

function retry(): void {
  s.initError = null;
  ws.post({ type: 'ready' });
}

/** The workspace picks up the saved settings by itself. */
const editDataSource = () => ws.post({ type: 'editDataSource' });

onMounted(() => ws.post({ type: 'ready' }));
onUnmounted(() => {
  clearInterval(timer);
  document.removeEventListener('visibilitychange', checkOverview);
  ws.stop();
});
</script>

<template>
  <div v-if="s.initError" class="failed">
    <p role="alert"><Icon name="error" :size="14" /> {{ s.initError }}</p>
    <div class="failed-actions">
      <button type="button" class="btn btn-primary" @click="retry">Retry</button>
      <button type="button" class="btn" @click="editDataSource">Edit data source</button>
    </div>
    <p class="note">The workspace opens by itself once the data source connects.</p>
  </div>
  <div v-else-if="!s.init" class="opening note">Opening Kafka workspace…</div>
  <div v-else class="kafka-workspace">
    <div class="body">
      <SectionNav />
      <main class="content" :aria-label="label">
        <section v-if="missing" class="page">
          <header class="page-head"><h1>{{ missing }}</h1></header>
          <p class="empty-state not-configured">
            No {{ missing }} URL is set for this data source.
            <button type="button" class="lnk" @click="editDataSource">Add it on the General tab</button>
          </p>
        </section>
        <OverviewPage v-else-if="s.section === 'overview'" />
        <BrokersPage v-else-if="s.section === 'brokers'" />
        <TopicDetail v-else-if="s.section === 'topics' && s.topic" :key="s.topic" :name="s.topic" />
        <TopicsPage v-else-if="s.section === 'topics'" />
        <ConsumersPage v-else-if="s.section === 'consumers'" />
        <AclsPage v-else-if="s.section === 'acls'" />
        <SchemasPage v-else-if="s.section === 'schemas'" />
        <ConnectPage v-else-if="s.section === 'connect'" />
        <!-- The statement and its last result stay when another section is opened. -->
        <KeepAlive>
          <KsqlPage v-if="s.section === 'ksql' && !missing" />
        </KeepAlive>
      </main>
    </div>
    <HealthStrip />
    <KafkaToast />
  </div>
</template>

<style scoped>
.kafka-workspace {
  height: 100vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.opening,
.failed {
  padding: 24px 28px;
}
.failed p[role='alert'] {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--vscode-errorForeground);
}
.failed-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 10px;
}
.body {
  flex: 1;
  min-height: 0;
  display: flex;
}
.content {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.not-configured {
  padding: 4px 20px;
  font-size: 13px;
}
@media (max-width: 720px) {
  .body {
    flex-direction: column;
  }
}
</style>
