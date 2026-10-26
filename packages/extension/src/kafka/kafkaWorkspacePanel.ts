import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import {
  kafkaSecurityProtocol,
  messageContains,
  produceProblem,
  recordOf,
  type DataSource,
  type KafkaLoad,
  type KafkaMessage,
  type KafkaOffsetTarget,
  type KafkaPayload,
  type KafkaPositions,
  type KafkaProduceResult,
  type KafkaSection,
  type KafkaSession,
  type KafkaWorkspaceHostMessage,
  type KafkaWorkspaceWebviewMessage,
  type KafkaWrite,
  type KsqlDbClient,
} from '@datakit/core';
import * as vscode from 'vscode';
import { CancelledError, errorMessage } from '../connections/prompts';
import type { Services } from '../services';
import { renderWebviewHtml, webviewRoot } from '../webview/webviewHtml';

/** Messages produced per request; a larger count is sent in rounds. */
const PRODUCE_BATCH = 1000;
/** Produce results the page gets back, to show where the first messages landed. */
const PRODUCE_RESULTS_SHOWN = 5;
/** How long one round of a live stream waits for new messages. */
const STREAM_WAIT_MS = 1000;
/** Topics whose format is sampled at the same time. */
const FORMAT_SAMPLES = 4;
/** ksqlDB rows are sent to the page at most this often. */
const KSQL_FLUSH_MS = 200;
/** How long Re-create waits for the deleted topic to go away before it creates it again. */
const RECREATE_TIMEOUT_MS = 30_000;

const plural = (n: number, word: string) => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;

/** ksqlDB statements that only read; any other one changes the cluster. */
const KSQL_READS = /^\s*(?:--[^\n]*\n\s*)*(SELECT|SHOW|LIST|DESCRIBE|EXPLAIN|PRINT)\b/i;

function describeTarget(target: KafkaOffsetTarget): string {
  switch (target.kind) {
    case 'earliest':
    case 'latest':
      return target.kind;
    case 'timestamp':
      return `the first offset at ${new Date(target.time).toISOString()}`;
    case 'offset':
      return `offset ${target.offset}`;
  }
}

/** One line of the confirmation a production data source asks for. */
function describeWrite(write: KafkaWrite): string {
  switch (write.kind) {
    case 'setBrokerConfig':
      return `${write.value === null ? 'Reset' : `Set ${write.name} = ${write.value} for`} ${write.value === null ? `${write.name} on ` : ''}broker-${write.brokerId}`;
    case 'createTopic':
      return write.cloneOf ? `Clone ${write.cloneOf} as ${write.spec.name}` : `Create topic ${write.spec.name}`;
    case 'deleteTopic':
      return `Delete topic ${write.topic}`;
    case 'clearTopic':
      return `Delete every message in ${write.topic}`;
    case 'recreateTopic':
      return `Delete and re-create ${write.topic}`;
    case 'repartition':
      return `${write.topic}: ${write.partitions} partitions, RF ${write.replicationFactor}`;
    case 'setTopicConfig':
      return write.value === null ? `Reset ${write.name} on ${write.topic}` : `Set ${write.name} = ${write.value} on ${write.topic}`;
    case 'produce':
      return `Produce ${plural(write.template.count, 'message')} to ${write.topic}`;
    case 'resetOffsets':
      return `Move the offsets of ${write.groupId} to ${describeTarget(write.target)}`;
    case 'deleteGroup':
      return `Delete consumer group ${write.groupId}`;
    case 'createAcls':
      return `Create ${plural(write.acls.length, 'ACL')}`;
    case 'deleteAcls':
      return `Delete ${plural(write.acls.length, 'ACL')}`;
    case 'setGlobalCompatibility':
      return `Set the global compatibility to ${write.level}`;
    case 'setCompatibility':
      return `Set the compatibility of ${write.subject} to ${write.level ?? 'the global default'}`;
    case 'registerSchema':
      return `Register a new version of ${write.subject}`;
    case 'deleteSchemaVersion':
      return `${write.permanent ? 'Permanently delete' : 'Delete'} ${write.subject} version ${write.version}`;
    case 'connector':
      return `${write.action === 'resetOffsets' ? 'Reset the offsets of' : write.action[0]!.toUpperCase() + write.action.slice(1)} connector ${write.name}`;
    case 'restartTask':
      return `Restart task ${write.task} of ${write.name}`;
    case 'restartFailed':
      return 'Restart every failed connector and task';
    case 'saveConnector':
      return `Save connector ${write.name}`;
  }
}

