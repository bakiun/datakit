import type {
  MongoCollectionHostMessage,
  MongoCollectionInfo,
  MongoCollectionInit,
  MongoCollectionPrefs,
  MongoCollectionWebviewMessage,
  MongoEdit,
  MongoEditKind,
  MongoExplain,
  MongoFindQuery,
  MongoIndex,
  MongoSchema,
} from '@datakit/core';
import { computed, inject, provide, reactive, type InjectionKey } from 'vue';
import type { ActionResult } from '../components/ModalDialog.vue';
import type { Toast } from '../components/ToastNote.vue';
import { onHostMessage, postToHost } from '../host';
import { filterFields } from './shellSyntax';

/**
 * State shared by the tabs of one collection: what the host sent about it, the writes waiting for their answer, the
 * explain on show and the shell. Tabs that read pages (Documents, Aggregation) listen to the host themselves.
 */

export type Tab = 'documents' | 'aggregation' | 'indexes' | 'schema';

export interface ExplainView {
  /** What was explained, e.g. `find` or `aggregate`. */
  title: string;
  /** The fields a find filters on, for an index the dialog can offer to create. */
  fields: string[];
  loading: boolean;
  explain: MongoExplain | null;
  error: string | null;
}

export interface ShellEntry {
  line: string;
  output: string;
  ok: boolean;
  durationMs: number;
  /** The prompt's database when the line was typed. */
  database: string;
}

type Load = 'indexes' | 'schema' | 'info';

export interface CollectionState {
  init: MongoCollectionInit | null;
  initError: string | null;
  info: MongoCollectionInfo | null;
  tab: Tab;
  indexes: MongoIndex[] | null;
  schema: MongoSchema | null;
  /** The sample size of the schema on show. */
  schemaSample: number;
  loading: Partial<Record<Load, boolean>>;
  errors: Partial<Record<Load, string>>;
  explain: ExplainView | null;
  toast: Toast | null;
  /** `running` is the line the shell runs now. */
  shell: { entries: ShellEntry[]; busy: boolean; database: string; open: boolean; running: string };
  /** Asks the Indexes tab to open Create index with these keys, e.g. from Explain. */
  createIndex: { keys: string } | null;
  /**
   * Bumped by every write that may change the documents or the indexes, from the page or the shell. A tab compares
   * it with the version it last read, so it reads again when it is shown.
   */
  documentsVersion: number;
  indexesVersion: number;
}

const DOCUMENT_EDITS: ReadonlySet<MongoEditKind> = new Set(['insert', 'replace', 'setField', 'unsetField', 'delete', 'deleteMatching', 'updateMatching']);
/**
 * Writes whose result shows where they were made (the cell, the document pane, the card that goes, the index row),
 * so they need no toast. Inserts and writes by filter say what they did: the counts are not on show anywhere else.
 */
const SHOWN_IN_PLACE: ReadonlySet<MongoEditKind> = new Set(['replace', 'setField', 'unsetField', 'delete', 'createIndex', 'dropIndex', 'hideIndex']);

