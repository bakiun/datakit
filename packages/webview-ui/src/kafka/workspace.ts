import type {
  Connector,
  KafkaAcl,
  KafkaBroker,
  KafkaConfigEntry,
  KafkaGroupSummary,
  KafkaLoad,
  KafkaOverview,
  KafkaSection,
  KafkaTopicDetail,
  KafkaTopicSummary,
  KafkaWorkspaceHostMessage,
  KafkaWorkspaceInit,
  KafkaWorkspacePrefs,
  KafkaWorkspaceWebviewMessage,
  KafkaValueFormat,
  KafkaWrite,
  KafkaWriteKind,
  KsqlDbInfo,
  SchemaCompatibility,
  SchemaSubject,
} from '@datakit/core';
import { inject, onUnmounted, provide, reactive, type InjectionKey } from 'vue';
import { usePersistedState } from '../composables/usePersistedState';
import { onHostMessage, postToHost } from '../host';
import type { MessageFilter } from './messageQuery';
import { readSavedWorkspace, workspaceToSave } from './savedState';

/**
 * State shared by the Kafka workspace screens: what the host sent for the cluster, which section is open, and the
 * writes waiting for their answer. Screens with their own data (messages, broker configs, groups, schemas, ksqlDB)
 * listen to the host themselves.
 */

export interface WriteResult {
  ok: boolean;
  message: string;
  /** The user declined VS Code's Production confirmation; nothing needs to be shown. */
  cancelled?: boolean;
}

export interface WriteOptions {
  /** The caller shows a failure itself, e.g. a dialog that shows it inline. */
  quiet?: boolean;
  /** False when the change shows on the page by itself, e.g. an edited setting, so no toast says it again. */
  announce?: boolean;
}

/** What the produce form held for a topic, so closing it or opening another topic loses nothing. */
export interface ProduceDraft {
  partition: string;
  valueFormat: KafkaValueFormat;
  key: string;
  keyNull: boolean;
  value: string;
  headers: string;
  count: string;
}

/** Loads of one item; `loadFailed` names these as well as the KafkaLoads. */
export type DetailLoad = 'topic' | 'topicConfigs' | 'brokerConfigs' | 'group' | 'schema' | 'connectorConfig';

export interface OverviewData {
  overview: KafkaOverview;
  connectors: Connector[] | null;
  subjects: number | null;
  globalCompatibility: SchemaCompatibility | null;
}

export interface ConnectData {
  connectors: Connector[];
  workers: number;
  version: string;
}

export interface Toast {
  id: number;
  text: string;
  error: boolean;
}

export interface WorkspaceState {
  init: KafkaWorkspaceInit | null;
  initError: string | null;
  section: KafkaSection;
  /** The open topic of the Topics section; null shows the topic list. */
  topic: string | null;
  /** The group Consumers picks when it opens, e.g. from a topic's Consumers tab. */
  group: string | null;
  favourites: string[];
  /** Choices remembered per data source; `setPrefs` changes them. */
  prefs: KafkaWorkspacePrefs;
  overview: OverviewData | null;
  brokers: KafkaBroker[] | null;
  topics: KafkaTopicSummary[] | null;
  formats: Record<string, string>;
  topicDetail: KafkaTopicDetail | null;
  topicConfigs: KafkaConfigEntry[] | null;
  groups: KafkaGroupSummary[] | null;
  /** `list` is null when the cluster has no authorizer. */
  acls: { list: KafkaAcl[] | null } | null;
  subjects: SchemaSubject[] | null;
  globalCompatibility: SchemaCompatibility | null;
  connect: ConnectData | null;
  ksqlInfo: KsqlDbInfo | null;
  loading: Partial<Record<KafkaLoad | 'topic', boolean>>;
  errors: Partial<Record<KafkaLoad | DetailLoad, string>>;
  toast: Toast | null;
}

/** What to load again after a write of the kind worked; only loads the page already used are repeated. */
const RELOAD_AFTER: Partial<Record<KafkaWriteKind, KafkaLoad[]>> = {
  createTopic: ['topics', 'overview'],
  deleteTopic: ['topics', 'overview'],
  clearTopic: ['topics'],
  recreateTopic: ['topics'],
  repartition: ['topics', 'overview'],
  setTopicConfig: ['topics'],
  produce: ['topics'],
  resetOffsets: ['groups', 'overview'],
  deleteGroup: ['groups', 'overview'],
  createAcls: ['acls'],
  deleteAcls: ['acls'],
  setGlobalCompatibility: ['subjects', 'overview'],
  registerSchema: ['subjects', 'overview'],
  deleteSchemaVersion: ['subjects', 'overview'],
  connector: ['connectors', 'overview'],
  restartTask: ['connectors', 'overview'],
  restartFailed: ['connectors', 'overview'],
  saveConnector: ['connectors', 'overview'],
};

