/**
 * What a webview keeps with `setState`. VS Code hands it back when the page reloads, and to the extension's panel
 * serializer when the window opens again, so the extension can build the same panel. VS Code stores it as plain
 * text: it never holds a password or token.
 */
export interface WebviewSavedState {
  /** Which panel this is, e.g. the data source and table of a data view; the serializer reads it. */
  panel?: unknown;
  /** The page's own state, by part of the page. */
  parts?: Record<string, WebviewSavedPart>;
}

export interface WebviewSavedPart {
  /** The version of the part's shape; a part saved with another version is not restored. */
  v: number;
  data: unknown;
}

/** The data source editor: the data source it edits, null for a new one. */
export interface DataSourceEditorPanelRef {
  dataSourceId: string | null;
}

/** The data view of a table; `schema` is set for PostgreSQL. */
export interface TableDataPanelRef {
  dataSourceId: string;
  database: string;
  schema?: string;
  table: string;
}

export interface QueryConsolePanelRef {
  consoleId: string;
}

export interface MongoCollectionPanelRef {
  dataSourceId: string;
  database: string;
  collection: string;
}

/** The key browser; `database` is the one it shows now. */
export interface RedisKeysPanelRef {
  dataSourceId: string;
  database: number;
}

export interface KafkaWorkspacePanelRef {
  dataSourceId: string;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isName = (value: unknown): value is string => typeof value === 'string' && value !== '';

/** The `panel` of a saved state as an object, or null when there is none. */
function panelOf(state: unknown): Record<string, unknown> | null {
  return isObject(state) && isObject(state.panel) ? state.panel : null;
}

/** The panel identities a serializer accepts; anything else, e.g. a state from an older version, is null. */
export const readPanelRef = {
  dataSourceEditor(state: unknown): DataSourceEditorPanelRef | null {
    const p = panelOf(state);
    if (!p) return null;
    return p.dataSourceId === null || isName(p.dataSourceId) ? { dataSourceId: p.dataSourceId } : null;
  },
  tableData(state: unknown): TableDataPanelRef | null {
    const p = panelOf(state);
    if (!p || !isName(p.dataSourceId) || typeof p.database !== 'string' || !isName(p.table)) return null;
    if (p.schema !== undefined && typeof p.schema !== 'string') return null;
    const ref: TableDataPanelRef = { dataSourceId: p.dataSourceId, database: p.database, table: p.table };
    return p.schema === undefined ? ref : { ...ref, schema: p.schema };
  },
  queryConsole(state: unknown): QueryConsolePanelRef | null {
    const p = panelOf(state);
    return p && isName(p.consoleId) ? { consoleId: p.consoleId } : null;
  },
  mongoCollection(state: unknown): MongoCollectionPanelRef | null {
    const p = panelOf(state);
    return p && isName(p.dataSourceId) && isName(p.database) && isName(p.collection)
      ? { dataSourceId: p.dataSourceId, database: p.database, collection: p.collection }
      : null;
  },
  redisKeys(state: unknown): RedisKeysPanelRef | null {
    const p = panelOf(state);
    return p && isName(p.dataSourceId) && Number.isInteger(p.database) && (p.database as number) >= 0
      ? { dataSourceId: p.dataSourceId, database: p.database as number }
      : null;
  },
  kafkaWorkspace(state: unknown): KafkaWorkspacePanelRef | null {
    const p = panelOf(state);
    return p && isName(p.dataSourceId) ? { dataSourceId: p.dataSourceId } : null;
  },
};
