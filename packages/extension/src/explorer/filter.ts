import * as vscode from 'vscode';
import type { Services } from '../services';

const TYPING_DELAY_MS = 250;

/** Asks for the filter text and applies it while the user types. */
function editFilter({ tree }: Services): void {
  const input = vscode.window.createInputBox();
  input.title = 'Filter Data Sources';
  input.placeholder = 'Part of a table, view, routine, database or data source name';
  input.prompt = 'Connected data sources are searched on the server. Clear the text to show everything.';
  input.value = tree.filterText;
  let timer: ReturnType<typeof setTimeout> | undefined;
  input.onDidChangeValue((value) => {
    clearTimeout(timer);
    timer = setTimeout(() => tree.setFilter(value), TYPING_DELAY_MS);
  });
  input.onDidAccept(() => {
    clearTimeout(timer);
    tree.setFilter(input.value);
    input.hide();
  });
  input.onDidHide(() => input.dispose());
  input.show();
}

export function registerFilterCommands(services: Services): vscode.Disposable[] {
  return [
    services.tree.onDidChangeMessage((message) => (services.view.message = message)),
    vscode.commands.registerCommand('datakit.filterDataSources', () => editFilter(services)),
    vscode.commands.registerCommand('datakit.changeFilter', () => editFilter(services)),
    vscode.commands.registerCommand('datakit.clearFilter', () => services.tree.setFilter('')),
  ];
}
