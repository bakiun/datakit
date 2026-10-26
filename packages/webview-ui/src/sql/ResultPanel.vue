<script setup lang="ts">
import { DATA_PAGE_SIZES, EXPORT_FORMATS } from '@datakit/core';
import Icon from '../components/Icon.vue';
import IconButton from '../components/IconButton.vue';
import DataGrid from './DataGrid.vue';
import type { SqlView } from './useSqlView';

/**
 * The result of the shown query under a SQL editor: status line, error, result toolbar, grid and footer.
 * `runControls` adds the Tx select and the Stop button to the toolbar; the console has them above its editor.
 */
const props = withDefaults(defineProps<{ view: SqlView; runControls?: boolean; emptyText?: string }>(), {
  runControls: true,
  emptyText: '',
});
const emit = defineEmits<{ goto: [position: number] }>();
const lockedTitle = 'Submit or revert your changes first';

function copyError(): void {
  const v = props.view;
  if (v.runError) v.post({ type: 'copySql', sql: v.runError });
}

function gotoFailed(): void {
  if (props.view.failedAt) emit('goto', props.view.failedAt.from);
}
</script>

<template>
  <p v-if="view.runInfo" class="info" role="status">{{ view.runInfo }}</p>
  <div v-if="(view.runError && !view.loading) || view.submitError" class="error" role="alert">
    <Icon name="error" :size="14" />
    <span>{{ view.submitError ? `Not written: ${view.submitError}` : view.runError }}</span>
    <span v-if="!view.submitError && view.summary" class="detail">· {{ view.summary }}</span>
    <span v-if="!view.submitError" class="links">
      <button v-if="view.failedAt" type="button" class="link" @click="gotoFailed">Go to statement</button>
      <button type="button" class="link" @click="copyError">Copy error</button>
    </span>
  </div>

  <div role="toolbar" aria-label="Result actions" class="toolbar">
    <IconButton icon="first" label="First page" :disabled="view.locked || !view.pageable || view.offset === 0" @click="view.repage({ offset: 0 })" />
    <IconButton
      icon="previous"
      label="Previous page"
      :disabled="view.locked || !view.pageable || view.offset === 0"
      @click="view.repage({ offset: Math.max(0, view.offset - view.limit) })"
    />
    <label class="range" :title="view.pending ? lockedTitle : undefined">
      <span class="mono">{{ view.rowCount ? `${view.offset + 1}–${view.offset + view.rowCount}` : '0' }}</span>
      <select
        class="sel"
        aria-label="Rows per page (LIMIT)"
        :value="view.limit"
        :disabled="view.locked || !view.pageable"
        @change="view.setLimit(Number(($event.target as HTMLSelectElement).value))"
      >
        <option v-if="!DATA_PAGE_SIZES.includes(view.limit as never)" :value="view.limit">{{ view.limit }}</option>
        <option v-for="size in DATA_PAGE_SIZES" :key="size" :value="size">{{ size }}</option>
      </select>
      <span class="muted">of {{ view.total === null ? 'many' : view.total.toLocaleString('en-US') }}</span>
    </label>
    <IconButton
      icon="next"
      label="Next page"
      :disabled="view.locked || !view.pageable || !view.hasNext"
      @click="view.repage({ offset: view.offset + view.limit })"
    />
    <IconButton
      icon="last"
      label="Last page"
      :disabled="view.locked || !view.pageable || !view.hasNext || view.pageCount === null"
      @click="view.repage({ offset: ((view.pageCount ?? 1) - 1) * view.limit })"
    />
    <span class="sep" />
    <IconButton icon="reload" :label="view.page ? 'Reload page' : 'Run'" :disabled="view.locked" @click="view.reload()" />
    <span class="sep" />
    <IconButton icon="plus" label="Add row" :disabled="!view.editable || view.loading" @click="view.changes.addRow()" />
    <IconButton icon="minus" label="Delete selected rows" :disabled="!view.editable || !view.selection.length" @click="view.deleteSelected()" />
    <IconButton icon="copy" label="Duplicate selected row" :disabled="!view.editable || view.selection.length !== 1" @click="view.duplicateSelected()" />
    <span class="sep" />
    <label v-if="runControls" class="field">
      Tx:
      <select
        class="sel"
        aria-label="Transaction mode"
        :value="view.autoCommit ? 'auto' : 'manual'"
        :disabled="view.transaction.open"
        @change="view.setTx(($event.target as HTMLSelectElement).value === 'auto')"
      >
        <option value="auto">Auto</option>
        <option value="manual">Manual</option>
      </select>
    </label>
    <IconButton icon="check" label="Submit changes (Ctrl+Enter)" tone="ok" :disabled="!view.pending || view.submitting" @click="view.submit()" />
    <IconButton icon="revert" label="Revert changes" :disabled="!view.pending || view.submitting" @click="view.revert()" />
    <template v-if="view.transaction.open">
      <button type="button" class="btn small primary" :disabled="view.loading || view.pending > 0" @click="view.endTransaction('commit')">Commit</button>
      <button type="button" class="btn small" :disabled="view.loading || view.pending > 0" @click="view.endTransaction('rollback')">Rollback</button>
    </template>
    <IconButton v-if="runControls" icon="stop" label="Stop query" tone="danger" :disabled="!view.loading" @click="view.post({ type: 'stop' })" />
    <span class="sep" />
    <label class="field">
      Export
      <select v-model="view.exportFormat" class="sel" aria-label="Export format">
        <option v-for="f in EXPORT_FORMATS" :key="f.value" :value="f.value">{{ f.label }}</option>
      </select>
    </label>
    <select v-model="view.exportScope" class="sel" aria-label="Rows to export">
      <option value="page">This page</option>
      <option value="all">All rows</option>
    </select>
    <IconButton
      icon="download"
      :label="view.exportScope === 'all' ? 'Export all rows of the query' : 'Export the rows on this page'"
      :disabled="!view.page?.rows.length"
      @click="view.exportRows()"
    />
  </div>

  <div class="grid-area" :class="{ dim: view.loading }">
    <DataGrid
      v-if="view.page"
      v-model:selected="view.selected"
      :columns="view.page.columns"
      :row-ids="view.rowIds"
      :row-key="view.page.editable?.rowKey ?? []"
      :sort="view.sort"
      :changes="view.changes"
      :editable="view.editable"
      :sortable="view.pageable && !view.locked"
      @sort="view.sortBy"
    />
    <p v-else-if="emptyText" class="empty">{{ emptyText }}</p>
  </div>

  <footer class="footer">
    <span>{{ view.selection.length ? `${view.selection.length} row${view.selection.length > 1 ? 's' : ''} selected` : 'No rows selected' }}</span>
    <span v-if="view.pending" class="pending">{{ view.pending }} pending change{{ view.pending > 1 ? 's' : '' }} — not written yet</span>
    <span v-if="view.transaction.open" class="pending">
      Transaction open: {{ view.transaction.changes }} change{{ view.transaction.changes === 1 ? '' : 's' }} not committed. Closing this tab rolls them
      back.
    </span>
    <span v-if="view.readOnly">{{ view.readOnly }}</span>
    <span v-else-if="view.page">Click a header to sort, Shift+click adds a column · Click a cell to edit · Enter saves · Esc cancels · type NULL to clear a nullable value</span>
    <span v-if="view.pageable" class="page-no">Page {{ view.pageNo }}{{ view.pageCount === null ? '' : ` of ${view.pageCount}` }}</span>
  </footer>
