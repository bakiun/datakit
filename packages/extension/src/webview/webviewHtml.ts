import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';

/** Folder that `packages/webview-ui` builds into. */
export function webviewRoot(extensionUri: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(extensionUri, 'dist', 'webview');
}

const escapeHtml = (text: string) => text.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

/** What every Datakit webview may do: run its scripts and load the built UI. */
export function webviewOptions(extensionUri: vscode.Uri): vscode.WebviewOptions {
  return { enableScripts: true, localResourceRoots: [webviewRoot(extensionUri)] };
}

/**
 * The panel of a webview tab: a new one in the active column, or `restored`, the one VS Code gives the serializer
 * after the window reloads, which gets the same options. Hidden tabs keep their page, so switching tabs loses nothing.
 */
export function openWebviewPanel(viewType: string, title: string, extensionUri: vscode.Uri, restored?: vscode.WebviewPanel): vscode.WebviewPanel {
  if (!restored) {
    return vscode.window.createWebviewPanel(viewType, title, vscode.ViewColumn.Active, { ...webviewOptions(extensionUri), retainContextWhenHidden: true });
  }
  restored.webview.options = webviewOptions(extensionUri);
  restored.title = title;
  return restored;
}

/**
 * Page that loads the Vue bundle; `view` tells it which screen to mount. `panel` says which panel it is, e.g. the
 * data source and table; the page keeps it in its saved state, where the serializer finds it after a restart.
 */
export function renderWebviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri, view: string, title: string, panel?: object): string {
  const root = webviewRoot(extensionUri);
  const script = webview.asWebviewUri(vscode.Uri.joinPath(root, 'index.js'));
  const style = webview.asWebviewUri(vscode.Uri.joinPath(root, 'index.css'));
  const nonce = randomBytes(16).toString('base64');
  const csp = [
    "default-src 'none'",
    // The nonce also covers the <style> elements the SQL editor adds.
    `style-src ${webview.cspSource} 'nonce-${nonce}'`,
    `font-src ${webview.cspSource}`,
    `img-src ${webview.cspSource} data:`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}">
<title>${escapeHtml(title)}</title>
</head>
<body data-view="${escapeHtml(view)}" data-nonce="${nonce}"${panel ? ` data-panel="${escapeHtml(JSON.stringify(panel))}"` : ''}>
<div id="app"></div>
<script type="module" nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
}
