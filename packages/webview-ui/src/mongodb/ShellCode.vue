<script setup lang="ts">
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { bracketMatching, indentUnit, syntaxHighlighting } from '@codemirror/language';
import { Compartment, EditorSelection, EditorState } from '@codemirror/state';
import { drawSelection, EditorView, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers, placeholder } from '@codemirror/view';
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { codeHighlight, codeTheme } from '../components/codeTheme';
import { shellLanguageSupport } from './shellSyntax';

/**
 * A CodeMirror editor for shell syntax (documents, filters, pipelines): highlighting, bracket matching and
 * indentation. Ctrl/Cmd+Enter emits `run`. `compact` leaves out line numbers, for small fields in forms.
 */
const props = withDefaults(defineProps<{ label: string; readOnly?: boolean; placeholder?: string; compact?: boolean; autofocus?: boolean }>(), {
  readOnly: false,
  placeholder: '',
  compact: false,
  autofocus: false,
});
const model = defineModel<string>({ required: true });
const emit = defineEmits<{ run: [] }>();

const host = ref<HTMLElement>();
let view: EditorView | undefined;
const mode = new Compartment();
const modeExtensions = () => [EditorState.readOnly.of(props.readOnly), EditorView.editable.of(!props.readOnly), props.readOnly ? [] : highlightActiveLine()];

onMounted(() => {
  view = new EditorView({
    parent: host.value!,
    state: EditorState.create({
      doc: model.value,
      extensions: [
        props.compact ? [] : [lineNumbers(), highlightActiveLineGutter()],
        history(),
        drawSelection(),
        bracketMatching(),
        closeBrackets(),
        indentUnit.of('  '),
        EditorView.lineWrapping,
        shellLanguageSupport,
        syntaxHighlighting(codeHighlight),
        codeTheme,
        props.placeholder ? placeholder(props.placeholder) : [],
        EditorView.cspNonce.of(document.body.dataset.nonce ?? ''),
        EditorView.contentAttributes.of({ 'aria-label': props.label }),
        keymap.of([{ key: 'Mod-Enter', run: () => (emit('run'), true) }, ...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap]),
        mode.of(modeExtensions()),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) model.value = update.state.doc.toString();
        }),
      ],
    }),
  });
  if (props.autofocus) focus();
});

watch(model, (text) => {
  if (view && text !== view.state.doc.toString()) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
});
watch(
  () => props.readOnly,
  () => view?.dispatch({ effects: mode.reconfigure(modeExtensions()) }),
);
onBeforeUnmount(() => view?.destroy());

/** Focuses the editor; `at` puts the cursor there (the end of the text when it is past it). */
function focus(at?: number): void {
  if (!view) return;
  if (at !== undefined) view.dispatch({ selection: EditorSelection.cursor(Math.min(at, view.state.doc.length)), scrollIntoView: true });
  view.focus();
}

defineExpose({ focus });
</script>

<template>
  <div ref="host" class="shell-code" :class="{ compact }" />
</template>

<style scoped>
.shell-code {
  height: 100%;
  min-height: 0;
}
.compact :deep(.cm-content) {
  padding: 4px 2px;
}
</style>
