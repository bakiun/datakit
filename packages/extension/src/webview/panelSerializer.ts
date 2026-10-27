import * as vscode from 'vscode';

/**
 * Builds a panel again on the webview panel VS Code restores after a reload of the window, from the state its page
 * saved. Returns false when the panel cannot come back, e.g. its data source or table is gone; the tab then closes.
 */
export type PanelRestorer = (panel: vscode.WebviewPanel, state: unknown) => boolean | Promise<boolean>;

/** Restores a panel, or closes its tab quietly when it cannot come back; nothing is shown to the user either way. */
export async function restoreOrDispose(restore: PanelRestorer, panel: vscode.WebviewPanel, state: unknown): Promise<boolean> {
  let restored = false;
  try {
    restored = await restore(panel, state);
  } catch {
    restored = false;
  }
  if (!restored) panel.dispose();
  return restored;
}

/** Registers the serializers, so the tabs of these view types come back when VS Code opens the window again. */
export function registerPanelSerializers(restorers: Readonly<Record<string, PanelRestorer>>): vscode.Disposable[] {
  return Object.entries(restorers).map(([viewType, restore]) =>
    vscode.window.registerWebviewPanelSerializer(viewType, {
      deserializeWebviewPanel: async (panel, state) => void (await restoreOrDispose(restore, panel, state)),
    }),
  );
}
