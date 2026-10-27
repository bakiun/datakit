/** Messaging with the extension. In the browser dev server, src/dev/devHost.ts plays the extension's part. */

export interface Host {
  postMessage(message: unknown): void;
  /** What the page kept with `setState`; VS Code keeps it across reloads of the page and restarts of the window. */
  getState(): unknown;
  setState(state: unknown): void;
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

export function getHostState(): unknown {
  return getHost().getState();
}

export function setHostState(state: unknown): void {
  getHost().setState(state);
}

/** Which panel the extension opened this page as, from the page it rendered; the serializer gets it back later. */
export function renderedPanel(): unknown {
  const text = document.body.dataset.panel;
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
