import type { DataSource } from '@datakit/core';
import * as vscode from 'vscode';
import { CancelledError, errorMessage } from '../connections/prompts';
import { DataSourceNode, MongoCollectionNode, MongoDatabaseNode } from '../explorer/nodes';
import type { Services } from '../services';
import { MongoCollectionPanel } from './mongoCollectionPanel';

/** MongoDB's rules for collection names, as far as a name typed here can break them. */
function collectionNameProblem(name: string): string | undefined {
  const n = name.trim();
  if (!n) return 'Name the collection.';
  if (n.includes('$')) return 'Collection names cannot contain $.';
  if (n.startsWith('system.')) return 'Names starting with system. are reserved.';
  return undefined;
}

function databaseNameProblem(name: string): string | undefined {
  const n = name.trim();
  if (!n) return 'Name the database.';
  if (/[/\\. "$*<>:|?]/.test(n)) return 'Database names cannot contain / \\ . " $ * < > : | ? or spaces.';
  if (n.length > 63) return 'Database names are at most 63 characters.';
  return undefined;
}

/**
 * Whether a change may go ahead: a read-only data source refuses it, a production one asks first. Deletions always
 * ask; `confirm` is their question.
 */
async function mayChange(dataSource: DataSource, what: string, confirm?: { detail: string; action: string }): Promise<boolean> {
  if (dataSource.options.readOnly) {
    void vscode.window.showInformationMessage(`“${dataSource.name}” is read-only.`);
    return false;
  }
  const production = dataSource.environment === 'production';
  if (!confirm && !production) return true;
  const action = confirm?.action ?? 'Apply';
  const where = `“${dataSource.name}”${production ? ' (Production)' : ''}`;
  const choice = await vscode.window.showWarningMessage(`${what} on ${where}?`, { modal: true, detail: confirm?.detail }, action);
  return choice === action;
}

export function registerMongoCommands(services: Services): vscode.Disposable[] {
  const { store, sessions, tree } = services;

  /** Runs a change on the data source's session and reloads its part of the tree; errors are shown, not thrown. */
  const run = async (dataSourceId: string, done: string, change: (session: Awaited<ReturnType<typeof sessions.connectMongo>>) => Promise<void>) => {
    try {
      await change(await sessions.connectMongo(dataSourceId));
      tree.reload(dataSourceId);
      void vscode.window.showInformationMessage(done);
    } catch (error) {
      if (!(error instanceof CancelledError)) void vscode.window.showErrorMessage(errorMessage(error));
    }
  };

  return [
    vscode.commands.registerCommand('datakit.openMongoCollection', (node?: unknown) => {
      if (!(node instanceof MongoCollectionNode)) return;
      MongoCollectionPanel.show(services, { dataSourceId: node.parent.parent.id, database: node.parent.name, collection: node.name });
    }),

    vscode.commands.registerCommand('datakit.newMongoCollection', async (node?: unknown) => {
      if (!(node instanceof MongoDatabaseNode)) return;
      const dataSource = store.get(node.parent.id);
      if (!dataSource) return;
      const name = await vscode.window.showInputBox({ title: `New Collection in ${node.name}`, prompt: 'Collection name', validateInput: collectionNameProblem });
      if (name === undefined || !(await mayChange(dataSource, `Create ${node.name}.${name.trim()}`))) return;
      await run(dataSource.id, `Created ${node.name}.${name.trim()}.`, (s) => s.createCollection(node.name, name.trim()));
    }),

    vscode.commands.registerCommand('datakit.newMongoDatabase', async (node?: unknown) => {
      if (!(node instanceof DataSourceNode)) return;
      const dataSource = store.get(node.id);
      if (!dataSource) return;
      const database = await vscode.window.showInputBox({ title: 'New Database', prompt: 'Database name', validateInput: databaseNameProblem });
      if (database === undefined) return;
      // MongoDB creates a database with its first collection.
      const collection = await vscode.window.showInputBox({
        title: `New Database ${database.trim()}`,
        prompt: 'Name of its first collection; MongoDB creates the database with it',
        validateInput: collectionNameProblem,
      });
      if (collection === undefined || !(await mayChange(dataSource, `Create ${database.trim()}.${collection.trim()}`))) return;
      await run(dataSource.id, `Created ${database.trim()} with ${collection.trim()}.`, (s) => s.createCollection(database.trim(), collection.trim()));
    }),

    vscode.commands.registerCommand('datakit.renameMongoCollection', async (node?: unknown) => {
      if (!(node instanceof MongoCollectionNode)) return;
      const dataSource = store.get(node.parent.parent.id);
      if (!dataSource) return;
      const to = await vscode.window.showInputBox({
        title: `Rename ${node.parent.name}.${node.name}`,
        value: node.name,
        validateInput: (v) => collectionNameProblem(v) ?? (v.trim() === node.name ? 'Type a new name.' : undefined),
      });
      if (to === undefined || !(await mayChange(dataSource, `Rename ${node.name} to ${to.trim()}`))) return;
      MongoCollectionPanel.closeFor(dataSource.id, node.parent.name, node.name);
      await run(dataSource.id, `Renamed ${node.name} to ${to.trim()}.`, (s) => s.renameCollection(node.parent.name, node.name, to.trim()));
    }),

    vscode.commands.registerCommand('datakit.dropMongoCollection', async (node?: unknown) => {
      if (!(node instanceof MongoCollectionNode)) return;
      const dataSource = store.get(node.parent.parent.id);
      if (!dataSource) return;
      const view = node.info.type === 'view';
      const detail = view ? 'The view is removed; its source collection stays.' : 'Every document and index of the collection is deleted.';
      if (!(await mayChange(dataSource, `Drop ${node.parent.name}.${node.name}`, { detail, action: 'Drop' }))) return;
      MongoCollectionPanel.closeFor(dataSource.id, node.parent.name, node.name);
      await run(dataSource.id, `Dropped ${node.parent.name}.${node.name}.`, (s) => s.dropCollection(node.parent.name, node.name));
    }),

    vscode.commands.registerCommand('datakit.dropMongoDatabase', async (node?: unknown) => {
      if (!(node instanceof MongoDatabaseNode)) return;
      const dataSource = store.get(node.parent.id);
      if (!dataSource) return;
      const detail = 'Every collection, document and index of the database is deleted.';
      if (!(await mayChange(dataSource, `Drop the database ${node.name}`, { detail, action: 'Drop' }))) return;
      // A second, typed confirmation: dropping a database cannot be undone.
      const typed = await vscode.window.showInputBox({
        title: `Drop ${node.name}`,
        prompt: `Type ${node.name} to drop it`,
        validateInput: (v) => (v === node.name ? undefined : `Type ${node.name} exactly.`),
      });
      if (typed !== node.name) return;
      MongoCollectionPanel.closeFor(dataSource.id, node.name);
      await run(dataSource.id, `Dropped the database ${node.name}.`, (s) => s.dropDatabase(node.name));
    }),
  ];
}
