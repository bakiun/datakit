import { formatServerVersion, type DataSource, type Secrets, type ServerSession } from '@datakit/core';
import * as vscode from 'vscode';
import { DATA_SOURCES_VIEW } from '../explorer/dataSourcesTree';
import type { Services } from '../services';
import { CancelledError, errorMessage } from './prompts';

function withViewProgress<T>(task: () => Promise<T>): Thenable<T> {
  return vscode.window.withProgress({ location: { viewId: DATA_SOURCES_VIEW } }, task);
}

async function reveal(services: Services, id: string): Promise<void> {
  try {
    await services.view.reveal(services.tree.nodeFor(id), { select: true, focus: false, expand: true });
  } catch {
    // The view may be closed; revealing is only a convenience.
  }
}

/** Connects and expands the data source in the tree. */
export async function connectAndReveal(services: Services, id: string, overrides?: Secrets): Promise<ServerSession> {
  const session = await withViewProgress(() => services.sessions.connect(id, overrides));
  await reveal(services, id);
  return session;
}

/** Connects a data source that was just created and tells the user how it went. */
export async function connectNewDataSource(services: Services, dataSource: DataSource, overrides: Secrets): Promise<void> {
  try {
    const session = await connectAndReveal(services, dataSource.id, overrides);
    void vscode.window.showInformationMessage(
      `Data source “${dataSource.name}” saved and connected (${formatServerVersion(session.serverVersion)}).`,
    );
  } catch (error) {
    if (error instanceof CancelledError) return;
    void vscode.window.showErrorMessage(`Data source “${dataSource.name}” saved, but the connection failed: ${errorMessage(error)}`);
  }
}

/** Reconnects, which reloads the schema and metadata shown in the tree. */
export async function refreshDataSource(services: Services, dataSource: DataSource): Promise<void> {
  try {
    await withViewProgress(() => services.sessions.reconnect(dataSource.id));
    void vscode.window.showInformationMessage(`Refreshed “${dataSource.name}” — schema and metadata reloaded.`);
  } catch (error) {
    if (error instanceof CancelledError) return;
    void vscode.window.showErrorMessage(`Refresh failed for “${dataSource.name}”: ${errorMessage(error)}`);
  }
}

/** Refreshes every data source that is connected or failed; the others stay disconnected. */
export async function refreshAll(services: Services): Promise<void> {
  const { store, sessions, tree } = services;
  const active = store.list().filter((d) => sessions.status(d.id) !== 'idle');
  if (!active.length) {
    tree.refresh();
    return;
  }
  const results = await withViewProgress(() => Promise.allSettled(active.map((d) => sessions.reconnect(d.id))));
  const failed = active.filter((_, i) => {
    const result = results[i];
    return result?.status === 'rejected' && !(result.reason instanceof CancelledError);
  });
  const refreshed = `Refreshed ${active.length} data source${active.length === 1 ? '' : 's'}`;
  if (failed.length) {
    void vscode.window.showWarningMessage(`${refreshed} · ${failed.length} failed (${failed.map((d) => d.name).join(', ')}).`);
  } else {
    void vscode.window.showInformationMessage(`${refreshed}.`);
  }
}
