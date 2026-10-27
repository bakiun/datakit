import {
  choiceLabel,
  describeEndpoint,
  ENVIRONMENTS,
  formatServerVersion,
  getEngine,
  isPostgresSession,
  KAFKA_SECTIONS,
  MYSQL_DRIVERS,
  orderDatabases,
  shortServerVersion,
  type DatabaseObjects,
  type DataSource,
  type Environment,
  type KafkaOverview,
  type KafkaSection,
  type MongoCollectionInfo,
  type MongoDatabaseInfo,
  type ObjectMatch,
  type PgSchemaObjects,
  type PostgresSession,
  type RedisDatabase,
  type SqlSession,
} from '@datakit/core';
import * as vscode from 'vscode';
import type { DataSourceStore } from '../connections/dataSourceStore';
import { CancelledError, errorMessage } from '../connections/prompts';
import { asSql, type ConnectionStatus, type SessionManager } from '../connections/sessionManager';
import type { ConsoleStore } from '../sql/consoleStore';
import {
  ConsoleNode,
  ConsolesNode,
  DatabaseNode,
  DataSourceNode,
  EnvironmentNode,
  FolderNode,
  KafkaSectionNode,
  MessageNode,
  MongoCollectionNode,
  MongoDatabaseNode,
  ObjectNode,
  RedisDatabaseNode,
  SchemaNode,
  type ExplorerNode,
  type FolderItem,
  type FolderKind,
} from './nodes';

export const DATA_SOURCES_VIEW = 'datakit.dataSources';

/** `context` is the context value of the objects of a PostgreSQL schema's folder. */
const FOLDERS: readonly { kind: FolderKind; label: string; icon: string; color: string; context: string }[] = [
  { kind: 'tables', label: 'Tables', icon: 'table', color: 'charts.blue', context: 'pgTable' },
  { kind: 'views', label: 'Views', icon: 'eye', color: 'charts.blue', context: 'pgView' },
  { kind: 'materializedViews', label: 'Materialized views', icon: 'layers', color: 'charts.blue', context: 'pgMaterializedView' },
  { kind: 'sequences', label: 'Sequences', icon: 'symbol-number', color: 'charts.orange', context: 'pgSequence' },
  { kind: 'procedures', label: 'Procedures', icon: 'symbol-method', color: 'charts.purple', context: 'pgProcedure' },
  { kind: 'functions', label: 'Functions', icon: 'symbol-function', color: 'charts.purple', context: 'pgFunction' },
  { kind: 'types', label: 'Types', icon: 'symbol-enum', color: 'charts.green', context: 'pgType' },
];

/** Folders of a table or view that open in the data view. */
const DATA_FOLDERS = new Set<FolderKind>(['tables', 'views', 'materializedViews']);

function asPostgres(session: SqlSession): PostgresSession {
  if (!isPostgresSession(session)) throw new Error('This is not a PostgreSQL data source.');
  return session;
}

const KAFKA_SECTION_ICONS: Record<KafkaSection, string> = {
  overview: 'dashboard',
  brokers: 'server',
  topics: 'list-unordered',
  consumers: 'organization',
  acls: 'shield',
  schemas: 'symbol-structure',
  connect: 'plug',
  ksql: 'terminal',
};

/** REST sections are listed only when the data source names their service. */
const KAFKA_SERVICE_URLS: Partial<Record<KafkaSection, 'schemaRegistryUrl' | 'connectUrl' | 'ksqlDbUrl'>> = {
  schemas: 'schemaRegistryUrl',
  connect: 'connectUrl',
  ksql: 'ksqlDbUrl',
};

/** Staging and production folders are colored so they stand out; development stays plain. */
const ENVIRONMENT_COLORS: Partial<Record<Environment, string>> = { staging: 'charts.orange', production: 'charts.red' };

/** Databases MongoDB keeps for itself; they are listed last. */
const MONGO_SYSTEM_DATABASES = new Set(['admin', 'config', 'local']);

const STATUS_TEXT: Record<ConnectionStatus, string> = {
  idle: 'Not connected',
  connecting: 'Connecting…',
  connected: 'Connected',
  failed: 'Connection failed',
};

const rowCount = new Intl.NumberFormat('en-US');

/** Objects the filter shows per data source at most. */
export const FILTER_MATCH_LIMIT = 500;

