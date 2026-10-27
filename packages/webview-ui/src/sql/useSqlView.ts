import {
  isPageableQuery,
  splitSqlScript,
  type ExportFormat,
  type ExportScope,
  type LoadedPage,
  type ScriptStatement,
  type SortKey,
  type SqlDialect,
  type TableDataHostMessage,
  type TableDataInit,
  type TableDataWebviewMessage,
} from '@datakit/core';
import { computed, markRaw, reactive, ref, type Ref } from 'vue';
import type { ActionResult } from '../components/ModalDialog.vue';
import { isSubmitShortcut } from '../components/shortcuts';
import { postToHost } from '../host';
import type ScriptEditor from './ScriptEditor.vue';
import { applyPaging, readPaging, unpaged, withoutLimit, type Paging } from './scriptClauses';
import { existingRowId, useTableChanges, type RowId } from './tableChanges';

export type ScriptEditorApi = InstanceType<typeof ScriptEditor>;

type PagingChange = { sort?: SortKey[]; limit?: number; offset?: number };

/**
 * What the data view and the query console share: running the script, paging and sorting the shown query,
 * grid edits and transactions. `handle` takes the host messages about them and returns false for others.
 * The result is reactive, so templates read `view.loading` without `.value`.
 */
export function useSqlView(init: Ref<TableDataInit | null>, editor: Ref<ScriptEditorApi | undefined>, script: Ref<string>) {
  const page = ref<LoadedPage | null>(null);
  const runError = ref<string | null>(null);
  /** Where the statement that failed is in the editor. */
  const failedAt = ref<{ from: number; to: number } | null>(null);
  const summary = ref('');
  const loading = ref(false);
  const submitting = ref(false);
  const submitError = ref<string | null>(null);
  const notice = ref('');
  const autoCommit = ref(true);
  const transaction = ref({ open: false, changes: 0 });
  const exportFormat = ref<ExportFormat>('csv');
  const exportScope = ref<ExportScope>('page');
  const selected = ref(new Set<RowId>());
  /** The LIMIT a query without one gets: the data source's page size, or the one picked in the grid since. */
  const pageSize = ref(100);
  /** Set while the user is asked whether to drop the pending grid edits for an action, e.g. Run. */
  const discardPrompt = ref<{ text: string; primary: string; proceed: () => void } | null>(null);

  const dialect = computed<SqlDialect>(() => init.value?.dialect ?? 'mysql');
  const changes = useTableChanges(page);
  const post = (message: TableDataWebviewMessage) => postToHost(message);
  const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

  const pending = computed(() => changes.count.value);
  const busy = computed(() => loading.value || submitting.value);
  const locked = computed(() => pending.value > 0 || busy.value);
  /** Sorting and paging of the shown query, read from its ORDER BY and LIMIT. */
  const paging = computed(() =>
    page.value && isPageableQuery(page.value.statement.text, dialect.value) ? readPaging(page.value.statement.text, dialect.value) : null,
  );
  const sort = computed(() => paging.value?.sort ?? []);
  const pageable = computed(() => paging.value !== null && paging.value.limit !== null);
  const limit = computed(() => paging.value?.limit ?? pageSize.value);
  const offset = computed(() => paging.value?.offset ?? 0);
  const total = computed(() => page.value?.total ?? null);
  const rowCount = computed(() => page.value?.rows.length ?? 0);
  const hasNext = computed(() => (total.value === null ? rowCount.value >= limit.value : offset.value + limit.value < total.value));
  const pageNo = computed(() => Math.floor(offset.value / limit.value) + 1);
  const pageCount = computed(() => (total.value === null ? null : Math.max(1, Math.ceil(total.value / limit.value))));
  const editable = computed(() => !!page.value?.editable && !submitting.value);
  const readOnly = computed(() => page.value?.readOnlyReason ?? null);
  const rowIds = computed(() => [...changes.inserts.value.map((r) => r.id), ...(page.value?.rows.map((_, i) => existingRowId(i)) ?? [])]);
  const selection = computed(() => rowIds.value.filter((id) => selected.value.has(id)));
  /** Every selected row is marked for deletion, so the delete button brings them back instead. */
  const selectionDeleted = computed(() => selection.value.length > 0 && selection.value.every((id) => changes.isDeleted(id)));
  /** Why the rows cannot be paged, sorted or reloaded now, for the tooltips of those controls; null when they can. */
  const pagingOff = computed<string | null>(() => {
    if (!page.value) return null;
    if (pending.value) return 'submit or revert your changes first';
    if (!paging.value) return 'only SELECT results can be paged and sorted';
    return paging.value.limit === null ? 'add a LIMIT to the query to page it' : null;
  });

  /** What the last run showed: rows, timing and the rest of the script. Errors are shown apart. */
  const runInfo = computed(() => {
    if (loading.value) return 'Running…';
    const p = page.value;
    if (runError.value) return '';
    if (!p) return summary.value;
    const took = `query took ${(p.durationMs / 1000).toFixed(4)} seconds`;
    let text: string;
    if (!p.rows.length) text = `${init.value?.product ?? 'The server'} returned an empty result set (zero rows); ${took}.`;
    else if (!pageable.value) text = `${p.rows.length.toLocaleString('en-US')} rows (${took}).`;
    else {
      const range = `${offset.value + 1}–${offset.value + p.rows.length}`;
      text = `Showing rows ${range} (${total.value === null ? '' : `${total.value.toLocaleString('en-US')} total, `}${took}).`;
    }
    return summary.value ? `${text} · ${summary.value}` : text;
  });

  function statementOf(part: { text: string; from: number; to: number }): ScriptStatement {
    if (!isPageableQuery(part.text, dialect.value)) return { ...part };
    return { ...part, unpaged: unpaged(part.text, dialect.value), unlimited: withoutLimit(part.text, dialect.value) };
  }

  /** What the views do with a new TableDataInit. */
  function start(value: TableDataInit): void {
    autoCommit.value = value.autoCommit;
    pageSize.value = value.pageSize;
    exportFormat.value = value.exportFormat;
    exportScope.value = value.exportScope;
  }

  /**
   * Runs the script, or the selection. The last query gets a LIMIT if it has none, so a big table is never read in full.
   * `record: false` keeps the statements out of the query history. With grid edits not written yet, it asks first
   * whether to drop them.
   */
  function run(options: { record?: boolean } = {}): void {
    if (busy.value || !editor.value) return;
    if (pending.value) {
      const n = pending.value;
      const text = `${n} change${n === 1 ? '' : 's'} in the grid ${n === 1 ? 'is' : 'are'} not written yet. Running the script shows new rows and drops ${n === 1 ? 'it' : 'them'}.`;
      discardPrompt.value = { text, primary: 'Discard and Run', proceed: () => run(options) };
      return;
    }
    const source = editor.value.selection() ?? { from: 0, text: script.value };
    let parts = splitSqlScript(source.text, dialect.value).map((p) => ({ text: p.text, from: source.from + p.from, to: source.from + p.to }));
    if (!parts.length) return;
    const last = [...parts].reverse().find((p) => isPageableQuery(p.text, dialect.value));
    if (last && readPaging(last.text, dialect.value).limit === null) {
      const text = applyPaging(last.text, dialect.value, { limit: pageSize.value, offset: 0 });
      editor.value.replace(last.from, last.to, text);
      const shift = text.length - last.text.length;
      parts = parts.map((p) => (p === last ? { ...p, text, to: p.from + text.length } : p.from > last.from ? { ...p, from: p.from + shift, to: p.to + shift } : p));
    }
    loading.value = true;
    runError.value = null;
    failedAt.value = null;
    editor.value.mark();
    post({ type: 'run', statements: parts.map(statementOf), autoCommit: autoCommit.value, ...(options.record === false ? { record: false } : {}) });
  }

  /** The primary action of the discard prompt: drops the grid edits and does what was asked. */
  async function discardAndProceed(): Promise<ActionResult> {
    const prompt = discardPrompt.value;
    discardPrompt.value = null;
    changes.reset();
    selected.value = new Set();
    submitError.value = null;
    prompt?.proceed();
    return { ok: true, message: '' };
  }

  /**
   * The shown query as it is in the editor now, which the user may have edited since it ran. When an edit leaves
   * several queries where it was, e.g. the whole script was replaced, the last of them, as Run would show it.
   * Null when no query is left there.
   */
  function shownQuery(): { text: string; from: number; to: number; edited: boolean } | null {
    const current = page.value?.statement;
    if (!current || !editor.value) return null;
    // Without the text typed right at either end, e.g. a statement added in front of the query.
    const inner = { from: editor.value.mapped(current.from, 1), to: editor.value.mapped(current.to, -1) };
    if (inner.from < inner.to && editor.value.slice(inner.from, inner.to) === current.text) {
      return { text: current.text, ...inner, edited: false };
    }
    const outer = { from: editor.value.mapped(current.from, -1), to: editor.value.mapped(current.to, 1) };
    const queries = splitSqlScript(script.value, dialect.value).filter((p) => isPageableQuery(p.text, dialect.value));
    const overlapping = (range: { from: number; to: number }) => queries.filter((p) => p.from < range.to && p.to > range.from);
    const inside = inner.from < inner.to ? overlapping(inner) : [];
    const part = (inside.length ? inside : overlapping(outer)).at(-1);
    return part ? { text: part.text, from: part.from, to: part.to, edited: part.text !== current.text } : null;
  }

  /**
   * Rewrites the ORDER BY or LIMIT of the shown query in the script and runs it again. A query edited since it ran
   * runs as Run would run it, so it goes into the history too. A query no longer in the script, e.g. replaced by
   * another statement, is paged as it was shown, and the script is left alone.
   */
  function repage(change: PagingChange | ((paging: Paging) => PagingChange)): void {
    if (!page.value || !editor.value || locked.value) return;
    const target = shownQuery();
    const paged = (text: string) => applyPaging(text, dialect.value, typeof change === 'function' ? change(readPaging(text, dialect.value)) : change);
    if (!target) {
      const shown = page.value.statement;
      loading.value = true;
      runError.value = null;
      post({ type: 'query', statement: statementOf({ text: paged(shown.text), from: shown.from, to: shown.to }) });
      return;
    }
    const text = paged(target.text);
    editor.value.replace(target.from, target.to, text);
    editor.value.mark();
    const statement = statementOf({ text, from: target.from, to: target.from + text.length });
    loading.value = true;
    runError.value = null;
    if (target.edited) {
      failedAt.value = null;
      post({ type: 'run', statements: [statement], autoCommit: autoCommit.value });
    } else {
      post({ type: 'query', statement });
    }
  }

  function reload(): void {
    if (!page.value) return run();
    loading.value = true;
    runError.value = null;
    post({ type: 'query', statement: clone(page.value.statement) });
  }

  /**
   * Click sorts by one column (asc → desc → off); Shift+click adds, flips or removes a column.
   * It starts from the ORDER BY and LIMIT in the editor, which the user may have changed since the query ran.
   */
  function sortBy(column: string, additive: boolean): void {
    repage((paging) => {
      const current = paging.sort ?? [];
      const index = current.findIndex((k) => k.column === column);
      let next: SortKey[];
      if (additive) {
        next = [...current];
        if (index < 0) next.push({ column, direction: 'asc' });
        else if (next[index]!.direction === 'asc') next[index] = { column, direction: 'desc' };
        else next.splice(index, 1);
      } else if (current.length === 1 && index === 0) {
        next = current[0]!.direction === 'asc' ? [{ column, direction: 'desc' }] : [];
      } else {
        next = [{ column, direction: 'asc' }];
      }
      return { sort: next, limit: paging.limit ?? pageSize.value, offset: 0 };
    });
  }

  /** A page size picked in the grid; it is kept for the next runs and the next views of the data source. */
  function setLimit(value: number): void {
    pageSize.value = value;
    repage({ limit: value, offset: 0 });
    post({ type: 'pageSize', pageSize: value });
  }

  /** Marks the selected rows for deletion, or brings them back when all of them are marked already. */
  function deleteSelected(): void {
    if (selectionDeleted.value) changes.restore(selection.value);
    else changes.remove(selection.value);
    selected.value = new Set();
  }

  function duplicateSelected(): void {
    const [id] = selection.value;
    if (id) changes.duplicate(id);
    selected.value = new Set();
  }

  function submit(): void {
    if (!pending.value || submitting.value || !page.value) return;
    submitting.value = true;
    submitError.value = null;
    post({ type: 'submit', changes: clone(changes.changes()), autoCommit: autoCommit.value, statement: clone(page.value.statement) });
  }

  function revert(): void {
    changes.reset();
    submitError.value = null;
  }

  function endTransaction(type: 'commit' | 'rollback'): void {
    loading.value = true;
    post({ type, statement: page.value ? clone(page.value.statement) : null });
  }

  function setTx(auto: boolean): void {
    autoCommit.value = auto;
    post({ type: 'txMode', autoCommit: auto });
  }

  function exportRows(): void {
    post({ type: 'export', format: exportFormat.value, scope: exportScope.value });
  }

  let noticeTimer: ReturnType<typeof setTimeout> | undefined;
  function showNotice(message: string): void {
    notice.value = message;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => (notice.value = ''), 4000);
  }

  /** ⌘Enter (Ctrl+Enter off macOS) outside the editor submits grid changes, or runs the script. */
  function onKey(event: KeyboardEvent): void {
    if (!isSubmitShortcut(event)) return;
    if ((event.target as HTMLElement).closest('.cm-editor')) return;
    event.preventDefault();
    if (pending.value) submit();
    else run();
  }

  function handle(message: TableDataHostMessage): boolean {
    switch (message.type) {
      case 'page':
        page.value = message.page;
        runError.value = null;
        summary.value = message.summary ?? '';
        loading.value = false;
        submitting.value = false;
        submitError.value = null;
        changes.reset();
        selected.value = new Set();
        return true;
      case 'ran':
        loading.value = false;
        runError.value = null;
        summary.value = message.summary;
        return true;
      case 'runFailed':
        loading.value = false;
        runError.value = message.message;
        failedAt.value = message.failed ?? null;
        summary.value = message.summary ?? '';
        return true;
      case 'submitFailed':
        loading.value = false;
        submitting.value = false;
        submitError.value = message.message;
        return true;
      case 'declined':
        loading.value = false;
        submitting.value = false;
        showNotice(message.message);
        return true;
      case 'transaction':
        transaction.value = { open: message.open, changes: message.changes };
        return true;
      case 'notice':
        showNotice(message.message);
        return true;
      default:
        return false;
    }
  }

  return reactive({
    init,
    page,
    runError,
    failedAt,
    summary,
    loading,
    submitting,
    submitError,
    notice,
    autoCommit,
    transaction,
    exportFormat,
    exportScope,
    selected,
    pageSize,
    discardPrompt,
    dialect,
    // The grid calls its functions; it stays a plain object so its refs keep their type.
    changes: markRaw(changes),
    pending,
    busy,
    locked,
    sort,
    pageable,
    limit,
    offset,
    total,
    rowCount,
    hasNext,
    pageNo,
    pageCount,
    editable,
    readOnly,
    rowIds,
    selection,
    selectionDeleted,
    pagingOff,
    runInfo,
    post,
    start,
    run,
    discardAndProceed,
    repage,
    reload,
    sortBy,
    setLimit,
    deleteSelected,
    duplicateSelected,
    submit,
    revert,
    endTransaction,
    setTx,
    exportRows,
    showNotice,
    onKey,
    handle,
  });
}

export type SqlView = ReturnType<typeof useSqlView>;
