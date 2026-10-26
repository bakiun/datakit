import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';

/** Folder that `packages/webview-ui` builds into. */
export function webviewRoot(extensionUri: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(extensionUri, 'dist', 'webview');
}

const escapeHtml = (text: string) => text.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

/** Page that loads the Vue bundle; `view` tells it which screen to mount. */
export function renderWebviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri, view: string, title: string): string {
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
<body data-view="${escapeHtml(view)}" data-nonce="${nonce}">
<div id="app"></div>
<script type="module" nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
}
