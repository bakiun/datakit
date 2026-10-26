<script setup lang="ts">
import { history, defaultKeymap, historyKeymap } from '@codemirror/commands';
import { json } from '@codemirror/lang-json';
import { bracketMatching, foldGutter, syntaxHighlighting } from '@codemirror/language';
import { Compartment, EditorState } from '@codemirror/state';
import { drawSelection, EditorView, keymap, lineNumbers } from '@codemirror/view';
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { codeHighlight, codeTheme } from './codeTheme';

/** A CodeMirror view for values: JSON with highlighting and folding, or plain text; editable unless `readOnly`. */
const props = withDefaults(defineProps<{ language?: 'json' | 'text'; readOnly?: boolean; label: string }>(), { language: 'text', readOnly: false });
const model = defineModel<string>({ required: true });

const host = ref<HTMLElement>();
let view: EditorView | undefined;
const mode = new Compartment();
const extensionsFor = () => [
  props.language === 'json' ? [json(), foldGutter()] : [],
  EditorState.readOnly.of(props.readOnly),
  EditorView.editable.of(!props.readOnly),
];

onMounted(() => {
  view = new EditorView({
    parent: host.value!,
    state: EditorState.create({
      doc: model.value,
      extensions: [
        lineNumbers(),
        history(),
        drawSelection(),
        bracketMatching(),
        EditorView.lineWrapping,
        syntaxHighlighting(codeHighlight),
        codeTheme,
        EditorView.cspNonce.of(document.body.dataset.nonce ?? ''),
        EditorView.contentAttributes.of({ 'aria-label': props.label }),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        mode.of(extensionsFor()),
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
  () => [props.language, props.readOnly],
  () => view?.dispatch({ effects: mode.reconfigure(extensionsFor()) }),
);
onBeforeUnmount(() => view?.destroy());
</script>

<template>
  <div ref="host" class="code-view" />
</template>

<style scoped>
.code-view {
  height: 100%;
  min-height: 0;
}
</style>
