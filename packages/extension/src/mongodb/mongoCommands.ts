import type { DataSource } from '@datakit/core';
import * as vscode from 'vscode';
import { DataSourceEditor } from '../connections/dataSourceEditor';
import { CancelledError, errorMessage } from '../connections/prompts';
import { DataSourceNode, MongoCollectionNode, MongoDatabaseNode } from '../explorer/nodes';
import type { Services } from '../services';
import { MongoCollectionPanel } from './mongoCollectionPanel';

/**
 * MongoDB's rules for collection names, as far as a name typed here can break them. An empty name is no problem
 * yet: the box opens without an error, and Enter on it cancels.
 */
function collectionNameProblem(name: string): string | undefined {
  const n = name.trim();
  if (n.includes('$')) return 'Collection names cannot contain $.';
  if (n.startsWith('system.')) return 'Names starting with system. are reserved.';
  return undefined;
}

function databaseNameProblem(name: string): string | undefined {
  const n = name.trim();
  if (/[/\\. "$*<>:|?]/.test(n)) return 'Database names cannot contain / \\ . " $ * < > : | ? or spaces.';
  if (n.length > 63) return 'Database names are at most 63 characters.';
  return undefined;
}

/** `shop.orders` as the database and its first collection; database names have no dot, so the first one splits. */
function splitNamespace(text: string): { database: string; collection: string } {
  const t = text.trim();
  const dot = t.indexOf('.');
  return dot < 0 ? { database: t, collection: '' } : { database: t.slice(0, dot).trim(), collection: t.slice(dot + 1).trim() };
}

function namespaceProblem(text: string): string | undefined {
  const { database, collection } = splitNamespace(text);
  if (!database) return text.trim() ? 'Name the database before the dot.' : undefined;
  return databaseNameProblem(database) ?? collectionNameProblem(collection);
}

/** Says a read-only data source cannot be changed, with the way to change that. */
function refuseReadOnly(services: Services, dataSource: DataSource): void {
  const edit = 'Edit Data Source';
  void vscode.window
    .showInformationMessage(`“${dataSource.name}” is read-only. Turn off Read-only in its settings to make changes.`, edit)
    .then((choice) => choice === edit && DataSourceEditor.show(services, dataSource.id));
}

/**
 * Whether a change may go ahead: a read-only data source refuses it, a production one asks first, and deletions
 * (`always`) ask on every data source. `action` is the button of the question, a verb; `detail` says what is lost.
 */
async function mayChange(services: Services, dataSource: DataSource, what: string, action: string, detail?: string, always = false): Promise<boolean> {
  if (dataSource.options.readOnly) {
    refuseReadOnly(services, dataSource);
    return false;
  }
  const production = dataSource.environment === 'production';
  if (!always && !production) return true;
  const where = `“${dataSource.name}”${production ? ' (Production)' : ''}`;
  const choice = await vscode.window.showWarningMessage(`${what} on ${where}?`, { modal: true, detail }, action);
  return choice === action;
}

export function registerMongoCommands(services: Services): vscode.Disposable[] {
  const { store, sessions, tree } = services;

  /**
   * Runs a change on the data source's session and reloads its part of the tree; `done` shows in the status bar and
   * `then` runs after it worked. Errors are shown, not thrown.
   */
  const run = async (
    dataSourceId: string,
    done: string,
    change: (session: Awaited<ReturnType<typeof sessions.connectMongo>>) => Promise<void>,
    then?: () => void,
  ) => {
    try {
      await change(await sessions.connectMongo(dataSourceId));
      tree.reload(dataSourceId);
      vscode.window.setStatusBarMessage(done, 4000);
      then?.();
    } catch (error) {
      if (!(error instanceof CancelledError)) void vscode.window.showErrorMessage(errorMessage(error));
    }
  };
  const open = (dataSourceId: string, database: string, collection: string) => MongoCollectionPanel.show(services, { dataSourceId, database, collection });

  return [
    vscode.commands.registerCommand('datakit.openMongoCollection', (node?: unknown) => {
      if (!(node instanceof MongoCollectionNode)) return;
      MongoCollectionPanel.show(services, { dataSourceId: node.parent.parent.id, database: node.parent.name, collection: node.name });
    }),

    vscode.commands.registerCommand('datakit.newMongoCollection', async (node?: unknown) => {
      if (!(node instanceof MongoDatabaseNode)) return;
      const dataSource = store.get(node.parent.id);
      if (!dataSource) return;
      if (dataSource.options.readOnly) return refuseReadOnly(services, dataSource);
      const name = (await vscode.window.showInputBox({ title: `New Collection in ${node.name}`, prompt: 'Collection name', validateInput: collectionNameProblem }))?.trim();
      if (!name || !(await mayChange(services, dataSource, `Create ${node.name}.${name}`, 'Create'))) return;
      // The new collection opens, ready for its first documents.
      await run(dataSource.id, `Created ${node.name}.${name}.`, (s) => s.createCollection(node.name, name), () => open(dataSource.id, node.name, name));
    }),

    vscode.commands.registerCommand('datakit.newMongoDatabase', async (node?: unknown) => {
      if (!(node instanceof DataSourceNode)) return;
      const dataSource = store.get(node.id);
      if (!dataSource) return;
      if (dataSource.options.readOnly) return refuseReadOnly(services, dataSource);
      // MongoDB creates a database with its first collection, so one box asks for both.
      const typed = await vscode.window.showInputBox({
        title: 'New Database',
        prompt: 'The database and its first collection, e.g. shop.orders; MongoDB creates a database with its first collection',
        placeHolder: 'database.collection',
        validateInput: namespaceProblem,
      });
      if (!typed?.trim()) return;
      const { database } = splitNamespace(typed);
      let { collection } = splitNamespace(typed);
      if (!collection) {
        // Only a database name was typed: its first collection is still needed.
        collection =
          (await vscode.window.showInputBox({ title: `New Database ${database}`, prompt: 'Name of its first collection; MongoDB creates the database with it', validateInput: collectionNameProblem }))?.trim() ?? '';
        if (!collection) return;
      }
      if (!(await mayChange(services, dataSource, `Create ${database}.${collection}`, 'Create'))) return;
      await run(dataSource.id, `Created ${database} with ${collection}.`, (s) => s.createCollection(database, collection), () => open(dataSource.id, database, collection));
    }),

    vscode.commands.registerCommand('datakit.renameMongoCollection', async (node?: unknown) => {
      if (!(node instanceof MongoCollectionNode)) return;
      const dataSource = store.get(node.parent.parent.id);
      if (!dataSource) return;
      if (dataSource.options.readOnly) return refuseReadOnly(services, dataSource);
      const database = node.parent.name;
      const to = (await vscode.window.showInputBox({ title: `Rename ${database}.${node.name}`, prompt: 'New name', value: node.name, validateInput: collectionNameProblem }))?.trim();
      // An unchanged or empty name is no rename.
      if (!to || to === node.name || !(await mayChange(services, dataSource, `Rename ${node.name} to ${to}`, 'Rename'))) return;
      // A tab open on the collection opens again under its new name.
      const wasOpen = MongoCollectionPanel.closeFor(dataSource.id, database, node.name) > 0;
      await run(dataSource.id, `Renamed ${node.name} to ${to}.`, (s) => s.renameCollection(database, node.name, to), () => wasOpen && open(dataSource.id, database, to));
    }),

    vscode.commands.registerCommand('datakit.dropMongoCollection', async (node?: unknown) => {
      if (!(node instanceof MongoCollectionNode)) return;
      const dataSource = store.get(node.parent.parent.id);
      if (!dataSource) return;
      const view = node.info.type === 'view';
      const detail = view ? 'The view is removed; its source collection stays.' : 'Every document and index of the collection is deleted.';
      if (!(await mayChange(services, dataSource, `Drop ${node.parent.name}.${node.name}`, 'Drop', detail, true))) return;
      MongoCollectionPanel.closeFor(dataSource.id, node.parent.name, node.name);
      await run(dataSource.id, `Dropped ${node.parent.name}.${node.name}.`, (s) => s.dropCollection(node.parent.name, node.name));
    }),

    vscode.commands.registerCommand('datakit.dropMongoDatabase', async (node?: unknown) => {
      if (!(node instanceof MongoDatabaseNode)) return;
      const dataSource = store.get(node.parent.id);
      if (!dataSource) return;
      const detail = 'Every collection, document and index of the database is deleted. This cannot be undone.';
      if (!(await mayChange(services, dataSource, `Drop the database ${node.name}`, 'Drop', detail, true))) return;
      if (dataSource.environment === 'production') {
        // On production, the name is typed as well: dropping a database cannot be undone.
        const typed = await vscode.window.showInputBox({
          title: `Drop ${node.name}`,
          prompt: `Type ${node.name} to drop it`,
          validateInput: (v) => (!v || node.name.startsWith(v) ? undefined : `Type ${node.name} exactly.`),
        });
        if (typed !== node.name) return;
      }
      MongoCollectionPanel.closeFor(dataSource.id, node.name);
      await run(dataSource.id, `Dropped the database ${node.name}.`, (s) => s.dropDatabase(node.name));
    }),
  ];
}
