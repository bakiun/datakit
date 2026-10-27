import { describeEndpoint, type DataSource, type EngineId } from '@datakit/core';
import * as vscode from 'vscode';
import { DataSourceNode, EnvironmentNode, KafkaSectionNode, MongoCollectionNode, ObjectNode, RedisDatabaseNode } from '../explorer/nodes';
import { KafkaWorkspacePanel } from '../kafka/kafkaWorkspacePanel';
import { MongoCollectionPanel } from '../mongodb/mongoCollectionPanel';
import { RedisKeysPanel } from '../redis/redisKeysPanel';
import { SqlViewPanel } from '../sql/sqlViewPanel';
import { TableDataPanel } from '../sql/tableDataPanel';
import type { Services } from '../services';
import { connectAndReveal, connectWithProgress, refreshAll, refreshDataSource } from './actions';
import { DataSourceEditor } from './dataSourceEditor';
import { showConnectionError } from './prompts';

export interface TargetOptions {
  /** Only the data sources this accepts are offered. */
  accept?: (dataSource: DataSource) => boolean;
  /** Shown when no data source is accepted; “No data sources yet.” by default. */
  none?: string;
  /** The engine the New Data Source button of that message starts with; `false` shows no button. */
  newEngine?: EngineId | false;
}

/** The data source a command argument names: a data source id, its tree node, or a node under it. */
function dataSourceIdOf(node: unknown): string | undefined {
  if (typeof node === 'string') return node;
  for (let current = node, depth = 0; current && typeof current === 'object' && depth < 10; depth++) {
    if (current instanceof DataSourceNode) return current.id;
    current = (current as { parent?: unknown }).parent;
  }
  return undefined;
}

/** The data source picked last from the list, offered first next time. */
let lastPicked: string | undefined;

/**
 * The data source a command applies to: the one the tree node or id names, or, from the Command Palette, the only
 * one that fits or one picked from a list that starts with the tree's selection and the last pick.
 */
export async function target(services: Services, node: unknown, options: TargetOptions = {}): Promise<DataSource | undefined> {
  const id = dataSourceIdOf(node);
  if (id) return services.store.get(id);
  const candidates = services.store.list().filter(options.accept ?? (() => true));
  if (!candidates.length) {
    const newEngine = options.newEngine;
    const message = options.none ?? 'No data sources yet.';
    if (newEngine === false) void vscode.window.showInformationMessage(message);
    else {
      void vscode.window.showInformationMessage(message, 'New Data Source').then((choice) => {
        if (choice) DataSourceEditor.show(services, undefined, newEngine ? { engine: newEngine } : undefined);
      });
    }
    return undefined;
  }
  if (candidates.length === 1) return candidates[0];
  const selected = dataSourceIdOf(services.view.selection[0]);
  const rank = (d: DataSource) => (d.id === selected ? 0 : d.id === lastPicked ? 1 : 2);
  const picked = await vscode.window.showQuickPick(
    [...candidates].sort((a, b) => rank(a) - rank(b)).map((d) => ({ label: d.name, description: describeEndpoint(d), dataSource: d })),
    { placeHolder: 'Select a data source', matchOnDescription: true },
  );
  if (picked) lastPicked = picked.dataSource.id;
  return picked?.dataSource;
}

async function confirmDelete(services: Services, dataSource: DataSource): Promise<boolean> {
  const consoles = services.consoles.list(dataSource.id).length;
  const removed = consoles ? `Its ${consoles} console${consoles === 1 ? '' : 's'}, query history` : 'Its query history';
  const choice = await vscode.window.showWarningMessage(
    `Delete data source “${dataSource.name}”?`,
    {
      modal: true,
      detail: `${removed} and saved passwords are removed too. Data on the server is not touched.`,
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

/**
 * Opens the key browser of a Redis data source on the database its settings name (db0 when they name none). It
 * connects first, so a password is asked once and the tree shows the connection. An open key browser is brought to
 * the front on the database it shows, without connecting.
 */
/** Opens the key browser on the database the data source is set to; an open one comes to the front and goes back to it. */
async function browseKeys(services: Services, dataSource: DataSource): Promise<void> {
  if (dataSource.engine !== 'redis') return;
  if (!RedisKeysPanel.isOpen(dataSource.id)) {
    try {
      await connectWithProgress(services, dataSource.id);
    } catch (error) {
      showConnectionError(dataSource, error, 'datakit.openRedisKeys');
      return;
    }
  }
  RedisKeysPanel.show(services, dataSource.id, Number(dataSource.database) || 0);
}

export function registerDataSourceCommands(services: Services): vscode.Disposable[] {
  let lastClick: { id: string; time: number } | undefined;
  const { store, sessions, tree } = services;
  const command = (id: string, run: (dataSource: DataSource) => Promise<void> | void, options?: TargetOptions) =>
    vscode.commands.registerCommand(id, async (node?: unknown) => {
      const dataSource = await target(services, node, options);
      if (dataSource) await run(dataSource);
    });
  const isActive = (d: DataSource) => sessions.status(d.id) === 'connected' || sessions.status(d.id) === 'connecting';

  return [
    // Run on an environment folder, the new data source starts in that environment.
    vscode.commands.registerCommand('datakit.addDataSource', (node?: unknown) =>
      DataSourceEditor.show(services, undefined, node instanceof EnvironmentNode ? { environment: node.environment } : undefined),
    ),
    vscode.commands.registerCommand('datakit.refreshAll', () => refreshAll(services)),
    vscode.commands.registerCommand('datakit.openTableData', (node?: unknown) => openData(services, node)),
    // On a database node it opens that database; on a data source, or from the Command Palette, the configured one.
    vscode.commands.registerCommand('datakit.openRedisKeys', async (node?: unknown) => {
      if (node instanceof RedisDatabaseNode) {
        openData(services, node);
        return;
      }
      const dataSource = await target(services, node, {
        accept: (d) => d.engine === 'redis',
        none: 'No Redis data sources yet.',
        newEngine: 'redis',
      });
      if (dataSource) await browseKeys(services, dataSource);
    }),
    command('datakit.openKafkaWorkspace', (d) => KafkaWorkspacePanel.show(services, d.id), {
      accept: (d) => d.engine === 'kafka',
      none: 'No Kafka data sources yet.',
      newEngine: 'kafka',
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
    command(
      'datakit.connectDataSource',
      async (d) => {
        try {
          await connectAndReveal(services, d.id);
        } catch (error) {
          showConnectionError(d, error);
        }
      },
      { accept: (d) => !isActive(d), none: 'Every data source is connected.', newEngine: false },
    ),
    command(
      'datakit.disconnectDataSource',
      async (d) => {
        await sessions.disconnect(d.id);
        tree.collapse(d.id);
      },
      { accept: isActive, none: 'No data source is connected.', newEngine: false },
    ),
    command('datakit.deleteDataSource', async (d) => {
      if (!(await confirmDelete(services, d))) return;
      DataSourceEditor.close(d.id);
      SqlViewPanel.closeFor(d.id);
      RedisKeysPanel.closeFor(d.id);
      KafkaWorkspacePanel.closeFor(d.id);
      MongoCollectionPanel.closeFor(d.id);
      await services.kafkaFavourites.deleteFor(d.id);
      await sessions.disconnect(d.id);
      await services.consoles.deleteFor(d.id);
      await services.history.deleteFor(d.id);
      // The data source disappears from the tree; that is the feedback.
      await store.delete(d.id);
    }),
  ];
}
