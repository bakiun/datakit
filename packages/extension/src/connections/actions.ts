import { formatServerVersion, type DataSource, type Secrets, type ServerSession } from '@datakit/core';
import * as vscode from 'vscode';
import { DATA_SOURCES_VIEW } from '../explorer/dataSourcesTree';
import type { Services } from '../services';
import { CancelledError, showConnectionError } from './prompts';

/** How long quiet feedback stays in the status bar. */
const STATUS_MS = 4000;

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

/** Connects if needed, with progress on the Data Sources view; the tree is not expanded. */
export function connectWithProgress(services: Services, id: string, overrides?: Secrets): Thenable<ServerSession> {
  return withViewProgress(() => services.sessions.connect(id, overrides));
}

/** Connects and expands the data source in the tree. */
export async function connectAndReveal(services: Services, id: string, overrides?: Secrets): Promise<ServerSession> {
  const session = await connectWithProgress(services, id, overrides);
  await reveal(services, id);
  return session;
}

/** Connects a data source that was just created. Success shows in the tree; a failure offers Retry and Edit. */
export async function connectNewDataSource(services: Services, dataSource: DataSource, overrides: Secrets): Promise<void> {
  try {
    const session = await connectAndReveal(services, dataSource.id, overrides);
    vscode.window.setStatusBarMessage(`$(check) Connected to “${dataSource.name}” (${formatServerVersion(session.serverVersion)})`, STATUS_MS);
  } catch (error) {
    showConnectionError(dataSource, error, 'datakit.connectDataSource', `Saved “${dataSource.name}”, but could not connect`);
  }
}

/** Reconnects, which reloads the schema and metadata shown in the tree. */
export async function refreshDataSource(services: Services, dataSource: DataSource): Promise<void> {
  try {
    await withViewProgress(() => services.sessions.reconnect(dataSource.id));
    vscode.window.setStatusBarMessage(`$(check) Refreshed “${dataSource.name}”`, STATUS_MS);
  } catch (error) {
    showConnectionError(dataSource, error, 'datakit.refreshDataSource', `Could not refresh “${dataSource.name}”`);
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
  const failed = active.flatMap((dataSource, i) => {
    const result = results[i];
    return result?.status === 'rejected' && !(result.reason instanceof CancelledError) ? [{ dataSource, error: result.reason as unknown }] : [];
  });
  const [first] = failed;
  if (!first) {
    vscode.window.setStatusBarMessage(`$(check) Refreshed ${active.length} data source${active.length === 1 ? '' : 's'}`, STATUS_MS);
  } else if (failed.length === 1) {
    showConnectionError(first.dataSource, first.error, 'datakit.refreshDataSource', `Could not refresh “${first.dataSource.name}”`);
  } else {
    // Each error is shown under its data source in the tree.
    void vscode.window.showWarningMessage(`Could not refresh ${failed.map((f) => `“${f.dataSource.name}”`).join(', ')}. The errors are shown in the tree.`);
  }
}