export class DataSourcesTree implements vscode.TreeDataProvider<ExplorerNode>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<ExplorerNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly roots = new Map<string, DataSourceNode>();
  private readonly epochs = new Map<string, number>();
  /** The last connection status seen per data source, to tell a cancelled connect from the others. */
  private readonly statuses = new Map<string, ConnectionStatus>();
  private readonly databases = new Map<string, Promise<string[]>>();
  private readonly objects = new Map<string, Promise<DatabaseObjects>>();
  /** PostgreSQL schemas by `id\ndatabase`, and their objects by `id\ndatabase\nschema`. */
  private readonly schemas = new Map<string, Promise<string[]>>();
  private readonly schemaObjects = new Map<string, Promise<PgSchemaObjects>>();
  private readonly redisDatabases = new Map<string, Promise<RedisDatabase[]>>();
  private readonly kafkaOverviews = new Map<string, Promise<KafkaOverview>>();
  private readonly mongoDatabases = new Map<string, Promise<MongoDatabaseInfo[]>>();
  private readonly mongoCollections = new Map<string, Promise<MongoCollectionInfo[]>>();
  private readonly listeners: vscode.Disposable[];
  private filter = '';
  private filterRun = 0;
  /** What the filter found in each connected data source. */
  private readonly matches = new Map<string, Promise<ObjectMatch[]>>();
  /** Ids of the data sources the filter showed when the top level was last read. */
  private shown = new Set<string>();
  private readonly messageChanged = new vscode.EventEmitter<string | undefined>();
  /** Fires with the text to show above the tree, which explains the active filter. */
  readonly onDidChangeMessage = this.messageChanged.event;

  constructor(
    private readonly store: DataSourceStore,
    private readonly sessions: SessionManager,
    private readonly consoles: ConsoleStore,
    private readonly extensionUri: vscode.Uri,
  ) {
    this.listeners = [
      store.onDidChange(() => this.changed.fire(undefined)),
      consoles.onDidChange((id) => this.changed.fire(this.roots.get(id))),
      sessions.onDidChangeStatus((id) => {
        const status = sessions.status(id);
        const was = this.statuses.get(id);
        this.statuses.set(id, status);
        // Metadata belongs to a session; keep it only while that session is connected.
        if (status !== 'connected') this.clearCache(id);
        // A dismissed password prompt leaves the data source idle. Folding it keeps its expanded node from asking
        // again at once; expanding it again asks again.
        if (was === 'connecting' && status === 'idle') {
          this.collapse(id);
          return;
        }
        // Under a filter a data source can appear or disappear once it can be searched.
        this.changed.fire(this.filter ? undefined : this.roots.get(id));
      }),
    ];
  }

  /** The node of a data source, e.g. to reveal it. */
  nodeFor(id: string): DataSourceNode {
    const epoch = this.epochs.get(id) ?? 0;
    let node = this.roots.get(id);
    if (!node || node.epoch !== epoch || node.view !== this.view) this.roots.set(id, (node = new DataSourceNode(id, epoch, this.view)));
    return node;
  }

  /** Names the active filter in item ids, so what it shows gets its own ids and open state. */
  private get view(): string {
    return this.filter ? `/filter${this.filterRun}` : '';
  }

  get filterText(): string {
    return this.filter;
  }

  /**
   * Shows only what contains `text`, ignoring case: data sources by name and, in connected ones, databases,
   * tables, views and routines. Data sources that are not connected are matched by name only; the filter does
   * not connect them. Empty text clears the filter.
   */
  setFilter(text: string): void {
    const filter = text.trim();
    if (filter === this.filter) return;
    this.filter = filter;
    this.filterRun++;
    this.matches.clear();
    void vscode.commands.executeCommand('setContext', 'datakit.dataSources.filtered', filter !== '');
    this.changed.fire(undefined);
  }

  /** Re-reads the list of data sources. */
  refresh(): void {
    this.changed.fire(undefined);
  }

  /** Reads the databases and objects of a data source again, e.g. after a collection was created or dropped. */
  reload(id: string): void {
    this.clearCache(id);
    this.changed.fire(this.roots.get(id));
  }

  /** Shows the data source collapsed; used after Disconnect. */
  collapse(id: string): void {
    this.epochs.set(id, (this.epochs.get(id) ?? 0) + 1);
    this.clearCache(id);
    this.changed.fire(undefined);
  }

  getParent(node: ExplorerNode): ExplorerNode | undefined {
    if (node.kind === 'environment') return undefined;
    if (node.kind !== 'dataSource') return node.parent;
    const environment = this.store.get(node.id)?.environment;
    return environment ? new EnvironmentNode(environment, this.view) : undefined;
  }

  async getChildren(node?: ExplorerNode): Promise<ExplorerNode[]> {
    if (!node) {
      const dataSources = this.store.list();
      for (const id of this.roots.keys()) if (!dataSources.some((d) => d.id === id)) this.roots.delete(id);
      const shown = await this.filtered(dataSources);
      this.shown = new Set(shown.map((d) => d.id));
      return ENVIRONMENTS.filter((e) => shown.some((d) => d.environment === e.value)).map((e) => new EnvironmentNode(e.value, this.view));
    }
    switch (node.kind) {
      case 'environment':
        return this.inEnvironment(node.environment).map((d) => this.nodeFor(d.id));
      case 'dataSource': {
        const engine = this.store.get(node.id)?.engine;
        if (engine === 'redis') return this.redisDatabaseNodes(node);
        if (engine === 'kafka') return this.kafkaSectionNodes(node);
        if (engine === 'mongodb') return this.mongoDatabaseNodes(node);
        // Consoles are listed without connecting; under a filter only the matching objects are.
        const consoles = this.consoles.list(node.id).length && !(this.filter && !this.matchesName(this.store.get(node.id)?.name ?? ''));
        const databases = engine === 'postgres' ? await this.postgresDatabaseNodes(node) : await this.databaseNodes(node);
        return [...(consoles ? [new ConsolesNode(node)] : []), ...databases];
      }
      case 'consoles':
        return this.consoles.list(node.parent.id).map((c) => new ConsoleNode(node, c.id));
      case 'mongoDatabase':
        return this.mongoCollectionNodes(node);
      case 'database':
        return this.store.get(node.parent.id)?.engine === 'postgres' ? this.schemaNodes(node) : this.folderNodes(node);
      case 'schema':
        return this.schemaFolderNodes(node);
      case 'folder':
        return node.items.map((item) => new ObjectNode(node, item.name, item.rows, item.detail));
      default:
        return [];
    }
  }

  getTreeItem(node: ExplorerNode): vscode.TreeItem {
    switch (node.kind) {
      case 'environment': {
        const label = choiceLabel(ENVIRONMENTS, node.environment);
        const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Expanded);
        item.id = node.itemId;
        const color = ENVIRONMENT_COLORS[node.environment];
        item.iconPath = new vscode.ThemeIcon('folder', color ? new vscode.ThemeColor(color) : undefined);
        item.description = String(this.inEnvironment(node.environment).length);
        item.tooltip = node.environment === 'production' ? 'Production data sources — writes need confirmation' : `${label} data sources`;
        item.contextValue = 'environment';
        return item;
      }
      case 'dataSource':
        return this.dataSourceItem(node);
      case 'consoles': {
        const item = new vscode.TreeItem('Consoles', vscode.TreeItemCollapsibleState.Collapsed);
        item.id = node.itemId;
        item.iconPath = new vscode.ThemeIcon('folder');
        item.description = String(this.consoles.list(node.parent.id).length);
        item.contextValue = 'consoles';
        return item;
      }
      case 'console': {
        const queryConsole = this.consoles.get(node.consoleId);
        const item = new vscode.TreeItem(queryConsole?.name ?? '…', vscode.TreeItemCollapsibleState.None);
        item.id = node.itemId;
        item.iconPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'icons', 'console.svg');
        // A PostgreSQL console also names its schema.
        const runsIn = queryConsole?.database ? `${queryConsole.database}${queryConsole.schema ? `.${queryConsole.schema}` : ''}` : undefined;
        item.description = runsIn;
        item.tooltip = `${queryConsole?.name ?? ''}${runsIn ? ` — runs in ${runsIn}` : ''}`;
        item.contextValue = 'console';
        item.command = { command: 'datakit.openConsole', title: 'Open Console', arguments: [node] };
        return item;
      }
      case 'database': {
        const isDefault = this.defaultDatabase(node.parent.id) === node.name;
        // A PostgreSQL data source opens on the database it connects to.
        const opens = node.matches || (isDefault && this.store.get(node.parent.id)?.engine === 'postgres');
        const state = opens ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed;
        const item = new vscode.TreeItem(this.label(node.name), state);
        item.id = node.itemId;
        item.iconPath = new vscode.ThemeIcon('database');
        item.contextValue = 'database';
        if (isDefault) item.description = 'default';
        return item;
      }
      case 'schema': {
        // The default database opens on its public schema.
        const opens = node.matches || (node.name === 'public' && this.defaultDatabase(node.parent.parent.id) === node.parent.name);
        const item = new vscode.TreeItem(this.label(node.name), opens ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
        item.id = node.itemId;
        item.iconPath = new vscode.ThemeIcon('symbol-namespace');
        item.contextValue = 'pgSchema';
        item.tooltip = `Schema ${node.name} of ${node.parent.name}`;
        return item;
      }
      case 'folder': {
        const folder = FOLDERS.find((f) => f.kind === node.folder)!;
        const open = node.parent.matches ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed;
        const state = node.items.length ? open : vscode.TreeItemCollapsibleState.None;
        const item = new vscode.TreeItem(folder.label, state);
        item.id = node.itemId;
        item.description = String(node.items.length);
        item.contextValue = `folder.${node.folder}`;
        return item;
      }
      case 'object': {
        const folder = FOLDERS.find((f) => f.kind === node.parent.folder)!;
        const postgres = node.parent.parent.kind === 'schema';
        const item = new vscode.TreeItem(this.label(node.name), vscode.TreeItemCollapsibleState.None);
        item.id = node.itemId;
        item.iconPath = new vscode.ThemeIcon(folder.icon, new vscode.ThemeColor(folder.color));
        item.contextValue = postgres ? folder.context : folder.kind.slice(0, -1);
        const opensData = DATA_FOLDERS.has(folder.kind);
        if (node.rows !== null) item.description = rowCount.format(node.rows);
        // Routines show their arguments, which tell overloads apart; types show whether they are an enum, a domain…
        else if (node.detail !== undefined) item.description = folder.kind === 'types' ? node.detail : `(${node.detail})`;
        const rows = node.rows === null ? '' : ` — about ${rowCount.format(node.rows)} rows (server estimate)`;
        const signature = node.detail !== undefined && folder.kind !== 'types' ? `(${node.detail})` : '';
        item.tooltip = `${node.name}${signature}${rows}${opensData ? '\nDouble-click to open the data.' : ''}`;
        // VS Code runs item commands on every click; the command opens the data view on the second one.
        if (opensData) item.command = { command: 'datakit.objectClicked', title: 'Open Data', arguments: [node] };
        return item;
      }
      case 'redisDatabase': {
        const item = new vscode.TreeItem(`db${node.index}`, vscode.TreeItemCollapsibleState.None);
        item.id = node.itemId;
        item.iconPath = new vscode.ThemeIcon('database');
        item.description = node.keys ? `${rowCount.format(node.keys)} key${node.keys === 1 ? '' : 's'}` : 'empty';
        item.tooltip = `Database ${node.index}\nDouble-click to browse its keys.`;
        item.contextValue = 'redisDatabase';
        // VS Code runs item commands on every click; the command opens the key browser on the second one.
        item.command = { command: 'datakit.objectClicked', title: 'Browse Keys', arguments: [node] };
        return item;
      }
      case 'mongoDatabase': {
        const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.Collapsed);
        item.id = node.itemId;
        item.iconPath = new vscode.ThemeIcon('database');
        item.contextValue = 'mongoDatabase';
        const isDefault = this.store.get(node.parent.id)?.database.trim() === node.name;
        item.description = [isDefault ? 'default' : '', node.empty ? 'empty' : ''].filter(Boolean).join(' · ') || undefined;
        return item;
      }
      case 'mongoCollection': {
        const info = node.info;
        const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.None);
        item.id = node.itemId;
        const icon = info.type === 'view' ? 'eye' : info.type === 'timeseries' ? 'graph-line' : 'json';
        item.iconPath = new vscode.ThemeIcon(icon, new vscode.ThemeColor(info.type === 'view' ? 'charts.blue' : 'charts.green'));
        if (info.documents !== null) item.description = rowCount.format(info.documents);
        const kind = info.type === 'view' ? `View on ${info.viewOn ?? '?'}` : info.type === 'timeseries' ? 'Time series collection' : info.capped ? 'Capped collection' : 'Collection';
        const count = info.documents === null ? '' : ` — about ${rowCount.format(info.documents)} documents`;
        item.tooltip = `${node.name}\n${kind}${count}\nDouble-click to open it.`;
        item.contextValue = info.type === 'view' ? 'mongoView' : 'mongoCollection';
        // VS Code runs item commands on every click; the command opens the collection on the second one.
        item.command = { command: 'datakit.objectClicked', title: 'Open Collection', arguments: [node] };
        return item;
      }
      case 'kafkaSection': {
        const label = KAFKA_SECTIONS.find((s) => s.id === node.section)!.label;
        const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
        item.id = node.itemId;
        item.iconPath = new vscode.ThemeIcon(KAFKA_SECTION_ICONS[node.section]);
        if (node.count !== null) item.description = rowCount.format(node.count);
        item.tooltip = `${label}\nDouble-click to open it in the Kafka workspace.`;
        item.contextValue = 'kafkaSection';
        // VS Code runs item commands on every click; the command opens the workspace on the second one.
        item.command = { command: 'datakit.objectClicked', title: 'Open Workspace', arguments: [node] };
        return item;
      }
      case 'message': {
        const item = new vscode.TreeItem(node.message, vscode.TreeItemCollapsibleState.None);
        item.id = node.itemId;
        item.iconPath = node.isError ? new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground')) : new vscode.ThemeIcon('info');
        // A failed connection offers Retry and Edit Data Source beside the error; a failed listing below it, Retry.
        if (node.isError) {
          const connection = node.parent.kind === 'dataSource';
          item.contextValue = connection ? 'connectionError' : 'listingError';
          item.tooltip = `${node.message}\n\n${connection ? 'Retry, or edit the data source to fix its settings.' : 'Retry to read it again.'}`;
        } else {
          item.tooltip = node.message;
        }
        return item;
      }
    }
  }

  dispose(): void {
    for (const listener of this.listeners) listener.dispose();
    this.changed.dispose();
    this.messageChanged.dispose();
  }

  private dataSourceItem(node: DataSourceNode): vscode.TreeItem {
    const dataSource = this.store.get(node.id);
    if (!dataSource) return new vscode.TreeItem('…');
    const status = this.sessions.status(node.id);
    const session = this.sessions.session(node.id);
    // Under a filter, a data source shown for what it contains opens on its matches.
    const state =
      this.filter && !this.matchesName(dataSource.name) ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed;
    const item = new vscode.TreeItem(this.label(dataSource.name), state);
    item.id = node.itemId;
    item.description = session ? shortServerVersion(session.serverVersion) : describeEndpoint(dataSource);
    item.contextValue = `dataSource.${status === 'connected' || status === 'connecting' ? status : 'disconnected'}.${dataSource.engine}`;
    if (status === 'connecting') {
      item.iconPath = new vscode.ThemeIcon('loading~spin');
    } else {
      const variant = status === 'connected' || status === 'failed' ? status : 'idle';
      item.iconPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'icons', `${dataSource.engine}-${variant}.svg`);
    }
    item.tooltip = this.tooltip(dataSource, status);
    return item;
  }

  private tooltip(dataSource: DataSource, status: ConnectionStatus): vscode.MarkdownString {
    const tip = new vscode.MarkdownString();
    const session = this.sessions.session(dataSource.id);
    const engine = getEngine(dataSource.engine).name;
    const driver = dataSource.engine === 'mysql' ? choiceLabel(MYSQL_DRIVERS, dataSource.driver) : engine;
    tip.appendMarkdown('**').appendText(dataSource.name).appendMarkdown('**\n\n');
    tip.appendText(`${driver === engine ? engine : `${engine} (${driver})`} · ${describeEndpoint(dataSource)}`);
    tip.appendText(` · ${choiceLabel(ENVIRONMENTS, dataSource.environment)}`).appendMarkdown('\n\n');
    if (session) tip.appendText(`${STATUS_TEXT[status]} — ${formatServerVersion(session.serverVersion)}`);
    else if (status === 'failed') tip.appendText(`${STATUS_TEXT[status]}: ${this.sessions.error(dataSource.id) ?? ''}`);
    else tip.appendText(STATUS_TEXT[status]);
    if (dataSource.comment.trim()) tip.appendMarkdown('\n\n').appendText(dataSource.comment.trim());
    return tip;
  }

  private async databaseNodes(node: DataSourceNode): Promise<ExplorerNode[]> {
    if (this.sessions.status(node.id) === 'failed') {
      return [new MessageNode(node, this.sessions.error(node.id) ?? 'Connection failed.', true)];
    }
    try {
      const names = await this.cached(this.databases, node.id, async () => (await this.sessions.connectSql(node.id)).listDatabases());
      const matching = await this.matchingDatabases(node, names);
      if (matching) return matching;
      return names.length ? names.map((name) => new DatabaseNode(node, name)) : [new MessageNode(node, 'No databases', false)];
    } catch (error) {
      this.databases.delete(node.id);
      return error instanceof CancelledError ? [] : [new MessageNode(node, errorMessage(error), true)];
    }
  }

  /** The databases that hold keys, and the one the data source names, with their key counts. */
  private async redisDatabaseNodes(node: DataSourceNode): Promise<ExplorerNode[]> {
    if (this.sessions.status(node.id) === 'failed') {
      return [new MessageNode(node, this.sessions.error(node.id) ?? 'Connection failed.', true)];
    }
    try {
      const databases = await this.cached(this.redisDatabases, node.id, async () => (await this.sessions.connectRedis(node.id)).databases());
      const configured = Number(this.store.get(node.id)?.database) || 0;
      return databases.filter((d) => d.keys > 0 || d.index === configured).map((d) => new RedisDatabaseNode(node, d.index, d.keys));
    } catch (error) {
      this.redisDatabases.delete(node.id);
      return error instanceof CancelledError ? [] : [new MessageNode(node, errorMessage(error), true)];
    }
  }

  /** The databases, the default one first and MongoDB's own ones last. */
  private async mongoDatabaseNodes(node: DataSourceNode): Promise<ExplorerNode[]> {
    if (this.sessions.status(node.id) === 'failed') {
      return [new MessageNode(node, this.sessions.error(node.id) ?? 'Connection failed.', true)];
    }
    try {
      const databases = await this.cached(this.mongoDatabases, node.id, async () => (await this.sessions.connectMongo(node.id)).databases());
      const configured = this.store.get(node.id)?.database.trim() ?? '';
      const rank = (name: string) => (name === configured ? 0 : MONGO_SYSTEM_DATABASES.has(name) ? 2 : 1);
      const sorted = [...databases].sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
      // A configured database that holds nothing yet is not listed by the server; show it anyway.
      if (configured && !sorted.some((d) => d.name === configured)) sorted.unshift({ name: configured, sizeOnDisk: 0, empty: true });
      return sorted.length ? sorted.map((d) => new MongoDatabaseNode(node, d.name, d.empty)) : [new MessageNode(node, 'No databases', false)];
    } catch (error) {
      this.mongoDatabases.delete(node.id);
      return error instanceof CancelledError ? [] : [new MessageNode(node, errorMessage(error), true)];
    }
  }

  private async mongoCollectionNodes(node: MongoDatabaseNode): Promise<ExplorerNode[]> {
    const id = node.parent.id;
    const key = `${id}\n${node.name}`;
    try {
      const collections = await this.cached(this.mongoCollections, key, async () => (await this.sessions.connectMongo(id)).collections(node.name));
      // system.views, system.profile and the like are MongoDB's own.
      const sorted = collections.filter((c) => !c.name.startsWith('system.')).sort((a, b) => a.name.localeCompare(b.name));
      return sorted.length ? sorted.map((c) => new MongoCollectionNode(node, c)) : [new MessageNode(node, 'No collections', false)];
    } catch (error) {
      this.mongoCollections.delete(key);
      return error instanceof CancelledError ? [] : [new MessageNode(node, errorMessage(error), true)];
    }
  }

  /** The workspace sections, with broker, topic and group counts from the cluster overview. */
  private async kafkaSectionNodes(node: DataSourceNode): Promise<ExplorerNode[]> {
    if (this.sessions.status(node.id) === 'failed') {
      return [new MessageNode(node, this.sessions.error(node.id) ?? 'Connection failed.', true)];
    }
    try {
      const overview = await this.cached(this.kafkaOverviews, node.id, async () => (await this.sessions.connectKafka(node.id)).overview());
      const kafka = this.store.get(node.id)?.kafka;
      const counts: Partial<Record<KafkaSection, number>> = {
        brokers: overview.brokers.filter((b) => b.online).length,
        topics: overview.topics,
        consumers: overview.groups.length,
      };
      return KAFKA_SECTIONS.filter((s) => {
        const url = KAFKA_SERVICE_URLS[s.id];
        return !url || !!kafka?.[url].trim();
      }).map((s) => new KafkaSectionNode(node, s.id, counts[s.id] ?? null));
    } catch (error) {
      this.kafkaOverviews.delete(node.id);
      return error instanceof CancelledError ? [] : [new MessageNode(node, errorMessage(error), true)];
    }
  }

  private async folderNodes(node: DatabaseNode): Promise<ExplorerNode[]> {
    if (node.matches) return this.matchFolders(node, node.matches);
    const id = node.parent.id;
    const key = `${id}\n${node.name}`;
    try {
      const objects = await this.cached(this.objects, key, async () => (await this.sessions.connectSql(id)).listObjects(node.name));
      const named = (names: string[]) => names.map((name) => ({ name, rows: null }));
      return [
        new FolderNode(node, 'tables', objects.tables),
        new FolderNode(node, 'views', named(objects.views)),
        new FolderNode(node, 'procedures', named(objects.procedures)),
        new FolderNode(node, 'functions', named(objects.functions)),
      ];
    } catch (error) {
      this.objects.delete(key);
      return error instanceof CancelledError ? [] : [new MessageNode(node, errorMessage(error), true)];
    }
  }

  /** The data sources in an environment's folder; under a filter, those it showed when the top level was last read. */
  private inEnvironment(environment: Environment): DataSource[] {
    return this.store.list().filter((d) => d.environment === environment && (!this.filter || this.shown.has(d.id)));
  }

  /** The database a data source names; for PostgreSQL the one its session is connected to, which an empty name leaves to the server. */
  private defaultDatabase(id: string): string | undefined {
    const session = this.sessions.session(id);
    const sql = session?.kind === 'sql' ? asSql(session) : undefined;
    return sql && isPostgresSession(sql) ? sql.database : this.store.get(id)?.database.trim();
  }

  /** The databases of a PostgreSQL server, the one the data source connects to first. */
  private async postgresDatabaseNodes(node: DataSourceNode): Promise<ExplorerNode[]> {
    if (this.sessions.status(node.id) === 'failed') {
      return [new MessageNode(node, this.sessions.error(node.id) ?? 'Connection failed.', true)];
    }
    try {
      const listed = await this.cached(this.databases, node.id, async () => (await this.sessions.connectSql(node.id)).listDatabases());
      const names = orderDatabases(listed, this.defaultDatabase(node.id) ?? '');
      return (await this.matchingDatabases(node, names)) ?? names.map((name) => new DatabaseNode(node, name));
    } catch (error) {
      this.databases.delete(node.id);
      return error instanceof CancelledError ? [] : [new MessageNode(node, errorMessage(error), true)];
    }
  }

  /** The schemas of a PostgreSQL database; a database other than the data source's own is reached by a session of its own. */
  private async schemaNodes(node: DatabaseNode): Promise<ExplorerNode[]> {
    const id = node.parent.id;
    const key = `${id}\n${node.name}`;
    try {
      const schemas = await this.cached(this.schemas, key, async () => asPostgres(await this.sessions.connectSqlIn(id, node.name)).listSchemas());
      const matches = node.matches;
      if (matches) {
        return schemas
          .filter((name) => this.matchesName(name) || matches.some((m) => m.schema === name))
          .map((name) => new SchemaNode(node, name, this.matchesName(name) ? null : matches.filter((m) => m.schema === name)));
      }
      return schemas.length ? schemas.map((name) => new SchemaNode(node, name)) : [new MessageNode(node, 'No schemas', false)];
    } catch (error) {
      this.schemas.delete(key);
      return error instanceof CancelledError ? [] : [new MessageNode(node, errorMessage(error), true)];
    }
  }

  private async schemaFolderNodes(node: SchemaNode): Promise<ExplorerNode[]> {
    if (node.matches) return this.matchFolders(node, node.matches);
    const id = node.parent.parent.id;
    const database = node.parent.name;
    const key = `${id}\n${database}\n${node.name}`;
    try {
      const objects = await this.cached(this.schemaObjects, key, async () =>
        asPostgres(await this.sessions.connectSqlIn(id, database)).listSchemaObjects(node.name),
      );
      const named = (names: string[]): FolderItem[] => names.map((name) => ({ name, rows: null }));
      const routines = (list: { name: string; args: string }[]): FolderItem[] => list.map((r) => ({ name: r.name, rows: null, detail: r.args }));
      return [
        new FolderNode(node, 'tables', objects.tables),
        new FolderNode(node, 'views', named(objects.views)),
        new FolderNode(node, 'materializedViews', objects.materializedViews),
        new FolderNode(node, 'sequences', named(objects.sequences)),
        new FolderNode(node, 'procedures', routines(objects.procedures)),
        new FolderNode(node, 'functions', routines(objects.functions)),
        new FolderNode(node, 'types', objects.types.map((t) => ({ name: t.name, rows: null, detail: t.kind }))),
      ];
    } catch (error) {
      this.schemaObjects.delete(key);
      return error instanceof CancelledError ? [] : [new MessageNode(node, errorMessage(error), true)];
    }
  }

  /**
   * Under a filter the data source's name does not match, the databases whose names match, with all they hold, and
   * those holding what the filter found, with only that; `null` when the data source shows everything.
   */
  private async matchingDatabases(node: DataSourceNode, names: string[]): Promise<DatabaseNode[] | null> {
    if (!this.filter || this.matchesName(this.store.get(node.id)?.name ?? '')) return null;
    const found = (await this.found(node.id)) ?? [];
    return names
      .filter((name) => this.matchesName(name) || found.some((m) => m.database === name))
      .map((name) => new DatabaseNode(node, name, this.matchesName(name) ? null : found.filter((m) => m.database === name)));
  }

  /** The folders holding what the filter found; `tables` holds matches of kind `table`, and so on. */
  private matchFolders(parent: DatabaseNode | SchemaNode, matches: readonly ObjectMatch[]): FolderNode[] {
    const items = (folder: FolderKind) => matches.filter((m) => `${m.kind}s` === folder).map(({ name, rows }) => ({ name, rows }));
    return FOLDERS.map((f) => new FolderNode(parent, f.kind, items(f.kind))).filter((f) => f.items.length);
  }

  /** The data sources the filter shows, and the text above the tree that explains it. */
  private async filtered(dataSources: DataSource[]): Promise<DataSource[]> {
    if (!this.filter) {
      this.messageChanged.fire(undefined);
      return dataSources;
    }
    const filter = this.filter;
    const shown: DataSource[] = [];
    let unsearched = 0;
    const nameOnly = new Set<string>();
    let truncated = false;
    let postgresSearched = false;
    let failed: string | undefined;
    for (const dataSource of dataSources) {
      if (this.matchesName(dataSource.name)) {
        shown.push(dataSource);
        continue;
      }
      if (dataSource.engine !== 'mysql' && dataSource.engine !== 'postgres') {
        nameOnly.add(getEngine(dataSource.engine).name);
        continue;
      }
      try {
        const found = await this.found(dataSource.id);
        if (found === null) unsearched++;
        else if (found.length) shown.push(dataSource);
        if (found && found.length >= FILTER_MATCH_LIMIT) truncated = true;
        if (found && dataSource.engine === 'postgres') postgresSearched = true;
      } catch (error) {
        this.matches.delete(dataSource.id);
        failed = `Searching ${dataSource.name} failed: ${errorMessage(error)}`;
      }
    }
    // A newer filter has taken over while this one was searching.
    if (filter !== this.filter) return shown;
    const parts = [shown.length ? `Showing what matches “${filter}”.` : `Nothing matches “${filter}”.`];
    if (truncated) parts.push(`Only the first ${FILTER_MATCH_LIMIT} objects of a data source are shown.`);
    if (unsearched) parts.push('Data sources that are not connected are matched by name only.');
    if (postgresSearched) parts.push('PostgreSQL data sources are searched in the database they connect to.');
    if (nameOnly.size) parts.push(`${[...nameOnly].sort().join(' and ')} data sources are matched by name only.`);
    if (failed) parts.push(failed);
    this.messageChanged.fire(parts.join(' '));
    return shown;
  }

  /** What the filter finds in a data source; `null` when it is not connected and so cannot be searched. */
  private async found(id: string): Promise<ObjectMatch[] | null> {
    const session = this.sessions.status(id) === 'connected' ? this.sessions.session(id) : undefined;
    if (session?.kind !== 'sql') return null;
    const filter = this.filter;
    return this.cached(this.matches, id, () => asSql(session).searchObjects(filter, FILTER_MATCH_LIMIT));
  }

  private matchesName(name: string): boolean {
    return name.toLowerCase().includes(this.filter.toLowerCase());
  }

  /** The label with the filter text highlighted. */
  private label(name: string): vscode.TreeItemLabel {
    if (!this.filter) return { label: name };
    const highlights: [number, number][] = [];
    const lower = name.toLowerCase();
    const needle = this.filter.toLowerCase();
    for (let at = lower.indexOf(needle); at >= 0; at = lower.indexOf(needle, at + needle.length)) {
      highlights.push([at, at + needle.length]);
    }
    return { label: name, highlights };
  }

  private cached<T>(cache: Map<string, Promise<T>>, key: string, load: () => Promise<T>): Promise<T> {
    let value = cache.get(key);
    if (!value) cache.set(key, (value = load()));
    return value;
  }

  private clearCache(id: string): void {
    this.databases.delete(id);
    this.redisDatabases.delete(id);
    this.kafkaOverviews.delete(id);
    this.mongoDatabases.delete(id);
    this.matches.delete(id);
    for (const key of this.mongoCollections.keys()) if (key.startsWith(`${id}\n`)) this.mongoCollections.delete(key);
    for (const key of this.objects.keys()) if (key.startsWith(`${id}\n`)) this.objects.delete(key);
    for (const key of this.schemas.keys()) if (key.startsWith(`${id}\n`)) this.schemas.delete(key);
    for (const key of this.schemaObjects.keys()) if (key.startsWith(`${id}\n`)) this.schemaObjects.delete(key);
  }
}
