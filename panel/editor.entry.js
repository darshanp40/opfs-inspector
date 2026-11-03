// The code editor. Loaded only when a text file opens.
import { basicSetup, EditorView } from 'codemirror';
import { EditorState } from '@codemirror/state';
import { syntaxHighlighting } from '@codemirror/language';
import { classHighlighter } from '@lezer/highlight';
import { json } from '@codemirror/lang-json';
import { javascript } from '@codemirror/lang-javascript';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { markdown } from '@codemirror/lang-markdown';
import { sql } from '@codemirror/lang-sql';

// By file extension. Anything else is plain text.
const LANGUAGES = {
  json: () => json(),
  js: () => javascript(), mjs: () => javascript(), cjs: () => javascript(),
  jsx: () => javascript({ jsx: true }),
  ts: () => javascript({ typescript: true }),
  tsx: () => javascript({ jsx: true, typescript: true }),
  html: () => html(), htm: () => html(),
  css: () => css(),
  md: () => markdown(), markdown: () => markdown(),
  sql: () => sql(),
};

// Colours come from panel.css, so the editor follows the panel theme.
const theme = (dark) => EditorView.theme({
  '&': { color: 'var(--fg)', backgroundColor: 'var(--bg)', border: '1px solid var(--line)', borderRadius: '8px' },
  '&.cm-focused': { outline: '2px solid var(--accent)', outlineOffset: '-1px' },
  '.cm-scroller': { fontFamily: 'ui-monospace, Menlo, Consolas, monospace', lineHeight: '1.5' },
  '.cm-content': { caretColor: 'var(--fg)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--fg)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground': { backgroundColor: 'var(--accent-soft)' },
  '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'var(--surface-2)' },
  '.cm-gutters': { backgroundColor: 'var(--surface)', color: 'var(--muted)', borderRight: '1px solid var(--line)' },
}, { dark });

// language: the file extension. onChange(text) runs after each edit.
export function createEditor(parent, { text, language, fontSize, dark, label, readOnly, onChange }) {
  const lang = LANGUAGES[language];
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: text,
      extensions: [
        basicSetup,
        syntaxHighlighting(classHighlighter),
        theme(dark),
        lang ? lang() : [],
        EditorState.readOnly.of(!!readOnly),
        EditorView.contentAttributes.of({ 'aria-label': label }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && onChange) onChange(update.state.doc.toString());
        }),
      ],
    }),
  });
  const setFontSize = (px) => {
    view.dom.style.fontSize = `${px}px`;
    view.requestMeasure();
  };
  setFontSize(fontSize);
  return {
    getText: () => view.state.doc.toString(),
    setText: (t) => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: t } }),
    focus: () => view.focus(),
    setFontSize,
    destroy: () => view.destroy(),
  };
}
