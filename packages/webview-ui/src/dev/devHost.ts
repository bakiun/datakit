import {
  createDataSourceSettings,
  validateDataSource,
  type EditorHostMessage,
  type EditorState,
  type EditorWebviewMessage,
} from '@datakit/core';
import './devTheme.css';
import { installKafkaWorkspaceHost } from './kafkaWorkspaceHost';
import { installMongoCollectionHost } from './mongoCollectionHost';
import { installRedisKeysHost } from './redisKeysHost';
import { installTableDataHost } from './tableDataHost';

/**
 * Stands in for the extension when the UI runs on the Vite dev server.
 * Query: `?view=tableData` shows the data view (`&readonly`), `?view=queryConsole` the query console,
 * `?view=redisKeys` the Redis key browser (`&readonly`),
 * `?view=kafkaWorkspace` the Kafka workspace (`&readonly`, `&noservices`, `&production`; see kafkaWorkspaceHost.ts),
 * `?view=mongoCollection` a MongoDB collection (`&readonly`, `&production`, `&view-collection`, `&capped`, `&initfail`, `&nocount`;
 * see mongoCollectionHost.ts),
 * `?edit` opens an existing data source,
 * `?theme=light` switches the theme. A host named `fail` makes Test Connection fail.
 * The page's saved state (`setState`) is kept in sessionStorage per URL, so reloading the browser tab restores it the
 * way a reload of the webview does; `&fresh` starts without it.
 */
export function installDevHost(): void {
  const params = new URLSearchParams(location.search);
  document.body.classList.add(params.get('theme') === 'light' ? 'vscode-light' : 'vscode-dark');
  const send = (message: unknown, delay = 0) => setTimeout(() => window.postMessage(message, '*'), delay);
  const stateKey = `datakit.devState:${location.pathname}${location.search.replace(/[?&]fresh\b/, '')}`;
  if (params.has('fresh')) sessionStorage.removeItem(stateKey);
  /** The VS Code API around `handle`: messages from the page go to it, the saved state to sessionStorage. */
  const devHost = (handle: (message: never) => void) => ({
    postMessage(message: unknown) {
      console.info('[dev host] ←', message);
      handle(message as never);
    },
    getState(): unknown {
      const text = sessionStorage.getItem(stateKey);
      return text === null ? undefined : (JSON.parse(text) as unknown);
    },
    setState(state: unknown) {
      sessionStorage.setItem(stateKey, JSON.stringify(state));
    },
  });

  if (params.get('view') === 'kafkaWorkspace') {
    document.body.dataset.view = 'kafkaWorkspace';
    document.body.dataset.panel = JSON.stringify({ dataSourceId: 'dev-kafka' });
    const handle = installKafkaWorkspaceHost(send);
    window.datakitDevHost = devHost(handle);
    return;
  }

  if (params.get('view') === 'mongoCollection') {
    document.body.dataset.view = 'mongoCollection';
    document.body.dataset.panel = JSON.stringify({ dataSourceId: 'dev-mongo', database: 'shop', collection: 'orders' });
    const handle = installMongoCollectionHost(send);
    window.datakitDevHost = devHost(handle);
    return;
  }

  if (params.get('view') === 'redisKeys') {
    document.body.dataset.view = 'redisKeys';
    document.body.dataset.panel = JSON.stringify({ dataSourceId: 'dev-redis', database: 0 });
    const handle = installRedisKeysHost(send);
    window.datakitDevHost = devHost(handle);
    return;
  }

  const sqlView = params.get('view');
  if (sqlView === 'tableData' || sqlView === 'queryConsole') {
    document.body.dataset.view = sqlView;
    document.body.dataset.panel = JSON.stringify(
      sqlView === 'queryConsole' ? { consoleId: 'dev-console' } : { dataSourceId: 'dev-mysql', database: 'shop', table: 'orders' },
    );
    const handle = installTableDataHost(send, sqlView === 'queryConsole');
    window.datakitDevHost = devHost(handle);
    return;
  }

  const reply = (message: EditorHostMessage, delay = 0) => send(message, delay);
  const otherNames = ['shop-prod', 'analytics'];

  function state(): EditorState {
    if (!params.has('edit')) {
      return {
        mode: 'new',
        id: null,
        settings: createDataSourceSettings('mysql'),
        storedSecrets: { password: false, sshPassword: false, sshPassphrase: false },
        otherNames,
      };
    }
    const settings = createDataSourceSettings('mysql');
    Object.assign(settings, { name: 'shop-staging', comment: 'Staging copy of the shop', environment: 'staging', user: 'app_rw', database: 'shop' });
    settings.ssl.enabled = true;
    return { mode: 'edit', id: 'dev-1', settings, storedSecrets: { password: true, sshPassword: false, sshPassphrase: false }, otherNames };
  }

  document.body.dataset.panel = JSON.stringify({ dataSourceId: params.has('edit') ? 'dev-1' : null });
  window.datakitDevHost = devHost((message: EditorWebviewMessage) => {
    switch (message.type) {
      case 'ready':
        reply({ type: 'init', state: state() });
        break;
      case 'test': {
        const host = message.settings.host.trim();
        const ok = host !== '' && host !== 'fail';
        const target = `${host}:${message.settings.port}`;
        reply({ type: 'testResult', ok, message: ok ? 'Succeeded — MySQL 8.4.3 · 34 ms' : `Connection refused (${target}).` }, 700);
        break;
      }
      case 'save': {
        const errors = validateDataSource(message.settings, otherNames);
        const first = Object.values(errors)[0];
        if (first) reply({ type: 'saveFailed', message: first, errors }, 300);
        else if (!message.close) reply({ type: 'saved', state: { ...state(), mode: 'edit', id: 'dev-1', settings: message.settings } }, 300);
        else console.info('[dev host] saved and closed');
        break;
      }
      case 'browse':
        reply({ type: 'fileSelected', field: message.field, path: `/Users/dev/${message.field === 'ssh.privateKeyPath' ? '.ssh/id_ed25519' : 'certs/file.pem'}` });
        break;
      case 'cancel':
        console.info('[dev host] cancelled');
        break;
    }
  });
}
