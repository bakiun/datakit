import { createApp, type Component } from 'vue';
import { startSavedState } from './composables/usePersistedState';
import DataSourceEditor from './connection/DataSourceEditor.vue';
import KafkaWorkspace from './kafka/KafkaWorkspace.vue';
import MongoCollection from './mongodb/MongoCollection.vue';
import RedisKeys from './redis/RedisKeys.vue';
import QueryConsole from './sql/QueryConsole.vue';
import TableData from './sql/TableData.vue';
import './styles/base.css';

/** Screens by the `data-view` attribute the extension puts on <body>. */
const VIEWS: Record<string, Component> = {
  dataSourceEditor: DataSourceEditor,
  tableData: TableData,
  queryConsole: QueryConsole,
  redisKeys: RedisKeys,
  kafkaWorkspace: KafkaWorkspace,
  mongoCollection: MongoCollection,
};

if (import.meta.env.DEV) {
  const { installDevHost } = await import('./dev/devHost');
  installDevHost();
}

const view = VIEWS[document.body.dataset.view ?? ''];
if (view) {
  startSavedState();
  createApp(view).mount('#app');
}
