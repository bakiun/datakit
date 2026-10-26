<script setup lang="ts">
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { sql } from '@codemirror/lang-sql';
import { bracketMatching, syntaxHighlighting } from '@codemirror/language';
import { Compartment, EditorSelection, EditorState } from '@codemirror/state';
import { drawSelection, EditorView, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers, placeholder } from '@codemirror/view';
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { SqlDialect } from '@datakit/core';
import { codeHighlight as highlight, codeTheme as theme } from '../components/codeTheme';
import { GRAMMARS } from './scriptClauses';

/** The SQL script editor (CodeMirror) with MySQL, MariaDB or PostgreSQL highlighting and completion. Ctrl/Cmd+Enter runs. */
const props = defineProps<{ dialect: SqlDialect; schema: Record<string, string[]>; defaultTable: string }>();
const model = defineModel<string>({ required: true });
const emit = defineEmits<{ run: [] }>();

const host = ref<HTMLElement>();
let view: EditorView | undefined;
/** The SQL language settings; replaced when the dialect or the known tables change, e.g. in another database. */
const language = new Compartment();
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
        placeholder('Write SQL here — Ctrl+Enter runs it, or the selection'),
        EditorView.cspNonce.of(document.body.dataset.nonce ?? ''),
        EditorView.contentAttributes.of({ 'aria-label': 'SQL script' }),
        keymap.of([
          { key: 'Mod-Enter', run: () => (emit('run'), true) },
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...historyKeymap,
          ...completionKeymap,
          indentWithTab,
        ]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) model.value = update.state.doc.toString();
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
  /** Where the cursor is. */
  cursor(): number {
    return view?.state.selection.main.head ?? 0;
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