/** A payload for a dump file: text, the decoded schema value, or hex for bytes that are not text. */
function dumpPayload(payload: KafkaPayload | null): unknown {
  if (!payload) return null;
  if (payload.decoded !== null) {
    try {
      return JSON.parse(payload.decoded);
    } catch {
      return payload.decoded;
    }
  }
  return payload.binary ? { hex: payload.text } : payload.text;
}

function dumpLine(topic: string, m: KafkaMessage): string {
  const headers = Object.fromEntries(m.headers.map((h) => [h.key, h.value]));
  return `${JSON.stringify({ topic, partition: m.partition, offset: m.offset, timestamp: new Date(m.timestamp).toISOString(), key: dumpPayload(m.key), value: dumpPayload(m.value), headers })}\n`;
}

/** Runs `task` on each item with at most `limit` running at once. */
async function eachLimited<T>(items: readonly T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await task(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The workspace of a Kafka data source: overview, brokers, topics with their messages, consumer groups, ACLs and the
 * REST services next to the cluster. It uses the data source's shared session; Kafka clients keep no state between calls.
 */
export class KafkaWorkspacePanel {
  private static readonly panels = new Map<string, KafkaWorkspacePanel>();
  private static readonly loaded = new vscode.EventEmitter<string>();
  /** Fires with the data source id when a workspace has started; lets the tests check the whole path. */
  static readonly onDidLoad = KafkaWorkspacePanel.loaded.event;
  private static readonly sent = new vscode.EventEmitter<{ dataSourceId: string; message: KafkaWorkspaceHostMessage }>();
  /** Every message sent to a workspace page; the tests read results from it. */
  static readonly onDidPost = KafkaWorkspacePanel.sent.event;
  private static statusItem: vscode.StatusBarItem | undefined;

  /** Opens the data source's workspace, on `section` (and `topic`) when given. */
  static show(services: Services, dataSourceId: string, section: KafkaSection = 'overview', topic: string | null = null): void {
    const existing = KafkaWorkspacePanel.panels.get(dataSourceId);
    if (!existing) {
      new KafkaWorkspacePanel(services, dataSourceId, section, topic);
      return;
    }
    existing.panel.reveal();
    existing.post({ type: 'navigate', section, topic });
  }

  /** Hands a message to a workspace as if its page had sent it; used by the tests. */
  static async receive(dataSourceId: string, message: KafkaWorkspaceWebviewMessage): Promise<void> {
    await KafkaWorkspacePanel.panels.get(dataSourceId)?.handle(message);
  }

  static closeFor(dataSourceId: string): void {
    KafkaWorkspacePanel.panels.get(dataSourceId)?.panel.dispose();
  }

  static disposeAll(): void {
    for (const panel of [...KafkaWorkspacePanel.panels.values()]) panel.panel.dispose();
    KafkaWorkspacePanel.statusItem?.dispose();
    KafkaWorkspacePanel.statusItem = undefined;
  }

  private readonly panel: vscode.WebviewPanel;
  private serverLabel = '';
  private disposed = false;
  /** Bumped to stop the running live stream. */
  private streamRun = 0;
  /** Bumped by every topic list, so format samples of an older one are dropped. */
  private topicsRun = 0;
  private readonly ksqlRuns = new Map<number, AbortController>();

  private constructor(
    private readonly services: Services,
    private readonly dataSourceId: string,
    private readonly section: KafkaSection,
    private readonly topic: string | null,
  ) {
    const extensionUri = services.context.extensionUri;
    this.panel = vscode.window.createWebviewPanel('datakit.kafkaWorkspace', this.title(), vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [webviewRoot(extensionUri)],
    });
    this.panel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'icons', 'kafka.svg');
    this.panel.webview.html = renderWebviewHtml(this.panel.webview, extensionUri, 'kafkaWorkspace', this.title());
    this.panel.webview.onDidReceiveMessage((message: KafkaWorkspaceWebviewMessage) => void this.handle(message));
    this.panel.onDidChangeViewState(() => KafkaWorkspacePanel.updateStatusBar());
    this.panel.onDidDispose(() => {
      this.disposed = true;
      this.streamRun++;
      for (const run of this.ksqlRuns.values()) run.abort();
      KafkaWorkspacePanel.panels.delete(dataSourceId);
      KafkaWorkspacePanel.updateStatusBar();
    });
    KafkaWorkspacePanel.panels.set(dataSourceId, this);
  }

  private dataSource(): DataSource | undefined {
    return this.services.store.get(this.dataSourceId);
  }

  private title(): string {
    return this.dataSource()?.name ?? 'Kafka';
  }

  private post(message: KafkaWorkspaceHostMessage): void {
    if (this.disposed) return;
    void this.panel.webview.postMessage(message);
    KafkaWorkspacePanel.sent.fire({ dataSourceId: this.dataSourceId, message });
  }

  private session(): Promise<KafkaSession> {
    return this.services.sessions.connectKafka(this.dataSourceId);
  }

  async handle(message: KafkaWorkspaceWebviewMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
        return this.init();
      case 'load':
        return this.load(message.what);
      case 'brokerConfigs':
        return this.read('brokerConfigs', async (s) => this.post({ type: 'brokerConfigs', brokerId: message.brokerId, configs: await s.brokerConfigs(message.brokerId) }));
      case 'openTopic':
        return this.openTopic(message.topic);
      case 'messages':
        return this.messages(message.requestId, message.query);
      case 'stream':
        // The stream runs until it is stopped; the message itself is handled once it started.
        void this.stream(message.topic, message.positions, message.partition, message.text);
        return;
      case 'stopStream':
        this.streamRun++;
        return;
      case 'openGroup':
        return this.read('group', async (s) => {
          const detail = await s.group(message.groupId);
          this.post(detail ? { type: 'group', detail } : { type: 'groupGone', groupId: message.groupId });
        });
      case 'schema':
        return this.read('schema', async (s) => this.post({ type: 'schema', detail: await registry(s).version(message.subject, message.version) }));
      case 'connectorConfig':
        return this.read('connectorConfig', async (s) => this.post({ type: 'connectorConfig', name: message.name, config: await connect(s).config(message.name) }));
      case 'ksql':
        // A push query runs until it is stopped; its rows and end are posted as they come.
        void this.ksql(message.runId, message.statement, message.properties);
        return;
      case 'ksqlStop':
        this.ksqlRuns.get(message.runId)?.abort();
        return;
      case 'write':
        return this.write(message.write);
      case 'favourite':
        this.post({ type: 'favourites', names: await this.services.kafkaFavourites.set(this.dataSourceId, message.topic, message.on) });
        return;
      case 'dump':
        return this.dump(message.topic);
      case 'copy':
        await vscode.env.clipboard.writeText(message.text);
        this.post({ type: 'notice', message: `Copied ${message.what} to the clipboard.` });
        return;
    }
  }

  private async init(): Promise<void> {
    const dataSource = this.dataSource();
    if (!dataSource) {
      this.post({ type: 'initFailed', message: 'The data source no longer exists.' });
      return;
    }
    try {
      const session = await this.session();
      const { product, version } = session.serverVersion;
      this.serverLabel = version ? `${product} ${version}` : product;
      const url = (value: string) => value.trim() || null;
      this.post({
        type: 'init',
        init: {
          dataSourceName: dataSource.name,
          environment: dataSource.environment,
          serverLabel: this.serverLabel,
          securityProtocol: kafkaSecurityProtocol(dataSource),
          bootstrapServers: dataSource.kafka.bootstrapServers,
          readOnly: dataSource.options.readOnly,
          pageSize: dataSource.options.pageSize,
          schemaRegistryUrl: url(dataSource.kafka.schemaRegistryUrl),
          connectUrl: url(dataSource.kafka.connectUrl),
          ksqlDbUrl: url(dataSource.kafka.ksqlDbUrl),
          favourites: this.services.kafkaFavourites.list(this.dataSourceId),
          section: this.section,
          topic: this.topic,
        },
      });
      KafkaWorkspacePanel.updateStatusBar();
      KafkaWorkspacePanel.loaded.fire(this.dataSourceId);
    } catch (error) {
      this.post({ type: 'initFailed', message: error instanceof CancelledError ? 'Connecting was cancelled.' : errorMessage(error) });
    }
  }

  /** Runs a read and reports its failure as `loadFailed`. */
  private async read(what: Extract<KafkaWorkspaceHostMessage, { type: 'loadFailed' }>['what'], run: (session: KafkaSession) => Promise<void>): Promise<void> {
    try {
      await run(await this.session());
    } catch (error) {
      this.post({ type: 'loadFailed', what, message: errorMessage(error) });
    }
  }

  private load(what: KafkaLoad): Promise<void> {
    return this.read(what, async (session) => {
      switch (what) {
        case 'overview': {
          const [overview, connectors, subjects, globalCompatibility] = await Promise.all([
            session.overview(),
            session.connect?.connectors().catch(() => null) ?? null,
            session.schemaRegistry?.subjects().catch(() => null) ?? null,
            session.schemaRegistry?.globalCompatibility().catch(() => null) ?? null,
          ]);
          this.post({ type: 'overview', overview, connectors, subjects: subjects?.length ?? null, globalCompatibility });
          return;
        }
        case 'brokers':
          this.post({ type: 'brokers', brokers: await session.brokers() });
          return;
        case 'topics': {
          const topics = await session.topics();
          this.post({ type: 'topics', topics });
          void this.sampleFormats(session, topics.filter((t) => !t.internal && t.messages > 0).map((t) => t.name));
          return;
        }
        case 'groups':
          this.post({ type: 'groups', groups: await session.groups() });
          return;
        case 'acls':
          this.post({ type: 'acls', acls: await session.acls() });
          return;
        case 'subjects': {
          const client = registry(session);
          const [subjects, globalCompatibility] = await Promise.all([client.subjects(), client.globalCompatibility()]);
          this.post({ type: 'subjects', subjects, globalCompatibility });
          return;
        }
        case 'connectors': {
          const client = connect(session);
          const [connectors, info] = await Promise.all([client.connectors(), client.info()]);
          this.post({ type: 'connectors', connectors, workers: info.workers, version: info.version });
          return;
        }
        case 'ksqlInfo':
          this.post({ type: 'ksqlInfo', info: await ksqlDb(session).info() });
          return;
      }
    });
  }

  /** Fills the Format column after the topic list is shown; a sample that fails leaves its topic out. */
  private async sampleFormats(session: KafkaSession, names: string[]): Promise<void> {
    const run = ++this.topicsRun;
    const formats: Record<string, string> = {};
    await eachLimited(names, FORMAT_SAMPLES, async (name) => {
      const format = await session.sampleFormat(name).catch(() => null);
      if (format) formats[name] = format;
    });
    if (run === this.topicsRun && Object.keys(formats).length) this.post({ type: 'topicFormats', formats });
  }

  private openTopic(topic: string): Promise<void> {
    return this.read('topic', async (session) => {
      const detail = await session.topic(topic);
      if (!detail) {
        this.post({ type: 'topicGone', topic });
        return;
      }
      this.post({ type: 'topic', detail });
      this.post({ type: 'topicConfigs', topic, configs: await session.topicConfigs(topic) });
    });
  }

  private async messages(requestId: number, query: Parameters<KafkaSession['readMessages']>[0]): Promise<void> {
    try {
      const session = await this.session();
      const started = performance.now();
      const page = await session.readMessages(query);
      this.post({ type: 'messages', requestId, topic: query.topic, page, durationMs: performance.now() - started });
    } catch (error) {
      this.post({ type: 'messagesFailed', requestId, message: errorMessage(error) });
    }
  }

  /** Reads new messages until the page stops the stream, another one starts or the panel closes. */
  private async stream(topic: string, positions: KafkaPositions, partition: number | null, text: string | null): Promise<void> {
    const run = ++this.streamRun;
    let at = positions;
    try {
      while (run === this.streamRun) {
        const session = await this.session();
        const { messages, positions: next } = await session.tail(topic, at, STREAM_WAIT_MS);
        if (run !== this.streamRun) return;
        at = next;
        const matched = messages.filter((m) => (partition === null || m.partition === partition) && (!text || messageContains(m, text)));
        if (matched.length) this.post({ type: 'streamed', topic, messages: matched.reverse() });
      }
    } catch (error) {
      if (run === this.streamRun) this.post({ type: 'streamStopped', topic, message: errorMessage(error) });
    }
  }

  private async ksql(runId: number, statement: string, properties: Record<string, string>): Promise<void> {
    const dataSource = this.dataSource();
    if (!dataSource) return;
    const writes = !KSQL_READS.test(statement);
    if (writes && dataSource.options.readOnly) {
      this.post({ type: 'ksqlFailed', runId, message: 'The data source is read-only; this statement changes the cluster.' });
      return;
    }
    if (writes && dataSource.environment === 'production') {
      const choice = await vscode.window.showWarningMessage(`Run on “${dataSource.name}” (Production)?`, { modal: true, detail: statement.slice(0, 500) }, 'Run');
      if (choice !== 'Run') {
        this.post({ type: 'ksqlFailed', runId, message: 'Not run.' });
        return;
      }
    }
    const controller = new AbortController();
    this.ksqlRuns.set(runId, controller);
    let pending: unknown[][] = [];
    let timer: NodeJS.Timeout | undefined;
    const flush = () => {
      timer = undefined;
      if (!pending.length) return;
      this.post({ type: 'ksqlRows', runId, rows: pending });
      pending = [];
    };
    const started = performance.now();
    try {
      const client: KsqlDbClient = ksqlDb(await this.session());
      const result = await client.run(
        statement,
        properties,
        {
          onColumns: (columns) => this.post({ type: 'ksqlColumns', runId, columns }),
          onRows: (rows) => {
            pending.push(...rows);
            timer ??= setTimeout(flush, KSQL_FLUSH_MS);
          },
        },
        controller.signal,
      );
      clearTimeout(timer);
      flush();
      this.post({ type: 'ksqlDone', runId, result, durationMs: performance.now() - started });
    } catch (error) {
      clearTimeout(timer);
      flush();
      if (controller.signal.aborted) this.post({ type: 'ksqlDone', runId, result: { kind: 'query', rows: 0 }, durationMs: performance.now() - started });
      else this.post({ type: 'ksqlFailed', runId, message: errorMessage(error) });
    } finally {
      this.ksqlRuns.delete(runId);
    }
  }

  /** Writes are refused on a read-only data source and confirmed again on a production one. */
  private async write(write: KafkaWrite): Promise<void> {
    const dataSource = this.dataSource();
    if (!dataSource) return;
    if (dataSource.options.readOnly) {
      this.post({ type: 'failed', kind: write.kind, message: 'The data source is read-only.' });
      return;
    }
    if (dataSource.environment === 'production') {
      const choice = await vscode.window.showWarningMessage(`Change “${dataSource.name}” (Production)?`, { modal: true, detail: describeWrite(write) }, 'Apply');
      if (choice !== 'Apply') {
        this.post({ type: 'failed', kind: write.kind, message: 'Nothing was changed.' });
        return;
      }
    }
    try {
      const message = await this.apply(await this.session(), write);
      this.post({ type: 'done', kind: write.kind, message });
    } catch (error) {
      this.post({ type: 'failed', kind: write.kind, message: errorMessage(error) });
    }
  }

  /** Carries out a write and returns what it did, for the toast. */
  private async apply(session: KafkaSession, write: KafkaWrite): Promise<string> {
    switch (write.kind) {
      case 'setBrokerConfig':
        await session.setBrokerConfig(write.brokerId, write.name, write.value);
        return write.value === null ? `Reset ${write.name} on broker-${write.brokerId}.` : `Updated ${write.name} on broker-${write.brokerId} — applied live.`;
      case 'createTopic': {
        const configs = write.cloneOf ? { ...(await overrides(session, write.cloneOf)), ...write.spec.configs } : write.spec.configs;
        await session.createTopic({ ...write.spec, configs });
        return write.cloneOf ? `Cloned ${write.cloneOf} as ${write.spec.name}. Messages are not copied.` : `Created ${write.spec.name}.`;
      }
      case 'deleteTopic':
        await session.deleteTopic(write.topic);
        this.post({ type: 'favourites', names: await this.services.kafkaFavourites.set(this.dataSourceId, write.topic, false) });
        return `Deleted ${write.topic}.`;
      case 'clearTopic':
        return `Cleared ${write.topic} — deleted ${plural(await session.clearTopic(write.topic), 'message')}.`;
      case 'recreateTopic':
        await recreate(session, write.topic);
        return `Re-created ${write.topic}.`;
      case 'repartition': {
        const detail = await session.topic(write.topic);
        if (!detail) throw new Error(`Topic ${write.topic} no longer exists.`);
        if (write.partitions < detail.partitions) throw new Error(`Partitions can only grow; ${write.topic} has ${detail.partitions}.`);
        if (write.partitions > detail.partitions) await session.addPartitions(write.topic, write.partitions);
        const reassign = write.replicationFactor !== detail.replicationFactor;
        if (reassign) await session.changeReplicationFactor(write.topic, write.replicationFactor);
        return `${write.topic}: ${plural(write.partitions, 'partition')}, RF ${write.replicationFactor}${reassign ? ' — reassignment started.' : '.'}`;
      }
      case 'setTopicConfig':
        await session.setTopicConfig(write.topic, write.name, write.value);
        return write.value === null ? `Reset ${write.name} on ${write.topic} to the default.` : `Updated ${write.name} on ${write.topic}.`;
      case 'produce':
        return this.produce(session, write.topic, write.template);
      case 'resetOffsets': {
        await session.resetOffsets(write.groupId, write.partitions, write.target);
        const which = write.partitions ? plural(write.partitions.length, 'partition') : 'all partitions';
        return `Offsets of ${write.groupId} set to ${describeTarget(write.target)} for ${which}.`;
      }
      case 'deleteGroup':
        await session.deleteGroup(write.groupId);
        return `Deleted group ${write.groupId}.`;
      case 'createAcls': {
        await session.createAcls(write.acls);
        const principals = [...new Set(write.acls.map((a) => a.principal))].join(', ');
        return `Created ${plural(write.acls.length, 'ACL')} for ${principals}.`;
      }
      case 'deleteAcls':
        return `Deleted ${plural(await session.deleteAcls(write.acls), 'ACL')}.`;
      case 'setGlobalCompatibility':
        await registry(session).setGlobalCompatibility(write.level);
        return `Global compatibility set to ${write.level}.`;
      case 'setCompatibility':
        await registry(session).setCompatibility(write.subject, write.level);
        return `Compatibility of ${write.subject} set to ${write.level ?? 'the global default'}.`;
      case 'registerSchema': {
        const client = registry(session);
        const check = await client.checkCompatibility(write.subject, write.schemaType, write.schema);
        if (!check.compatible) {
          throw new Error(`Not compatible with the latest version of ${write.subject}${check.messages[0] ? `: ${check.messages[0]}` : '.'}`);
        }
        const id = await client.register(write.subject, write.schemaType, write.schema);
        const latest = await client.version(write.subject, 'latest');
        return `Registered ${write.subject} version ${latest.version} (schema id ${id}).`;
      }
      case 'deleteSchemaVersion': {
        const client = registry(session);
        if (!write.permanent) {
          await client.deleteVersion(write.subject, write.version, false);
          return `Soft-deleted ${write.subject} version ${write.version}. It can still be read by id.`;
        }
        // Schema Registry only deletes a version permanently once it is soft-deleted.
        await client.deleteVersion(write.subject, write.version, false).catch(() => undefined);
        await client.deleteVersion(write.subject, write.version, true);
        return `Hard-deleted ${write.subject} version ${write.version}.`;
      }
      case 'connector': {
        await connect(session).act(write.name, write.action);
        const done = { pause: 'Paused', resume: 'Resumed', stop: 'Stopped', restart: 'Restarted', delete: 'Deleted', resetOffsets: 'Reset the offsets of' }[write.action];
        return `${done} ${write.name}${write.action === 'restart' ? ' and its tasks' : ''}.`;
      }
      case 'restartTask':
        await connect(session).restartTask(write.name, write.task);
        return `Restarted task ${write.task} of ${write.name}.`;
      case 'restartFailed': {
        const client = connect(session);
        let restarted = 0;
        for (const connector of await client.connectors()) {
          if (connector.state === 'FAILED') {
            await client.act(connector.name, 'restart');
            restarted++;
            continue;
          }
          for (const task of connector.tasks.filter((t) => t.state === 'FAILED')) {
            await client.restartTask(connector.name, task.id);
            restarted++;
          }
        }
        return restarted ? `Restarted ${plural(restarted, 'failed task')}.` : 'Nothing has failed.';
      }
      case 'saveConnector':
        await connect(session).putConfig(write.name, write.config);
        return `Saved ${write.name}.`;
    }
  }

  /** Produces the template `count` times in rounds; a large count shows its progress and can be cancelled. */
  private async produce(session: KafkaSession, topic: string, template: Parameters<typeof produceProblem>[0]): Promise<string> {
    const detail = await session.topic(topic);
    if (!detail) throw new Error(`Topic ${topic} no longer exists.`);
    const problem = produceProblem(template, detail.partitions);
    if (problem) throw new Error(problem);
    const values = { uuid: () => randomUUID(), now: new Date(), random: Math.random };
    const results: KafkaProduceResult[] = [];
    let sent = 0;
    const run = async (token?: vscode.CancellationToken, progress?: vscode.Progress<{ message?: string; increment?: number }>) => {
      while (sent < template.count && !token?.isCancellationRequested) {
        const size = Math.min(PRODUCE_BATCH, template.count - sent);
        const records = Array.from({ length: size }, (_, i) => recordOf(template, sent + i, values));
        const produced = await session.produce(topic, records, template.valueFormat);
        if (results.length < PRODUCE_RESULTS_SHOWN) results.push(...produced.slice(0, PRODUCE_RESULTS_SHOWN - results.length));
        sent += size;
        progress?.report({ message: `${sent.toLocaleString('en-US')} of ${template.count.toLocaleString('en-US')}`, increment: (size / template.count) * 100 });
      }
    };
    if (template.count > PRODUCE_BATCH) {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Producing to ${topic}`, cancellable: true },
        (progress, token) => run(token, progress),
      );
    } else {
      await run();
    }
    this.post({ type: 'produced', topic, count: sent, results });
    const stopped = sent < template.count ? ` Stopped after ${plural(sent, 'message')}.` : '';
    return `Produced ${plural(sent, 'message')} to ${topic}.${stopped}`;
  }

  /** Saves every message of the topic as JSON Lines, oldest first, with a cancellable progress notification. */
  private async dump(topic: string): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? homedir();
    const file = await vscode.window.showSaveDialog({
      title: 'Dump Topic',
      defaultUri: vscode.Uri.file(join(folder, `${topic.replace(/[\\/:*?"<>|]/g, '_')}.jsonl`)),
      filters: { 'JSON Lines': ['jsonl'] },
    });
    if (!file) return;
    const name = file.path.split('/').pop();
    try {
      const session = await this.session();
      const out = createWriteStream(file.fsPath);
      let cancelled = false;
      const read = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Dumping ${topic} to ${name}`, cancellable: true },
        async (progress, token) => {
          let reported = 0;
          return session.readAll(topic, async (messages, done, total) => {
            for (const m of messages) if (!out.write(dumpLine(topic, m))) await once(out, 'drain');
            const percent = total ? (done / total) * 100 : 100;
            progress.report({ message: `${done.toLocaleString('en-US')} of ${total.toLocaleString('en-US')}`, increment: percent - reported });
            reported = percent;
            cancelled = token.isCancellationRequested;
            return !cancelled;
          });
        },
      );
      out.end();
      await once(out, 'close');
      this.post({ type: 'notice', message: `${cancelled ? 'Stopped; saved' : 'Saved'} ${plural(read, 'message')} to ${name}.` });
    } catch (error) {
      this.post({ type: 'notice', message: `Dump failed: ${errorMessage(error)}` });
    }
  }

  /** The status bar shows the cluster of the active workspace, its security protocol and Production. */
  private static updateStatusBar(): void {
    const active = [...KafkaWorkspacePanel.panels.values()].find((p) => p.panel.active);
    const item = (KafkaWorkspacePanel.statusItem ??= vscode.window.createStatusBarItem('datakit.kafkaWorkspace', vscode.StatusBarAlignment.Left, 50));
    const dataSource = active?.dataSource();
    if (!active || !dataSource || !active.serverLabel) {
      item.hide();
      return;
    }
    const production = dataSource.environment === 'production';
    item.name = 'Datakit Kafka';
    item.text = `$(database) ${dataSource.name} · ${active.serverLabel} · ${kafkaSecurityProtocol(dataSource)}${production ? ' · Production' : ''}`;
    item.tooltip = production ? 'Production — changes need confirmation' : `${dataSource.name}: ${dataSource.kafka.bootstrapServers}`;
    item.backgroundColor = production ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    item.show();
  }
}

function registry(session: KafkaSession) {
  if (!session.schemaRegistry) throw new Error('No Schema Registry URL is set on this data source.');
  return session.schemaRegistry;
}

function connect(session: KafkaSession) {
  if (!session.connect) throw new Error('No Kafka Connect URL is set on this data source.');
  return session.connect;
}

function ksqlDb(session: KafkaSession) {
  if (!session.ksqlDb) throw new Error('No ksqlDB URL is set on this data source.');
  return session.ksqlDb;
}

/** The overrides set on a topic, which a clone or a re-created topic gets too. */
async function overrides(session: KafkaSession, topic: string): Promise<Record<string, string>> {
  const configs = await session.topicConfigs(topic);
  return Object.fromEntries(configs.filter((c) => c.source === 'topic' && !c.sensitive && c.value !== null).map((c) => [c.name, c.value!]));
}

/** Deletes the topic and creates it again with its partitions, replication factor and overrides. */
async function recreate(session: KafkaSession, topic: string): Promise<void> {
  const detail = await session.topic(topic);
  if (!detail) throw new Error(`Topic ${topic} no longer exists.`);
  const spec = { name: topic, partitions: detail.partitions, replicationFactor: detail.replicationFactor, configs: await overrides(session, topic) };
  await session.deleteTopic(topic);
  // Deletion finishes in the background; until then the name is taken.
  const deadline = Date.now() + RECREATE_TIMEOUT_MS;
  for (;;) {
    try {
      await session.createTopic(spec);
      return;
    } catch (error) {
      if (Date.now() > deadline) throw new Error(`${topic} was deleted but could not be created again: ${errorMessage(error)}`);
      await wait(500);
    }
  }
}
