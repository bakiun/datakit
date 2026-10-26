/** Messaging with the extension. In the browser dev server, src/dev/devHost.ts plays the extension's part. */

interface Host {
  postMessage(message: unknown): void;
}

declare global {
  interface Window {
    datakitDevHost?: Host;
  }
}

let host: Host | undefined;

function getHost(): Host {
  if (!host) {
    host = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : window.datakitDevHost;
    if (!host) throw new Error('No VS Code host available.');
  }
  return host;
}

export function postToHost<T>(message: T): void {
  getHost().postMessage(message);
}

export function onHostMessage<T>(listener: (message: T) => void): () => void {
  const handler = (event: MessageEvent<T>) => listener(event.data);
  window.addEventListener('message', handler);
  return () => window.removeEventListener('message', handler);
}
