import * as vscode from 'vscode';
import type { Services } from '../services';
import type { HistoryEntry } from './queryHistory';
import { QueryConsolePanel } from './queryConsolePanel';

/** The entry a command applies to: the history item it was run on, or its id. */
function entryOf(services: Services, value: unknown): HistoryEntry | undefined {
  const id = typeof value === 'string' ? value : (value as HistoryEntry | undefined)?.id;
  return id ? services.history.get(id) : undefined;
}

export function registerHistoryCommands(services: Services): vscode.Disposable[] {
  const { history } = services;
  return [
    vscode.commands.registerCommand('datakit.openHistoryEntry', async (value?: unknown) => {
      const entry = entryOf(services, value);
      if (!entry) return;
      if (!services.store.get(entry.dataSourceId)) {
        void vscode.window.showErrorMessage('The data source of this query no longer exists.');
        return;
      }
      await QueryConsolePanel.openWith(services, entry.dataSourceId, entry.database, entry.sql);
    }),
    vscode.commands.registerCommand('datakit.copyHistoryEntry', async (value?: unknown) => {
      const entry = entryOf(services, value);
      if (!entry) return;
      await vscode.env.clipboard.writeText(entry.sql);
      vscode.window.setStatusBarMessage('Copied the query to the clipboard.', 3000);
    }),
    vscode.commands.registerCommand('datakit.deleteHistoryEntry', async (value?: unknown) => {
      const entry = entryOf(services, value);
      if (entry) await history.delete(entry.id);
    }),
    vscode.commands.registerCommand('datakit.clearHistory', async () => {
      if (!history.list().length) return;
      const choice = await vscode.window.showWarningMessage(
        'Clear the query history?',
        { modal: true, detail: `${history.list().length} queries are removed. Consoles keep their scripts.` },
        'Clear',
      );
      if (choice === 'Clear') await history.clear();
    }),
  ];
}