export function createCollection() {
  const state = reactive<CollectionState>({
    init: null,
    initError: null,
    info: null,
    tab: 'documents',
    indexes: null,
    schema: null,
    schemaSample: 1000,
    loading: {},
    errors: {},
    explain: null,
    toast: null,
    shell: { entries: [], busy: false, database: '', open: false, running: '' },
    createIndex: null,
    documentsVersion: 0,
    indexesVersion: 0,
  });
  /** Writes sent and not answered yet, oldest first per kind; the host answers each with `written` or `writeFailed`. */
  const pending = new Map<MongoEditKind, { quiet: boolean; resolve: (result: ActionResult) => void }[]>();
  let toastId = 0;
  let requestSeq = 0;

  /** Messages are copied so no Vue proxy goes to postMessage. */
  const post = (message: MongoCollectionWebviewMessage) => postToHost(JSON.parse(JSON.stringify(message)) as MongoCollectionWebviewMessage);

  /** Views and read-only data sources cannot be changed; the reason is shown once, in the header. */
  const readOnlyReason = computed((): string | null => {
    const init = state.init;
    if (!init) return null;
    if (init.type === 'view') return 'Views are read-only.';
    return init.readOnly ? 'Read-only data source: changes are turned off.' : null;
  });
  const canWrite = computed(() => readOnlyReason.value === null);

  function nextRequestId(): number {
    return ++requestSeq;
  }

  function load(what: Load, sample?: number): void {
    state.loading[what] = true;
    delete state.errors[what];
    if (what === 'schema' && sample !== undefined) state.schemaSample = sample;
    post(what === 'schema' ? { type: 'load', what, sample: sample ?? state.schemaSample } : { type: 'load', what });
  }

  function showToast(text: string, error = false): void {
    state.toast = { id: ++toastId, text, error };
  }

  /**
   * Sends an edit; the promise resolves with the host's answer. A `quiet` edit leaves showing a failure to the
   * caller, e.g. a dialog that shows it inline.
   */
  function write(edit: MongoEdit, options: { quiet?: boolean } = {}): Promise<ActionResult> {
    return new Promise((resolve) => {
      const queue = pending.get(edit.kind) ?? [];
      queue.push({ quiet: !!options.quiet, resolve });
      pending.set(edit.kind, queue);
      post({ type: 'edit', edit });
    });
  }

  /** Marks what a write may have changed, so the tabs read it again, and reads the counts and sizes. */
  function changed(documents: boolean, indexes: boolean): void {
    if (documents) state.documentsVersion++;
    if (indexes) state.indexesVersion++;
    load('info');
  }

  function explain(query: MongoFindQuery | { pipeline: string }, title: string): void {
    state.explain = { title, fields: 'filter' in query ? filterFields(query.filter) : [], loading: true, explain: null, error: null };
    post({ type: 'explain', query });
  }

  /** Lines waiting for the shell, which runs one at a time, e.g. `use` and then a pipeline. */
  const shellQueue: string[] = [];

  /** Runs a shell line, after the ones before it; `show` opens the shell so its answer can be seen. */
  function runShell(line: string, show = false): void {
    if (show) state.shell.open = true;
    if (state.shell.busy) {
      shellQueue.push(line);
      return;
    }
    state.shell.busy = true;
    state.shell.running = line;
    post({ type: 'shell', line });
  }

  /** Keeps a choice for the next tab. */
  function remember(prefs: Partial<MongoCollectionPrefs> & { pageSize?: number }): void {
    post({ type: 'remember', prefs });
  }

  function copy(text: string, what: string): void {
    post({ type: 'copy', text, what });
  }

  /** A cancelled write (the user said no in VS Code's confirmation) leaves everything as it was, without an error. */
  function settle(kind: MongoEditKind, ok: boolean, message: string, cancelled = false): void {
    const entry = pending.get(kind)?.shift();
    if (ok) {
      if (!SHOWN_IN_PLACE.has(kind)) showToast(message);
      changed(DOCUMENT_EDITS.has(kind), !DOCUMENT_EDITS.has(kind));
    } else if (!entry?.quiet && !cancelled) showToast(message, true);
    entry?.resolve({ ok, message: cancelled ? '' : message });
  }

  function handle(message: MongoCollectionHostMessage): void {
    switch (message.type) {
      case 'init':
        state.init = message.init;
        state.initError = null;
        state.info = message.init.info;
        state.schemaSample = message.init.prefs.schemaSample;
        state.shell.database = message.init.database;
        if (message.init.type === 'view' && state.tab === 'indexes') state.tab = 'documents';
        break;
      case 'initFailed':
        state.initError = message.message;
        break;
      case 'explain':
        if (state.explain) state.explain = { ...state.explain, loading: false, explain: message.explain, error: null };
        break;
      case 'explainFailed':
        if (state.explain) state.explain = { ...state.explain, loading: false, explain: null, error: message.message };
        break;
      case 'indexes':
        state.loading.indexes = false;
        state.indexes = message.indexes;
        break;
      case 'schema':
        state.loading.schema = false;
        state.schema = message.schema;
        break;
      case 'info':
        state.loading.info = false;
        state.info = message.info;
        break;
      case 'loadFailed':
        state.loading[message.what] = false;
        state.errors[message.what] = message.message;
        break;
      case 'written':
        settle(message.kind, true, message.result.summary);
        break;
      case 'writeFailed':
        settle(message.kind, false, message.message, message.cancelled);
        break;
      case 'shell':
        state.shell.busy = false;
        state.shell.entries.push({ line: message.line, output: message.output, ok: message.ok, durationMs: message.durationMs, database: state.shell.database });
        // Keeps the log bounded; the oldest lines go first.
        if (state.shell.entries.length > 200) state.shell.entries.splice(0, state.shell.entries.length - 200);
        state.shell.database = message.database;
        if (message.wrote) changed(true, true);
        if (shellQueue.length) runShell(shellQueue.shift()!);
        break;
      case 'notice':
        showToast(message.message, !!message.error);
        break;
      case 'page':
      case 'pageFailed':
        // The tab that asked answers these.
        break;
    }
  }

  const stop = onHostMessage<MongoCollectionHostMessage>(handle);

  return { state, readOnlyReason, canWrite, post, nextRequestId, load, write, explain, runShell, remember, copy, showToast, stop };
}

export type Collection = ReturnType<typeof createCollection>;

const KEY: InjectionKey<Collection> = Symbol('mongoCollection');

export function provideCollection(collection: Collection): void {
  provide(KEY, collection);
}

export function useCollection(): Collection {
  const collection = inject(KEY);
  if (!collection) throw new Error('The MongoDB collection is not provided.');
  return collection;
}