/** Writes that change the open topic, which is then read again. */
const TOPIC_WRITES: ReadonlySet<KafkaWriteKind> = new Set(['clearTopic', 'recreateTopic', 'repartition', 'setTopicConfig', 'produce']);

type DoneListener = (write: KafkaWrite | null, message: string) => void;

export function createWorkspace() {
  const state = reactive<WorkspaceState>({
    init: null,
    initError: null,
    section: 'overview',
    topic: null,
    group: null,
    favourites: [],
    prefs: {},
    overview: null,
    brokers: null,
    topics: null,
    formats: {},
    topicDetail: null,
    topicConfigs: null,
    groups: null,
    acls: null,
    subjects: null,
    globalCompatibility: null,
    connect: null,
    ksqlInfo: null,
    loading: {},
    errors: {},
    toast: null,
  });
  /** Writes sent and not answered yet, oldest first per kind; the host answers each with `done` or `failed`. */
  const pending = new Map<KafkaWriteKind, { write: KafkaWrite; options: WriteOptions; resolve: (result: WriteResult) => void }[]>();
  const doneListeners = new Set<DoneListener>();
  /** Loads the page has asked for at least once, so a write only reloads what is shown somewhere. */
  const used = new Set<KafkaLoad>();
  /**
   * What a topic's screens held when they were left, by topic: the message filters and the produce form. Kept for
   * as long as the workspace is open, and across a reload of the page with the section and the open topic.
   */
  const memory = reactive({ filters: new Map<string, MessageFilter[]>(), produce: new Map<string, ProduceDraft>() });
  const saved = usePersistedState('kafka.workspace', {
    version: 1,
    value: () => workspaceToSave(state.section, state.topic, memory),
    validate: readSavedWorkspace,
  });
  /** A topic opened from the saved state; if it is gone, the topic list shows without a word. */
  let restoredTopic: string | null = null;
  let toastId = 0;

  /** Messages are copied so no Vue proxy goes to postMessage. */
  const post = (message: KafkaWorkspaceWebviewMessage) => postToHost(JSON.parse(JSON.stringify(message)) as KafkaWorkspaceWebviewMessage);

  function load(what: KafkaLoad): void {
    used.add(what);
    state.loading[what] = true;
    delete state.errors[what];
    post({ type: 'load', what });
  }

  function showToast(text: string, error = false): void {
    state.toast = { id: ++toastId, text, error };
  }

  /** Sends a write; the promise resolves with the host's `done` or `failed`. */
  function write(change: KafkaWrite, options: WriteOptions = {}): Promise<WriteResult> {
    return new Promise((resolve) => {
      const queue = pending.get(change.kind) ?? [];
      queue.push({ write: change, options, resolve });
      pending.set(change.kind, queue);
      post({ type: 'write', write: change });
    });
  }

  /** Calls `listener` after every write that worked; stops when the calling component unmounts. */
  function onDone(listener: DoneListener): void {
    doneListeners.add(listener);
    onUnmounted(() => doneListeners.delete(listener));
  }

  function settle(kind: KafkaWriteKind, ok: boolean, message: string, cancelled = false): void {
    const entry = pending.get(kind)?.shift();
    if (cancelled) {
      entry?.resolve({ ok: false, message: '', cancelled: true });
      return;
    }
    if (ok) {
      if (entry?.options.announce !== false) showToast(message);
      for (const what of RELOAD_AFTER[kind] ?? []) if (used.has(what)) load(what);
      const change = entry?.write ?? null;
      if (change && 'topic' in change && change.topic === state.topic && TOPIC_WRITES.has(kind)) reopenTopic();
      if (change?.kind === 'deleteTopic') forgetTopic(change.topic);
      for (const listener of doneListeners) listener(change, message);
    } else if (!entry?.options.quiet) {
      showToast(message, true);
    }
    entry?.resolve({ ok, message });
  }

  function go(section: KafkaSection): void {
    state.section = section;
    state.topic = null;
  }

  function openTopic(name: string): void {
    state.section = 'topics';
    if (state.topic !== name) {
      state.topicDetail = null;
      state.topicConfigs = null;
    }
    state.topic = name;
    reopenTopic();
    // The header shows the topic's format, and Clone checks names against the list.
    if (!state.topics && !state.loading.topics) load('topics');
  }

  function reopenTopic(): void {
    if (!state.topic) return;
    state.loading.topic = true;
    delete state.errors.topic;
    delete state.errors.topicConfigs;
    post({ type: 'openTopic', topic: state.topic });
  }

  function forgetTopic(name: string): void {
    if (state.topic === name) {
      state.topic = null;
      state.topicDetail = null;
      state.topicConfigs = null;
    }
    if (state.topics) state.topics = state.topics.filter((t) => t.name !== name);
  }

  function openGroup(groupId: string): void {
    state.group = groupId;
    go('consumers');
  }

  function setFavourite(topic: string, on: boolean): void {
    state.favourites = on ? [...new Set([...state.favourites, topic])] : state.favourites.filter((t) => t !== topic);
    post({ type: 'favourite', topic, on });
  }

  function copy(text: string, what: string): void {
    post({ type: 'copy', text, what });
  }

  function setPrefs(patch: KafkaWorkspacePrefs): void {
    state.prefs = { ...state.prefs, ...patch };
    post({ type: 'prefs', prefs: patch });
  }

  function handle(message: KafkaWorkspaceHostMessage): void {
    switch (message.type) {
      case 'init': {
        // A second init follows an edit of the data source: the page stays where it is and reads the cluster again.
        const again = state.init !== null;
        state.init = message.init;
        state.initError = null;
        state.favourites = message.init.favourites;
        state.prefs = message.init.prefs;
        load('overview');
        load('acls');
        if (again) {
          if (state.topic) reopenTopic();
          break;
        }
        // The page's saved place is newer than the one the panel was opened with.
        const restored = saved.restore();
        for (const [name, filters] of Object.entries(restored?.filters ?? {})) memory.filters.set(name, filters);
        for (const [name, draft] of Object.entries(restored?.produce ?? {})) memory.produce.set(name, draft);
        state.section = restored?.section ?? message.init.section;
        const topic = restored?.section ? (restored.section === 'topics' ? (restored.topic ?? null) : null) : message.init.topic;
        restoredTopic = restored?.section && topic ? topic : null;
        if (topic) openTopic(topic);
        else state.topic = null;
        break;
      }
      case 'initFailed':
        state.initError = message.message;
        break;
      case 'navigate':
        if (message.topic) openTopic(message.topic);
        else go(message.section);
        break;
      case 'overview':
        state.loading.overview = false;
        state.overview = { overview: message.overview, connectors: message.connectors, subjects: message.subjects, globalCompatibility: message.globalCompatibility };
        break;
      case 'brokers':
        state.loading.brokers = false;
        state.brokers = message.brokers;
        break;
      case 'topics':
        state.loading.topics = false;
        state.topics = message.topics;
        break;
      case 'topicFormats':
        state.formats = { ...state.formats, ...message.formats };
        break;
      case 'topic':
        if (message.detail.name === restoredTopic) restoredTopic = null;
        if (message.detail.name !== state.topic) break;
        state.loading.topic = false;
        state.topicDetail = message.detail;
        break;
      case 'topicConfigs':
        if (message.topic === state.topic) state.topicConfigs = message.configs;
        break;
      case 'topicGone':
        state.loading.topic = false;
        if (state.topic === message.topic && restoredTopic !== message.topic) showToast(`Topic ${message.topic} no longer exists; showing the topic list.`);
        if (restoredTopic === message.topic) restoredTopic = null;
        forgetTopic(message.topic);
        break;
      case 'groups':
        state.loading.groups = false;
        state.groups = message.groups;
        break;
      case 'acls':
        state.loading.acls = false;
        state.acls = { list: message.acls };
        break;
      case 'subjects':
        state.loading.subjects = false;
        state.subjects = message.subjects;
        state.globalCompatibility = message.globalCompatibility;
        break;
      case 'connectors':
        state.loading.connectors = false;
        state.connect = { connectors: message.connectors, workers: message.workers, version: message.version };
        break;
      case 'ksqlInfo':
        state.loading.ksqlInfo = false;
        state.ksqlInfo = message.info;
        break;
      case 'loadFailed':
        if (message.what !== 'brokerConfigs' && message.what !== 'group' && message.what !== 'schema' && message.what !== 'connectorConfig' && message.what !== 'topicConfigs') {
          state.loading[message.what] = false;
        }
        state.errors[message.what] = message.message;
        break;
      case 'done':
        settle(message.kind, true, message.message);
        break;
      case 'failed':
        settle(message.kind, false, message.message, !!message.cancelled);
        break;
      case 'favourites':
        state.favourites = message.names;
        break;
      case 'notice':
        showToast(message.message, !!message.error);
        break;
    }
  }

  const stop = onHostMessage<KafkaWorkspaceHostMessage>(handle);

  return { state, memory, post, load, write, onDone, go, openTopic, reopenTopic, openGroup, setFavourite, copy, setPrefs, showToast, stop };
}

export type Workspace = ReturnType<typeof createWorkspace>;

const KEY: InjectionKey<Workspace> = Symbol('kafkaWorkspace');

export function provideWorkspace(workspace: Workspace): void {
  provide(KEY, workspace);
}

export function useWorkspace(): Workspace {
  const workspace = inject(KEY);
  if (!workspace) throw new Error('The Kafka workspace is not provided.');
  return workspace;
}
