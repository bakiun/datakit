<script setup lang="ts">
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { sql } from '@codemirror/lang-sql';
import { bracketMatching, syntaxHighlighting } from '@codemirror/language';
import { ChangeSet, Compartment, EditorSelection, EditorState } from '@codemirror/state';
import { drawSelection, EditorView, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers, placeholder } from '@codemirror/view';
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { SqlDialect } from '@datakit/core';
import { codeHighlight as highlight, codeTheme as theme } from '../components/codeTheme';
import { SUBMIT_KEY } from '../components/shortcuts';
import { GRAMMARS } from './scriptClauses';

/**
 * The SQL script editor (CodeMirror) with MySQL, MariaDB or PostgreSQL highlighting and completion. Ctrl+Enter runs,
 * and ⌘Enter too on macOS.
 */
const props = defineProps<{ dialect: SqlDialect; schema: Record<string, string[]>; defaultTable: string }>();
const model = defineModel<string>({ required: true });
/** `select`: the cursor or selection moved, as anchor and head; the views keep it to come back after a reload. */
const emit = defineEmits<{ run: []; select: [range: { anchor: number; head: number }] }>();

const host = ref<HTMLElement>();
let view: EditorView | undefined;
/** The SQL language settings; replaced when the dialect or the known tables change, e.g. in another database. */
const language = new Compartment();
/** The edits made since `mark()`, to find where text sent to the host has moved since. */
let sinceMark: ChangeSet | undefined;
const sqlLanguage = () =>
  sql({ dialect: GRAMMARS[props.dialect], schema: props.schema, defaultTable: props.defaultTable, upperCaseKeywords: true });

onMounted(() => {
  view = new EditorView({
    parent: host.value!,
    state: EditorState.create({
      doc: model.value,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightActiveLine(),
        history(),
        drawSelection(),
        bracketMatching(),
        closeBrackets(),
        autocompletion(),
        language.of(sqlLanguage()),
        syntaxHighlighting(highlight),
        theme,
        placeholder(`Write SQL here — ${SUBMIT_KEY} runs it, or the selection`),
        EditorView.cspNonce.of(document.body.dataset.nonce ?? ''),
        EditorView.contentAttributes.of({ 'aria-label': 'SQL script' }),
        keymap.of([
          { key: 'Mod-Enter', run: () => (emit('run'), true) },
          // Labels say Ctrl+Enter off macOS; on macOS it works as well as ⌘Enter.
          { key: 'Ctrl-Enter', run: () => (emit('run'), true) },
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...historyKeymap,
          ...completionKeymap,
          indentWithTab,
        ]),
        EditorView.updateListener.of((update) => {
          if (update.selectionSet) {
            const { anchor, head } = update.state.selection.main;
            emit('select', { anchor, head });
          }
          if (!update.docChanged) return;
          model.value = update.state.doc.toString();
          sinceMark = sinceMark?.compose(update.changes);
        }),
      ],
    }),
  });
});

watch(model, (text) => {
  if (view && text !== view.state.doc.toString()) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
});

watch(
  () => [props.dialect, props.schema, props.defaultTable],
  () => view?.dispatch({ effects: language.reconfigure(sqlLanguage()) }),
);

onBeforeUnmount(() => view?.destroy());

defineExpose({
  /** The selected text, if any; Run runs only that. */
  selection(): { from: number; text: string } | null {
    const range = view?.state.selection.main;
    return view && range && !range.empty ? { from: range.from, text: view.state.sliceDoc(range.from, range.to) } : null;
  },
  /** Replaces part of the script as an edit the user can undo. */
  replace(from: number, to: number, text: string): void {
    view?.dispatch({ changes: { from, to, insert: text } });
  },
  slice(from: number, to: number): string {
    return view?.state.sliceDoc(from, to) ?? '';
  },
  /** Starts following the edits, so `mapped` can tell where a position of the script as it is now moves to. */
  mark(): void {
    if (view) sinceMark = ChangeSet.empty(view.state.doc.length);
  },
  /** Where a position from the time of `mark()` is now; `assoc` -1 stays before text typed right at it, 1 goes after. */
  mapped(position: number, assoc: -1 | 1): number {
    return sinceMark ? sinceMark.mapPos(position, assoc) : position;
  },
  /** Where the cursor is. */
  cursor(): number {
    return view?.state.selection.main.head ?? 0;
  },
  /** Selects from `anchor` to `head` (the cursor when equal) without taking the focus, e.g. after a reload. */
  setSelection(anchor: number, head: number): void {
    if (!view) return;
    const length = view.state.doc.length;
    view.dispatch({ selection: EditorSelection.single(Math.min(anchor, length), Math.min(head, length)), scrollIntoView: true });
  },
  /** Puts the cursor at `position`, scrolls there and focuses the editor. */
  focusAt(position: number): void {
    if (!view) return;
    const at = Math.min(position, view.state.doc.length);
    view.dispatch({ selection: EditorSelection.cursor(at), scrollIntoView: true });
    view.focus();
  },
});
</script>

<template>
  <div ref="host" class="script-editor" />
</template>

<style scoped>
/* Fills the box the data view sizes with its resize handle. */
.script-editor {
  height: 100%;
}
</style>
