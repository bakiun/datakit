import { javascriptLanguage } from '@codemirror/lang-javascript';
import { LanguageSupport } from '@codemirror/language';
import type { SyntaxNode } from '@lezer/common';
import { classHighlighter, highlightCode } from '@lezer/highlight';

/**
 * Shell syntax (documents, filters, pipelines) is one JavaScript expression, so CodeMirror's JavaScript grammar reads
 * it; with the default top rule a document would parse as a block of labels. The adapter's parser still validates.
 */
const shellLanguage = javascriptLanguage.configure({ top: 'SingleExpression' });

/** Highlighting, indentation and bracket handling of shell syntax in the code editor. */
export const shellLanguageSupport = new LanguageSupport(shellLanguage);

export interface ShellSpan {
  text: string;
  /** `tok-*` classes from @lezer/highlight's classHighlighter; empty for plain text. */
  className: string;
}

/** Spans for rendering shell syntax without an editor, e.g. on document cards; plain text runs together. */
export function highlightShell(text: string): ShellSpan[] {
  const spans: ShellSpan[] = [];
  const put = (part: string, classes: string) => {
    // Operators such as $match are keys too; they get their own color.
    let className = classes.includes('tok-propertyName') && part.startsWith('$') ? 'tok-mongoOperator' : classes;
    if (className === 'tok-punctuation') className = '';
    const last = spans.at(-1);
    if (last && !last.className && !className) last.text += part;
    else spans.push({ text: part, className });
  };
  highlightCode(text, shellLanguage.parser.parse(text), classHighlighter, put, () => put('\n', ''));
  return spans;
}

/** The expression of the text when it is a node of the given type, e.g. the object of a document. */
function topLevel(text: string, type: 'ObjectExpression' | 'ArrayExpression'): SyntaxNode | null {
  let node = shellLanguage.parser.parse(text).topNode.firstChild;
  while (node && /Comment$/.test(node.name)) node = node.nextSibling;
  return node?.name === type ? node : null;
}

/**
 * The document text without its top-level `_id` field, e.g. to insert a copy. Text without a top-level `_id` is
 * returned as it is.
 */
export function withoutId(text: string): string {
  const object = topLevel(text, 'ObjectExpression');
  for (let property = object?.firstChild ?? null; property; property = property.nextSibling) {
    const key = property.name === 'Property' ? property.firstChild : null;
    if (!key || text.slice(key.from, key.to).replace(/^(["'])(.*)\1$/, '$2') !== '_id') continue;
    const lineStart = text.lastIndexOf('\n', property.from - 1) + 1;
    const ownLine = /^[ \t]*$/.test(text.slice(lineStart, property.from));
    const from = ownLine ? lineStart : property.from;
    const stop = property.nextSibling;
    if (stop?.name === ',') {
      const rest = text.slice(stop.to);
      const gap = ownLine ? (/^[ \t]*\r?\n/.exec(rest)?.[0] ?? '') : (/^[ \t]*/.exec(rest)?.[0] ?? '');
      return text.slice(0, from) + text.slice(stop.to + gap.length);
    }
    // `_id` was the last field: the comma before it goes too.
    const before = text.slice(0, from);
    const comma = /,\s*$/.exec(before);
    const head = comma ? before.slice(0, comma.index) + (ownLine ? '\n' : ' ') : before;
    const tail = text.slice(stop ? stop.from : text.length);
    return ownLine ? head + tail : `${head.trimEnd()} ${tail}`;
  }
  return text;
}

/** Adds a stage at the end of a pipeline (an array in shell syntax), on its own line. */
export function insertStage(pipeline: string, stage: string): string {
  if (!pipeline.trim()) return `[\n  ${stage}\n]`;
  const close = topLevel(pipeline, 'ArrayExpression')?.lastChild;
  // An unclosed array gets an empty ']' from the parser's error recovery.
  if (!close || close.name !== ']' || close.to === close.from) return pipeline;
  const head = pipeline.slice(0, close.from).replace(/\s+$/, '');
  const tail = pipeline.slice(close.from);
  if (head.endsWith('[') || head.endsWith(',')) return `${head}\n  ${stage}\n${tail}`;
  return `${head},\n  ${stage}\n${tail}`;
}

/**
 * The top-level fields a filter tests, without operators such as `$or`: `status` and `customer.tier` of
 * `{ status: "paid", "customer.tier": "gold" }`. Explain offers an index on them.
 */
export function filterFields(filter: string): string[] {
  const object = topLevel(filter, 'ObjectExpression');
  const fields: string[] = [];
  for (let property = object?.firstChild ?? null; property; property = property.nextSibling) {
    const key = property.name === 'Property' ? property.firstChild : null;
    if (!key || (key.name !== 'PropertyDefinition' && key.name !== 'String')) continue;
    const name = filter.slice(key.from, key.to).replace(/^(["'])(.*)\1$/, '$2');
    if (name && !name.startsWith('$') && !fields.includes(name)) fields.push(name);
  }
  return fields;
}

/** An ascending index key pattern on the fields, e.g. `{ status: 1, "customer.tier": 1 }`. */
export function indexKeys(fields: readonly string[]): string {
  return `{ ${fields.map((f) => `${/^[A-Za-z_$][\w$]*$/.test(f) ? f : JSON.stringify(f)}: 1`).join(', ')} }`;
}
