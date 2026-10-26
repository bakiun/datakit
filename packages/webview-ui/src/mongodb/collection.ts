import type {
  MongoCollectionHostMessage,
  MongoCollectionInfo,
  MongoCollectionInit,
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

/**
 * State shared by the tabs of one collection: what the host sent about it, the writes waiting for their answer, the
 * explain on show and the shell. Tabs that read pages (Documents, Aggregation) listen to the host themselves.
 */

export type Tab = 'documents' | 'aggregation' | 'indexes' | 'schema';

export interface ExplainView {
  /** What was explained, e.g. `find` or `aggregate`. */
  title: string;
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
  shell: { entries: ShellEntry[]; busy: boolean; database: string };
  /**
   * Bumped by every write that may change the documents or the indexes, from the page or the shell. A tab compares
   * it with the version it last read, so it reads again when it is shown.
   */
  documentsVersion: number;
  indexesVersion: number;
}

const DOCUMENT_EDITS: ReadonlySet<MongoEditKind> = new Set(['insert', 'replace', 'setField', 'unsetField', 'delete', 'deleteMatching', 'updateMatching']);

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
    shell: { entries: [], busy: false, database: '' },
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
    state.explain = { title, loading: true, explain: null, error: null };
    post({ type: 'explain', query });
  }

  function runShell(line: string): void {
    state.shell.busy = true;
    post({ type: 'shell', line });
  }

  function copy(text: string, what: string): void {
    post({ type: 'copy', text, what });
  }

  function settle(kind: MongoEditKind, ok: boolean, message: string): void {
    const entry = pending.get(kind)?.shift();
    if (ok) {
      showToast(message);
      changed(DOCUMENT_EDITS.has(kind), !DOCUMENT_EDITS.has(kind));
    } else if (!entry?.quiet) showToast(message, true);
    entry?.resolve({ ok, message });
  }

  function handle(message: MongoCollectionHostMessage): void {
    switch (message.type) {
      case 'init':
        state.init = message.init;
        state.initError = null;
        state.info = message.init.info;
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
        settle(message.kind, false, message.message);
        break;
      case 'shell':
        state.shell.busy = false;
        state.shell.entries.push({ line: message.line, output: message.output, ok: message.ok, durationMs: message.durationMs, database: state.shell.database });
        // Keeps the log bounded; the oldest lines go first.
        if (state.shell.entries.length > 200) state.shell.entries.splice(0, state.shell.entries.length - 200);
        state.shell.database = message.database;
        if (message.wrote) changed(true, true);
        break;
      case 'notice':
        showToast(message.message);
        break;
      case 'page':
      case 'pageFailed':
        // The tab that asked answers these.
        break;
    }
  }

  const stop = onHostMessage<MongoCollectionHostMessage>(handle);

  return { state, readOnlyReason, canWrite, post, nextRequestId, load, write, explain, runShell, copy, showToast, stop };
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
