import type { Connector, ConnectorAction, ConnectorState, ConnectorTask, KafkaConnectClient } from '@datakit/core';
import { RestClient } from './rest';

interface StateJson {
  state: string;
  worker_id: string;
  trace?: string;
}

interface ExpandedConnector {
  status?: { connector: StateJson; tasks: (StateJson & { id: number })[]; type?: string };
  info?: { config: Record<string, string>; type?: string };
}

const STATES = new Set<ConnectorState>(['RUNNING', 'PAUSED', 'STOPPED', 'FAILED', 'UNASSIGNED', 'RESTARTING']);
const stateOf = (state: string): ConnectorState => (STATES.has(state as ConnectorState) ? (state as ConnectorState) : 'UNASSIGNED');
const enc = encodeURIComponent;

export class KafkaConnectRestClient implements KafkaConnectClient {
  private readonly rest: RestClient;

  constructor(
    readonly url: string,
    timeoutMs: number,
  ) {
    this.rest = new RestClient('Kafka Connect', url, timeoutMs);
  }

  async info(): Promise<{ version: string; workers: number }> {
    const [root, connectors] = await Promise.all([
      this.rest.json<{ version: string }>('/'),
      this.rest.json<Record<string, ExpandedConnector>>('/connectors?expand=status'),
    ]);
    // Connect has no list of workers; the ones that run connectors or tasks are known by their ids.
    const workers = new Set<string>();
    for (const { status } of Object.values(connectors)) {
      if (!status) continue;
      if (status.connector.worker_id) workers.add(status.connector.worker_id);
      for (const task of status.tasks) if (task.worker_id) workers.add(task.worker_id);
    }
    return { version: root.version, workers: Math.max(1, workers.size) };
  }

  async connectors(): Promise<Connector[]> {
    const all = await this.rest.json<Record<string, ExpandedConnector>>('/connectors?expand=status&expand=info');
    return Object.entries(all)
      .map(([name, { status, info }]): Connector => {
        const type = status?.type ?? info?.type;
        const tasks: ConnectorTask[] = (status?.tasks ?? [])
          .map((t) => ({ id: t.id, state: stateOf(t.state), workerId: t.worker_id, trace: t.trace ?? null }))
          .sort((a, b) => a.id - b.id);
        return {
          name,
          type: type === 'source' || type === 'sink' ? type : 'unknown',
          className: info?.config['connector.class'] ?? '',
          state: stateOf(status?.connector.state ?? 'UNASSIGNED'),
          workerId: status?.connector.worker_id ?? '',
          trace: status?.connector.trace ?? null,
          tasks,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  config(name: string): Promise<Record<string, string>> {
    return this.rest.json<Record<string, string>>(`/connectors/${enc(name)}/config`);
  }

  async putConfig(name: string, config: Record<string, string>): Promise<void> {
    await this.rest.json(`/connectors/${enc(name)}/config`, { method: 'PUT', body: config });
  }

  async act(name: string, action: ConnectorAction): Promise<void> {
    const path = `/connectors/${enc(name)}`;
    switch (action) {
      case 'pause':
      case 'resume':
      case 'stop':
        await this.rest.json(`${path}/${action}`, { method: 'PUT' });
        return;
      case 'restart':
        await this.rest.json(`${path}/restart?includeTasks=true&onlyFailed=false`, { method: 'POST' });
        return;
      case 'delete':
        await this.rest.json(path, { method: 'DELETE' });
        return;
      case 'resetOffsets':
        await this.rest.json(`${path}/offsets`, { method: 'DELETE' });
        return;
    }
  }

  async restartTask(name: string, task: number): Promise<void> {
    await this.rest.json(`/connectors/${enc(name)}/tasks/${task}/restart`, { method: 'POST' });
  }
}
