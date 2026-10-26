import { describeEndpoint, type DataSource } from '@datakit/core';
import * as vscode from 'vscode';
import { DataSourceNode, KafkaSectionNode, MongoCollectionNode, ObjectNode, RedisDatabaseNode } from '../explorer/nodes';
import { KafkaWorkspacePanel } from '../kafka/kafkaWorkspacePanel';
import { MongoCollectionPanel } from '../mongodb/mongoCollectionPanel';
import { RedisKeysPanel } from '../redis/redisKeysPanel';
import { SqlViewPanel } from '../sql/sqlViewPanel';
import { TableDataPanel } from '../sql/tableDataPanel';
import type { Services } from '../services';
import { connectAndReveal, refreshAll, refreshDataSource } from './actions';
import { DataSourceEditor } from './dataSourceEditor';
import { CancelledError, errorMessage } from './prompts';

/** The data source a command applies to: the tree node it was run on, or one picked from a list. */
export async function target(services: Services, node: unknown): Promise<DataSource | undefined> {
  if (node instanceof DataSourceNode) return services.store.get(node.id);
  const dataSources = services.store.list();
  if (!dataSources.length) {
    void vscode.window.showInformationMessage('No data sources yet.');
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(
    dataSources.map((d) => ({ label: d.name, description: describeEndpoint(d), dataSource: d })),
    { placeHolder: 'Select a data source' },
  );
  return picked?.dataSource;
}

async function confirmDelete(dataSource: DataSource): Promise<boolean> {
  const choice = await vscode.window.showWarningMessage(
    `Delete data source “${dataSource.name}”?`,
    {
      modal: true,
      detail: 'The connection settings and saved passwords are removed. Data on the server is not touched.',
    },
    'Delete',
  );
  return choice === 'Delete';
}

const DOUBLE_CLICK_MS = 500;

/**
 * Opens the data view of a table or view node, the key browser of a Redis database, a Kafka workspace section or a
 * MongoDB collection.
 */
function openData(services: Services, node: unknown): void {
  if (node instanceof RedisDatabaseNode) {
    RedisKeysPanel.show(services, node.parent.id, node.index);
    return;
  }
  if (node instanceof KafkaSectionNode) {
    KafkaWorkspacePanel.show(services, node.parent.id, node.section);
    return;
  }
  if (node instanceof MongoCollectionNode) {
    MongoCollectionPanel.show(services, { dataSourceId: node.parent.parent.id, database: node.parent.name, collection: node.name });
    return;
  }
  if (!(node instanceof ObjectNode) || !['tables', 'views', 'materializedViews'].includes(node.parent.folder)) return;
  TableDataPanel.show(services, { ...node.parent.location, table: node.name });
}

export function registerDataSourceCommands(services: Services): vscode.Disposable[] {
  let lastClick: { id: string; time: number } | undefined;
  const { store, sessions, tree } = services;
  const command = (id: string, run: (dataSource: DataSource) => Promise<void> | void) =>
    vscode.commands.registerCommand(id, async (node?: unknown) => {
      const dataSource = await target(services, node);
      if (dataSource) await run(dataSource);
    });

  return [
    vscode.commands.registerCommand('datakit.addDataSource', () => DataSourceEditor.show(services)),
    vscode.commands.registerCommand('datakit.refreshAll', () => refreshAll(services)),
    vscode.commands.registerCommand('datakit.openTableData', (node?: unknown) => openData(services, node)),
    vscode.commands.registerCommand('datakit.openRedisKeys', (node?: unknown) => openData(services, node)),
    command('datakit.openKafkaWorkspace', (d) => {
      if (d.engine !== 'kafka') {
        void vscode.window.showInformationMessage(`“${d.name}” is not a Kafka data source.`);
        return;
      }
      KafkaWorkspacePanel.show(services, d.id);
    }),
    vscode.commands.registerCommand('datakit.objectClicked', (node: ObjectNode | RedisDatabaseNode | KafkaSectionNode | MongoCollectionNode) => {
      const now = Date.now();
      if (lastClick?.id === node.itemId && now - lastClick.time < DOUBLE_CLICK_MS) {
        lastClick = undefined;
        openData(services, node);
      } else {
        lastClick = { id: node.itemId, time: now };
      }
    }),
    command('datakit.editDataSource', (d) => DataSourceEditor.show(services, d.id)),
    command('datakit.refreshDataSource', (d) => refreshDataSource(services, d)),
    command('datakit.connectDataSource', async (d) => {
      try {
        await connectAndReveal(services, d.id);
      } catch (error) {
        if (!(error instanceof CancelledError)) {
          void vscode.window.showErrorMessage(`Could not connect to “${d.name}”: ${errorMessage(error)}`);
        }
      }
    }),
    command('datakit.disconnectDataSource', async (d) => {
      await sessions.disconnect(d.id);
      tree.collapse(d.id);
    }),
    command('datakit.deleteDataSource', async (d) => {
      if (!(await confirmDelete(d))) return;
      DataSourceEditor.close(d.id);
      SqlViewPanel.closeFor(d.id);
      RedisKeysPanel.closeFor(d.id);
      KafkaWorkspacePanel.closeFor(d.id);
      MongoCollectionPanel.closeFor(d.id);
      await services.kafkaFavourites.deleteFor(d.id);
      await sessions.disconnect(d.id);
      await services.consoles.deleteFor(d.id);
      await services.history.deleteFor(d.id);
      await store.delete(d.id);
      void vscode.window.showInformationMessage(`Deleted “${d.name}”.`);
    }),
  ];
}
