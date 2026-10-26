import type { Environment, KafkaSection, MongoCollectionInfo, ObjectMatch, TableInfo } from '@datakit/core';

/** Folders of a MySQL database; a PostgreSQL schema also has materialized views, sequences and types. */
export type FolderKind = 'tables' | 'views' | 'materializedViews' | 'sequences' | 'procedures' | 'functions' | 'types';

/** An object in a folder. `detail` tells overloaded routines apart (their arguments) and names the kind of a type. */
export interface FolderItem extends TableInfo {
  detail?: string;
}

/** A top-level folder holding the data sources of one environment. `view` is as on `DataSourceNode`. */
export class EnvironmentNode {
  readonly kind = 'environment';
  constructor(
    readonly environment: Environment,
    readonly view: string,
  ) {}

  get itemId(): string {
    return `env/${this.environment}${this.view}`;
  }
}

/** Nodes of the Data Sources tree. Data source nodes are kept, so VS Code can be told which one changed. */
export class DataSourceNode {
  readonly kind = 'dataSource';
  /**
   * `epoch` is bumped on Disconnect: a new item id makes VS Code show the node collapsed. `view` names the
   * filter the node is shown under, so filtered nodes get their own ids and open state.
   */
  constructor(
    readonly id: string,
    readonly epoch: number,
    readonly view: string,
  ) {}

  get itemId(): string {
    return `ds/${this.id}/${this.epoch}${this.view}`;
  }
}

export class DatabaseNode {
  readonly kind = 'database';
  /** `matches` limits the children to what the filter found; `null` shows everything. */
  constructor(
    readonly parent: DataSourceNode,
    readonly name: string,
    readonly matches: readonly ObjectMatch[] | null = null,
  ) {}

  get itemId(): string {
    return `${this.parent.itemId}/db/${this.name}`;
  }
}

/** A schema of a PostgreSQL database; it holds the folders that a MySQL database holds. */
export class SchemaNode {
  readonly kind = 'schema';
  /** `matches` is as on `DatabaseNode`. */
  constructor(
    readonly parent: DatabaseNode,
    readonly name: string,
    readonly matches: readonly ObjectMatch[] | null = null,
  ) {}

  get itemId(): string {
    return `${this.parent.itemId}/schema/${this.name}`;
  }
}

export class FolderNode {
  readonly kind = 'folder';
  constructor(
    readonly parent: DatabaseNode | SchemaNode,
    readonly folder: FolderKind,
    readonly items: readonly FolderItem[],
  ) {}

  get itemId(): string {
    return `${this.parent.itemId}/${this.folder}`;
  }

  /** The database the folder is in, and on PostgreSQL its schema. */
  get location(): { dataSourceId: string; database: string; schema?: string } {
    const p = this.parent;
    return p.kind === 'schema' ? { dataSourceId: p.parent.parent.id, database: p.parent.name, schema: p.name } : { dataSourceId: p.parent.id, database: p.name };
  }
}

export class ObjectNode {
  readonly kind = 'object';
  constructor(
    readonly parent: FolderNode,
    readonly name: string,
    readonly rows: number | null,
    readonly detail?: string,
  ) {}

  get itemId(): string {
    return `${this.parent.itemId}/${this.name}${this.detail === undefined ? '' : `(${this.detail})`}`;
  }
}

/** The Consoles folder of a data source. */
export class ConsolesNode {
  readonly kind = 'consoles';
  constructor(readonly parent: DataSourceNode) {}

  get itemId(): string {
    return `${this.parent.itemId}/consoles`;
  }
}

export class ConsoleNode {
  readonly kind = 'console';
  constructor(
    readonly parent: ConsolesNode,
    readonly consoleId: string,
  ) {}

  get itemId(): string {
    return `${this.parent.itemId}/${this.consoleId}`;
  }
}

/** A database of a Redis data source; its keys open in the key browser. */
export class RedisDatabaseNode {
  readonly kind = 'redisDatabase';
  constructor(
    readonly parent: DataSourceNode,
    readonly index: number,
    readonly keys: number,
  ) {}

  get itemId(): string {
    return `${this.parent.itemId}/redis/${this.index}`;
  }
}

/** A database of a MongoDB data source. */
export class MongoDatabaseNode {
  readonly kind = 'mongoDatabase';
  constructor(
    readonly parent: DataSourceNode,
    readonly name: string,
    readonly empty: boolean,
  ) {}

  get itemId(): string {
    return `${this.parent.itemId}/mongo/${this.name}`;
  }
}

/** A collection or view of a MongoDB database; it opens in the collection tab. */
export class MongoCollectionNode {
  readonly kind = 'mongoCollection';
  constructor(
    readonly parent: MongoDatabaseNode,
    readonly info: MongoCollectionInfo,
  ) {}

  get name(): string {
    return this.info.name;
  }

  get itemId(): string {
    return `${this.parent.itemId}/${this.info.name}`;
  }
}

/** A section of a Kafka data source; it opens the workspace there. `count` is shown beside it when known. */
export class KafkaSectionNode {
  readonly kind = 'kafkaSection';
  constructor(
    readonly parent: DataSourceNode,
    readonly section: KafkaSection,
    readonly count: number | null,
  ) {}

  get itemId(): string {
    return `${this.parent.itemId}/kafka/${this.section}`;
  }
}

/** A leaf that explains an empty or failed level. */
export class MessageNode {
  readonly kind = 'message';
  constructor(
    readonly parent: DataSourceNode | DatabaseNode | SchemaNode | MongoDatabaseNode,
    readonly message: string,
    readonly isError: boolean,
  ) {}

  get itemId(): string {
    return `${this.parent.itemId}/message`;
  }
}

export type ExplorerNode =
  | EnvironmentNode
  | DataSourceNode
  | ConsolesNode
  | ConsoleNode
  | DatabaseNode
  | SchemaNode
  | FolderNode
  | ObjectNode
  | RedisDatabaseNode
  | KafkaSectionNode
  | MongoDatabaseNode
  | MongoCollectionNode
  | MessageNode;
