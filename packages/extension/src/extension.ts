import * as vscode from 'vscode';
import { registerDataSourceCommands } from './connections/commands';
import { DataSourceEditor } from './connections/dataSourceEditor';
import { DataSourceStore } from './connections/dataSourceStore';
import { SessionManager } from './connections/sessionManager';
import { DATA_SOURCES_VIEW, DataSourcesTree } from './explorer/dataSourcesTree';
import { registerFilterCommands } from './explorer/filter';
import type { Services } from './services';
import { registerConsoleCommands } from './sql/consoleCommands';
import { registerPostgresCommands } from './sql/postgresCommands';
import { ConsoleStore } from './sql/consoleStore';
import { registerHistoryCommands } from './sql/historyCommands';
import { HistoryStore, QUERY_HISTORY_VIEW, QueryHistoryTree } from './sql/queryHistory';
import { KafkaFavourites } from './kafka/favourites';
import { KafkaWorkspacePanel } from './kafka/kafkaWorkspacePanel';
import { registerMongoCommands } from './mongodb/mongoCommands';
import { MongoCollectionPanel } from './mongodb/mongoCollectionPanel';
import { QueryConsolePanel } from './sql/queryConsolePanel';
import { RedisKeysPanel } from './redis/redisKeysPanel';
import { SqlViewPanel } from './sql/sqlViewPanel';
import { TableDataPanel, type TableRef } from './sql/tableDataPanel';
import { registerPanelSerializers, restoreOrDispose, type PanelRestorer } from './webview/panelSerializer';

/** Returned only to the end-to-end tests. */
export type TestApi = Pick<Services, 'store' | 'sessions' | 'consoles' | 'history' | 'tree' | 'view'> & {
  historyTree: QueryHistoryTree;
  onDidLoadEditor: vscode.Event<string | null>;
  onDidLoadTableData: vscode.Event<TableRef>;
  onDidPostTableData: typeof TableDataPanel.onDidPost;
  sendToTableData: typeof TableDataPanel.receive;
  onDidLoadConsole: typeof QueryConsolePanel.onDidLoad;
  onDidPostConsole: typeof QueryConsolePanel.onDidPost;
  sendToConsole: typeof QueryConsolePanel.receive;
  onDidLoadRedis: typeof RedisKeysPanel.onDidLoad;
  onDidPostRedis: typeof RedisKeysPanel.onDidPost;
  sendToRedis: typeof RedisKeysPanel.receive;
  onDidLoadKafka: typeof KafkaWorkspacePanel.onDidLoad;
  onDidPostKafka: typeof KafkaWorkspacePanel.onDidPost;
  sendToKafka: typeof KafkaWorkspacePanel.receive;
  onDidLoadMongo: typeof MongoCollectionPanel.onDidLoad;
  onDidPostMongo: typeof MongoCollectionPanel.onDidPost;
  sendToMongo: typeof MongoCollectionPanel.receive;
  /** Does what the serializer of `viewType` does when VS Code restores a tab; tells whether the panel came back. */
  restorePanel(viewType: string, panel: vscode.WebviewPanel, state: unknown): Promise<boolean>;
};

export function activate(context: vscode.ExtensionContext): TestApi | undefined {
  const store = new DataSourceStore(context);
  const sessions = new SessionManager(store);
  const consoles = new ConsoleStore(context);
  const history = new HistoryStore(context);
  const tree = new DataSourcesTree(store, sessions, consoles, context.extensionUri);
  const view = vscode.window.createTreeView(DATA_SOURCES_VIEW, { treeDataProvider: tree, showCollapseAll: true });
  const historyTree = new QueryHistoryTree(history, store);
  const historyView = vscode.window.createTreeView(QUERY_HISTORY_VIEW, { treeDataProvider: historyTree });
  const kafkaFavourites = new KafkaFavourites(context.globalState);
  const services: Services = { context, store, sessions, consoles, history, kafkaFavourites, tree, view };
  /** Tabs that come back when VS Code opens the window again; package.json activates on each of these view types. */
  const restorers: Record<string, PanelRestorer> = {
    [DataSourceEditor.viewType]: (panel, state) => DataSourceEditor.restore(services, panel, state),
    [TableDataPanel.viewType]: (panel, state) => TableDataPanel.restore(services, panel, state),
    [QueryConsolePanel.viewType]: (panel, state) => QueryConsolePanel.restore(services, panel, state),
    [MongoCollectionPanel.viewType]: (panel, state) => MongoCollectionPanel.restore(services, panel, state),
    [RedisKeysPanel.viewType]: (panel, state) => RedisKeysPanel.restore(services, panel, state),
    [KafkaWorkspacePanel.viewType]: (panel, state) => KafkaWorkspacePanel.restore(services, panel, state),
  };

  context.subscriptions.push(
    store,
    sessions,
    consoles,
    history,
    tree,
    view,
    historyTree,
    historyView,
    ...registerDataSourceCommands(services),
    ...registerFilterCommands(services),
    ...registerConsoleCommands(services),
    ...registerHistoryCommands(services),
    ...registerPostgresCommands(services),
    ...registerMongoCommands(services),
    ...registerPanelSerializers(restorers),
    { dispose: () => SqlViewPanel.disposeAll() },
    { dispose: () => RedisKeysPanel.disposeAll() },
    { dispose: () => KafkaWorkspacePanel.disposeAll() },
    { dispose: () => MongoCollectionPanel.disposeAll() },
  );
  sessions.connectOnStartup();
  return context.extensionMode === vscode.ExtensionMode.Test
    ? {
        store,
        sessions,
        consoles,
        history,
        tree,
        view,
        historyTree,
        onDidLoadEditor: DataSourceEditor.onDidLoad,
        onDidLoadTableData: TableDataPanel.onDidLoad,
        onDidPostTableData: TableDataPanel.onDidPost,
        sendToTableData: (ref, message) => TableDataPanel.receive(ref, message),
        onDidLoadConsole: QueryConsolePanel.onDidLoad,
        onDidPostConsole: QueryConsolePanel.onDidPost,
        sendToConsole: (id, message) => QueryConsolePanel.receive(id, message),
        onDidLoadRedis: RedisKeysPanel.onDidLoad,
        onDidPostRedis: RedisKeysPanel.onDidPost,
        sendToRedis: (id, message) => RedisKeysPanel.receive(id, message),
        onDidLoadKafka: KafkaWorkspacePanel.onDidLoad,
        onDidPostKafka: KafkaWorkspacePanel.onDidPost,
        sendToKafka: (id, message) => KafkaWorkspacePanel.receive(id, message),
        onDidLoadMongo: MongoCollectionPanel.onDidLoad,
        onDidPostMongo: MongoCollectionPanel.onDidPost,
        sendToMongo: (ref, message) => MongoCollectionPanel.receive(ref, message),
        restorePanel: async (viewType, panel, state) => {
          const restore = restorers[viewType];
          return restore ? restoreOrDispose(restore, panel, state) : false;
        },
      }
    : undefined;
}

export function deactivate(): void {}
