import * as vscode from 'vscode';
import { target } from '../connections/commands';
import { ConsoleNode, DatabaseNode, SchemaNode } from '../explorer/nodes';
import type { Services } from '../services';
import { QueryConsolePanel } from './queryConsolePanel';

/** The console a command applies to: the tree node it was run on, or its id. */
function consoleId(node: unknown): string | undefined {
  if (node instanceof ConsoleNode) return node.consoleId;
  return typeof node === 'string' ? node : undefined;
}

async function rename(services: Services, id: string): Promise<void> {
  const queryConsole = services.consoles.get(id);
  if (!queryConsole) return;
  const name = await vscode.window.showInputBox({
    title: 'Rename Console',
    value: queryConsole.name,
    valueSelection: [0, queryConsole.name.replace(/\.sql$/i, '').length],
    validateInput: (value) => services.consoles.nameError(queryConsole, value),
  });
  if (name === undefined) return;
  const error = await services.consoles.rename(id, name);
  if (error) void vscode.window.showErrorMessage(error);
  else QueryConsolePanel.renamed(services, id);
}

async function remove(services: Services, id: string): Promise<void> {
  const queryConsole = services.consoles.get(id);
  if (!queryConsole) return;
  const choice = await vscode.window.showWarningMessage(
    `Delete console “${queryConsole.name}”?`,
    { modal: true, detail: 'Its script is deleted. Data on the server is not touched.' },
    'Delete',
  );
  if (choice !== 'Delete') return;
  QueryConsolePanel.close(id);
  await services.consoles.delete(id);
}

export function registerConsoleCommands(services: Services): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand('datakit.newConsole', async (node?: unknown) => {
      if (node instanceof DatabaseNode) {
        await QueryConsolePanel.create(services, node.parent.id, node.name);
        return;
      }
      if (node instanceof SchemaNode) {
        await QueryConsolePanel.create(services, node.parent.parent.id, node.parent.name, '', node.name);
        return;
      }
      const dataSource = await target(services, node);
      if (dataSource) await QueryConsolePanel.create(services, dataSource.id, null);
    }),
    vscode.commands.registerCommand('datakit.openConsole', (node?: unknown) => {
      const id = consoleId(node);
      if (id) QueryConsolePanel.show(services, id);
    }),
    vscode.commands.registerCommand('datakit.renameConsole', async (node?: unknown) => {
      const id = consoleId(node);
      if (id) await rename(services, id);
    }),
    vscode.commands.registerCommand('datakit.deleteConsole', async (node?: unknown) => {
      const id = consoleId(node);
      if (id) await remove(services, id);
    }),
  ];
}
