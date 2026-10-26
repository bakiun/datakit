import type * as vscode from 'vscode';
import type { DataSourceStore } from './connections/dataSourceStore';
import type { SessionManager } from './connections/sessionManager';
import type { DataSourcesTree } from './explorer/dataSourcesTree';
import type { ExplorerNode } from './explorer/nodes';
import type { KafkaFavourites } from './kafka/favourites';
import type { ConsoleStore } from './sql/consoleStore';
import type { HistoryStore } from './sql/queryHistory';

/** Long-lived objects created on activation and shared by commands and panels. */
export interface Services {
  context: vscode.ExtensionContext;
  store: DataSourceStore;
  sessions: SessionManager;
  consoles: ConsoleStore;
  history: HistoryStore;
  kafkaFavourites: KafkaFavourites;
  tree: DataSourcesTree;
  view: vscode.TreeView<ExplorerNode>;
}