</template>

<style scoped>
.info {
  flex: none;
  margin: 4px 12px 0;
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
}
.error {
  flex: none;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 10px;
  margin: 8px 12px 0;
  padding: 7px 10px;
  border: 1px solid color-mix(in srgb, var(--vscode-errorForeground) 45%, transparent);
  border-radius: 4px;
  background: color-mix(in srgb, var(--vscode-errorForeground) 10%, transparent);
  color: var(--vscode-errorForeground);
  font-size: 12px;
}
.error .detail {
  color: var(--vscode-foreground);
}
.links {
  margin-left: auto;
  display: flex;
  gap: 14px;
}
.link {
  padding: 0;
  border: 0;
  background: none;
  color: var(--vscode-textLink-foreground);
  font: inherit;
  cursor: pointer;
}
.link:hover {
  text-decoration: underline;
}
.toolbar {
  flex: none;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 2px;
  margin: 8px 12px 0;
  padding: 3px 8px;
  border: 1px solid var(--vscode-panel-border);
  border-bottom: 0;
  border-radius: 4px 4px 0 0;
  background: var(--vscode-editorWidget-background);
}
.range,
.field {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 0 4px;
  font-size: 12px;
}
.sel {
  height: 26px;
  padding: 0 4px;
  border: 1px solid var(--vscode-dropdown-border, var(--vscode-panel-border));
  border-radius: 4px;
  background: var(--vscode-dropdown-background);
  color: var(--vscode-dropdown-foreground);
  font: inherit;
  font-size: 12px;
}
.muted {
  color: var(--vscode-descriptionForeground);
}
.sep {
  flex: none;
  width: 1px;
  height: 18px;
  margin: 0 6px;
  background: var(--vscode-panel-border);
}
.btn.small {
  height: 24px;
  padding: 0 10px;
  font-size: 12px;
}
.btn.primary {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
}
.grid-area {
  flex: 1;
  min-height: 120px;
  overflow: auto;
  margin: 0 12px;
  border: 1px solid var(--vscode-panel-border);
}
.grid-area.dim {
  opacity: 0.45;
}
.empty {
  height: 100%;
  min-height: 120px;
  margin: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
}
.footer {
  flex: none;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 16px;
  padding: 6px 12px 8px;
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
}
.footer .pending {
  color: var(--vscode-editorWarning-foreground);
}
.page-no {
  margin-left: auto;
}
</style>
