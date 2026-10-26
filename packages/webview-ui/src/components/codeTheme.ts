import { HighlightStyle } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import { tags } from '@lezer/highlight';

/** CodeMirror colors and chrome shared by the SQL editor and the value views. */
// Colors come from the VS Code theme, like the rest of the UI.
export const codeHighlight = HighlightStyle.define([
  { tag: tags.keyword, color: 'var(--vscode-charts-blue)' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--vscode-debugTokenExpression-string)' },
  { tag: tags.number, color: 'var(--vscode-debugTokenExpression-number)' },
  { tag: [tags.bool, tags.null], color: 'var(--vscode-debugTokenExpression-boolean)' },
  { tag: [tags.typeName, tags.standard(tags.name)], color: 'var(--vscode-symbolIcon-typeParameterForeground)' },
  { tag: [tags.lineComment, tags.blockComment], color: 'var(--vscode-descriptionForeground)', fontStyle: 'italic' },
  { tag: [tags.special(tags.name), tags.propertyName], color: 'var(--vscode-symbolIcon-variableForeground)' },
]);

export const codeTheme = EditorView.theme({
  '&': { height: '100%', color: 'var(--vscode-editor-foreground)', backgroundColor: 'var(--vscode-editor-background)', fontSize: '13px' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--vscode-editor-font-family)', lineHeight: '20px', overflow: 'auto' },
  '.cm-content': { padding: '6px 0', caretColor: 'var(--vscode-editorCursor-foreground)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--vscode-editorCursor-foreground)' },
  '.cm-gutters': { backgroundColor: 'var(--vscode-editor-background)', color: 'var(--vscode-editorLineNumber-foreground)', border: 'none' },
  '.cm-lineNumbers .cm-gutterElement': { minWidth: '28px', padding: '0 16px 0 0' },
  '.cm-activeLine': { backgroundColor: 'var(--vscode-editor-lineHighlightBackground)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--vscode-editorLineNumber-activeForeground)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground': {
    backgroundColor: 'var(--vscode-editor-selectionBackground)',
  },
  '.cm-matchingBracket': { backgroundColor: 'var(--vscode-editorBracketMatch-background)', outline: '1px solid var(--vscode-editorBracketMatch-border)' },
  '.cm-placeholder': { color: 'var(--vscode-input-placeholderForeground)' },
  '.cm-tooltip': {
    backgroundColor: 'var(--vscode-editorSuggestWidget-background)',
    color: 'var(--vscode-editorSuggestWidget-foreground)',
    border: '1px solid var(--vscode-editorSuggestWidget-border)',
  },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    backgroundColor: 'var(--vscode-editorSuggestWidget-selectedBackground)',
    color: 'var(--vscode-editorSuggestWidget-selectedForeground)',
  },
});
