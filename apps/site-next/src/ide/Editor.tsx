import { useEffect, useRef } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, indentOnInput, syntaxHighlighting, HighlightStyle } from "@codemirror/language";
import { rust } from "@codemirror/lang-rust";
import { tags as t } from "@lezer/highlight";

/** Syntax colours from the brand tokens (the site is dark-only). */
const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.modifier, t.definitionKeyword], color: "var(--magenta)" },
  { tag: [t.string, t.special(t.string), t.character], color: "var(--live)" },
  { tag: [t.number, t.bool, t.null], color: "var(--warning)" },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: "var(--muted)", fontStyle: "italic" },
  { tag: [t.function(t.variableName), t.function(t.definition(t.variableName))], color: "var(--violet)" },
  { tag: [t.typeName, t.className, t.namespace], color: "#f0a3c8" },
  { tag: [t.macroName, t.attributeName, t.meta], color: "var(--red)" },
]);

const theme = EditorView.theme(
  {
    "&": { height: "100%", backgroundColor: "transparent", color: "var(--ink)" },
    ".cm-scroller": { fontFamily: "var(--mono)", lineHeight: "1.6" },
    ".cm-content": { caretColor: "var(--ink)", padding: "12px 0" },
    ".cm-gutters": { backgroundColor: "transparent", color: "color-mix(in srgb, var(--muted) 60%, transparent)", border: "none" },
    ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "color-mix(in srgb, var(--violet) 7%, transparent)" },
    "&.cm-focused": { outline: "none" },
    "&.cm-focused .cm-cursor": { borderLeftColor: "var(--ink)" },
    ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection": {
      backgroundColor: "color-mix(in srgb, var(--violet) 32%, transparent) !important",
    },
  },
  { dark: true },
);

/** A CodeMirror 6 editor. `docKey` changes reset the content (switching files); edits report back. */
export function Editor({ docKey, value, language, onChange, label }: {
  docKey: string;
  value: string;
  language: "rust" | "text";
  onChange: (value: string) => void;
  label: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!host.current) return;
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightActiveLine(),
          drawSelection(),
          history(),
          indentOnInput(),
          bracketMatching(),
          keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap]),
          ...(language === "rust" ? [rust()] : [EditorView.lineWrapping]),
          syntaxHighlighting(highlight),
          theme,
          EditorView.contentAttributes.of({ "aria-label": label }),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) onChangeRef.current(u.state.doc.toString());
          }),
        ],
      }),
    });
    return () => view.destroy();
    // Recreated per file; `value` is the initial content of that file.
  }, [docKey, language]);

  return <div className="ide-editor" ref={host} />;
}
