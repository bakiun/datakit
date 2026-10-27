import { isPostgresSession, quoteIdentifier, type PgObjectKind, type PostgresSession } from '@datakit/core';
import * as vscode from 'vscode';
import { CancelledError, errorMessage } from '../connections/prompts';
import { ObjectNode, type FolderKind } from '../explorer/nodes';
import type { Services } from '../services';
import { seconds } from './sqlViewPanel';

/** Commands on the objects of a PostgreSQL schema in the tree: their definition, and refreshing materialized views. */

const KINDS: Record<FolderKind, PgObjectKind> = {
  tables: 'table',
  views: 'view',
  materializedViews: 'materializedView',
  sequences: 'sequence',
  functions: 'function',
  procedures: 'procedure',
  types: 'type',
};

interface PgObject {
  dataSourceId: string;
  database: string;
  schema: string;
  name: string;
  kind: PgObjectKind;
  /** The arguments that pick an overload of a function or procedure. */
  args?: string;
}

/** The PostgreSQL object a command was run on; undefined for other nodes. */
function pgObject(node: unknown): PgObject | undefined {
  if (!(node instanceof ObjectNode)) return undefined;
  const { dataSourceId, database, schema } = node.parent.location;
  if (schema === undefined) return undefined;
  const kind = KINDS[node.parent.folder];
  const args = kind === 'function' || kind === 'procedure' ? node.detail : undefined;
  return { dataSourceId, database, schema, name: node.name, kind, ...(args === undefined ? {} : { args }) };
}

async function sessionFor(services: Services, object: PgObject): Promise<PostgresSession> {
  const session = await services.sessions.connectSqlIn(object.dataSourceId, object.database);
  if (!isPostgresSession(session)) throw new Error('This is not a PostgreSQL data source.');
  return session;
}

/** Opens the CREATE statement of an object in an untitled SQL editor. */
async function showDefinition(services: Services, node: unknown): Promise<void> {
  const object = pgObject(node);
  if (!object) return;
  try {
    const ddl = await (await sessionFor(services, object)).definition(object.schema, object.name, object.kind, object.args);
    const document = await vscode.workspace.openTextDocument({ language: 'sql', content: `${ddl};\n` });
    await vscode.window.showTextDocument(document, { preview: true });
  } catch (error) {
    if (!(error instanceof CancelledError)) void vscode.window.showErrorMessage(`Could not read the definition of ${object.name}: ${errorMessage(error)}`);
  }
}

/** Runs REFRESH MATERIALIZED VIEW on a session of its own, so the tree stays usable while it runs. */
async function refreshMaterializedView(services: Services, node: unknown): Promise<void> {
  const object = pgObject(node);
  const dataSource = object && services.store.get(object.dataSourceId);
  if (!object || object.kind !== 'materializedView' || !dataSource) return;
  const name = `${object.schema}.${object.name}`;
  if (dataSource.options.readOnly) {
    void vscode.window.showErrorMessage(`“${dataSource.name}” is read-only; ${name} was not refreshed.`);
    return;
  }
  const statement = `REFRESH MATERIALIZED VIEW ${quoteIdentifier(object.schema, 'postgres')}.${quoteIdentifier(object.name, 'postgres')}`;
  if (dataSource.environment === 'production') {
    const choice = await vscode.window.showWarningMessage(
      `Refresh materialized view ${name} on “${dataSource.name}” (Production)?`,
      { modal: true, detail: `${statement};` },
      'Refresh',
    );
    if (choice !== 'Refresh') return;
  }
  try {
    const took = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Refreshing ${name}` }, async () => {
      const session = await services.sessions.openDedicatedSql(object.dataSourceId, object.database);
      try {
        const result = await session.execute(statement);
        return result.durationMs;
      } finally {
        await session.close();
      }
    });
    services.tree.reload(object.dataSourceId);
    // Routine success: a quiet status bar line, not a notification to dismiss.
    vscode.window.setStatusBarMessage(`$(check) Refreshed materialized view ${name} (${seconds(took)})`, 5000);
  } catch (error) {
    if (!(error instanceof CancelledError)) void vscode.window.showErrorMessage(`Could not refresh ${name}: ${errorMessage(error)}`);
  }
}

export function registerPostgresCommands(services: Services): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand('datakit.showDefinition', (node?: unknown) => showDefinition(services, node)),
    vscode.commands.registerCommand('datakit.refreshMaterializedView', (node?: unknown) => refreshMaterializedView(services, node)),
  ];
}
