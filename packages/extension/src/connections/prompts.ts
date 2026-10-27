import { describeEndpoint, type DataSourceSettings } from '@datakit/core';
import * as vscode from 'vscode';

/** Thrown when the user dismisses a password prompt; callers treat it as a quiet stop. */
export class CancelledError extends Error {
  constructor() {
    super('Cancelled.');
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Tells the user a connection failed and offers the fixes: trying again with `retryCommand`, or opening the data
 * source's settings. Both commands take the data source id. Does not wait for the user's answer.
 */
export function showConnectionError(
  dataSource: { id: string; name: string },
  error: unknown,
  retryCommand = 'datakit.connectDataSource',
  prefix = `Could not connect to “${dataSource.name}”`,
): void {
  if (error instanceof CancelledError) return;
  void vscode.window.showErrorMessage(`${prefix}: ${errorMessage(error)}`, 'Retry', 'Edit Data Source').then((choice) => {
    if (choice === 'Retry') void vscode.commands.executeCommand(retryCommand, dataSource.id);
    else if (choice === 'Edit Data Source') void vscode.commands.executeCommand('datakit.editDataSource', dataSource.id);
  });
}

/** Asks for a password that is not saved. */
export async function promptForSecret(settings: DataSourceSettings, key: 'password' | 'sshPassword'): Promise<string> {
  const token = settings.engine === 'kafka' && settings.kafka.saslMechanism === 'OAUTHBEARER';
  const prompt =
    key === 'sshPassword'
      ? `SSH password for ${settings.ssh.user}@${settings.ssh.host}`
      : token
        ? `OAuth token for ${describeEndpoint(settings)}`
        : `Password for ${settings.user}@${describeEndpoint(settings)}`;
  const value = await vscode.window.showInputBox({
    title: `Connect to “${settings.name || 'New data source'}”`,
    prompt,
    password: true,
    ignoreFocusOut: true,
  });
  if (value === undefined) throw new CancelledError();
  return value;
}
