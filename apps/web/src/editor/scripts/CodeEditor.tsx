"use client";

import * as React from "react";
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap, acceptCompletion, completionStatus } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { javascript } from "@codemirror/lang-javascript";
import { bracketMatching, indentOnInput, syntaxHighlighting, syntaxTree } from "@codemirror/language";
import { forceLinting, linter, lintGutter, type Diagnostic } from "@codemirror/lint";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { EditorState, Prec } from "@codemirror/state";
import { drawSelection, EditorView, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers, placeholder as placeholderExt } from "@codemirror/view";
import { acCompletions, acHover, type CompletionDeps } from "./completions";
import { codeHighlightStyle } from "./code-tokens";

/**
 * THE SCRIPT EDITOR — CodeMirror 6, in its own lazy chunk.
 *
 * CodeMirror rather than Monaco: a fraction of the weight, real touch
 * selection on iPad, and every piece (completion, lint, hover) is a plain
 * extension fed by our own registry instead of a TypeScript service we would
 * have to keep a `.d.ts` in sync with. The expression field stays hand-built —
 * a one-line grammar of our own doesn't need this; a JavaScript file does.
 *
 * One component, two shapes: `file` (gutter, multi-line, ⌘↵ runs) and
 * `prompt` (one growing line, ↵ runs, ↑↓ walk history — the console prompt).
 */

export interface CodeEditorProps {
  value: string;
  onChange: (value: string) => void;
  mode: "file" | "prompt";
  deps: CompletionDeps;
  /** ⌘↵ in a file; ↵ in the prompt. */
  onRun?: () => void;
  /** ⇧⌘↵ — run without replacing. */
  onRunAlt?: () => void;
  /** The last run's failure, pinned to its line until the next edit. */
  error?: { line: number; message: string } | null;
  history?: readonly string[];
  /** Move the caret to a line (a new `n` re-jumps to the same line). */
  jumpTo?: { line: number; n: number } | null;
  placeholder?: string;
  autoFocus?: boolean;
  className?: string;
}

const theme = EditorView.theme({
  "&": { height: "100%", fontSize: "12.5px", backgroundColor: "transparent", color: "var(--code-foreground, var(--foreground))" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)", lineHeight: "1.6" },
  ".cm-content": { caretColor: "var(--foreground)", padding: "8px 0" },
  ".cm-gutters": { backgroundColor: "transparent", border: "none", color: "var(--fg-faint)" },
  ".cm-activeLine": { backgroundColor: "color-mix(in oklab, var(--foreground) 4%, transparent)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--foreground)" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection": { backgroundColor: "color-mix(in oklab, var(--primary) 30%, transparent) !important" },
  ".cm-cursor": { borderLeftColor: "var(--foreground)" },
  ".cm-matchingBracket": { backgroundColor: "color-mix(in oklab, var(--foreground) 12%, transparent)", outline: "none" },
  ".cm-tooltip": { backgroundColor: "var(--popover)", color: "var(--popover-foreground)", border: "1px solid var(--border)", borderRadius: "var(--r-md)", boxShadow: "var(--elevation-3)", overflow: "hidden" },
  ".cm-tooltip-autocomplete > ul": { fontFamily: "inherit", maxHeight: "16rem" },
  ".cm-tooltip-autocomplete > ul > li": { padding: "3px 8px", lineHeight: "1.5", borderRadius: "var(--r-xs)" },
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": { backgroundColor: "var(--hover)", color: "var(--foreground)" },
  ".cm-completionDetail": { opacity: "0.6", fontStyle: "normal", marginLeft: "8px" },
  ".cm-completionInfo": { padding: "8px 10px", maxWidth: "26rem" },
  ".cm-ac-info": { padding: "8px 10px", maxWidth: "28rem", fontSize: "12px" },
  ".cm-ac-info p": { margin: "0 0 6px", color: "var(--foreground)" },
  ".cm-ac-info pre": { margin: "0", whiteSpace: "pre-wrap", fontSize: "11.5px", color: "var(--muted-foreground)", maxHeight: "18rem", overflow: "auto" },
  ".cm-diagnostic": { padding: "4px 8px" },
  ".cm-lintRange-error": { backgroundImage: "none", textDecoration: "underline wavy var(--destructive)", textUnderlineOffset: "3px" },
  ".cm-placeholder": { color: "var(--muted-foreground)" },
  // Touch: a finger needs room on a line and in a completion list.
  "@media (pointer: coarse)": {
    ".cm-scroller": { lineHeight: "1.85" },
    ".cm-tooltip-autocomplete > ul > li": { padding: "8px 10px" },
  },
});

/** Syntax errors as you type, from the parse the highlighter already did. */
function syntaxDiagnostics(view: EditorView): Diagnostic[] {
  const out: Diagnostic[] = [];
  syntaxTree(view.state).iterate({
    enter(node) {
      if (!node.type.isError || out.length >= 3) return;
      const from = node.from;
      out.push({ from, to: Math.min(node.to === from ? from + 1 : node.to, view.state.doc.length), severity: "error", message: "Syntax error" });
    },
  });
  return out;
}

export default function CodeEditor(props: CodeEditorProps) {
  const host = React.useRef<HTMLDivElement>(null);
  const view = React.useRef<EditorView | null>(null);
  // The latest props, read by extensions built once.
  const live = React.useRef(props);
  live.current = props;
  const walk = React.useRef(-1);

  React.useEffect(() => {
    const prompt = props.mode === "prompt";
    const runKeys = keymap.of([
      { key: "Mod-Enter", run: () => (live.current.onRun?.(), true) },
      { key: "Shift-Mod-Enter", run: () => (live.current.onRunAlt?.(), true) },
      ...(prompt
        ? [
            {
              key: "Enter",
              run: (v: EditorView) => {
                if (completionStatus(v.state) === "active") return acceptCompletion(v);
                live.current.onRun?.();
                walk.current = -1;
                return true;
              },
            },
            { key: "ArrowUp", run: (v: EditorView) => stepHistory(v, -1) },
            { key: "ArrowDown", run: (v: EditorView) => stepHistory(v, 1) },
          ]
        : []),
    ]);
    const stepHistory = (v: EditorView, dir: number) => {
      const h = live.current.history ?? [];
      if (!h.length || completionStatus(v.state) === "active") return false;
      // Only walk history from the first/last line, like every shell.
      const line = v.state.doc.lineAt(v.state.selection.main.head).number;
      if ((dir < 0 && line !== 1) || (dir > 0 && line !== v.state.doc.lines)) return false;
      const next = walk.current === -1 ? (dir < 0 ? h.length - 1 : -1) : walk.current + dir;
      if (next < 0 || next >= h.length) {
        if (dir > 0) {
          walk.current = -1;
          v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: "" } });
        }
        return true;
      }
      walk.current = next;
      const text = h[next]!;
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text }, selection: { anchor: text.length } });
      return true;
    };

    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: props.value,
        extensions: [
          Prec.highest(runKeys),
          prompt ? [] : [lineNumbers(), highlightActiveLineGutter(), highlightActiveLine(), lintGutter()],
          history(),
          drawSelection(),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          highlightSelectionMatches(),
          javascript(),
          syntaxHighlighting(codeHighlightStyle),
          autocompletion({ override: [acCompletions(live.current.deps)], icons: false, activateOnTyping: true }),
          acHover(live.current.deps),
          linter(
            (ev) => {
              const out = syntaxDiagnostics(ev);
              const err = live.current.error;
              if (err && err.line <= ev.state.doc.lines) {
                const line = ev.state.doc.line(err.line);
                out.push({ from: line.from, to: Math.max(line.to, line.from + 1), severity: "error", message: err.message });
              }
              return out;
            },
            { delay: 250 },
          ),
          keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...completionKeymap, indentWithTab]),
          props.placeholder ? placeholderExt(props.placeholder) : [],
          EditorView.lineWrapping,
          theme,
          EditorView.updateListener.of((u) => {
            if (u.docChanged) live.current.onChange(u.state.doc.toString());
          }),
          EditorView.contentAttributes.of({ "aria-label": prompt ? "Console" : "Script", autocapitalize: "off", autocorrect: "off", spellcheck: "false" }),
        ],
      }),
    });
    view.current = v;
    if (props.autoFocus) v.focus();
    return () => {
      v.destroy();
      view.current = null;
    };
    // Built once per mode; everything else is read through `live`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.mode]);

  // A change that did not come from typing — undo on the canvas, an agent's
  // `script.save`, switching files — replaces the text.
  React.useEffect(() => {
    const v = view.current;
    if (!v || v.state.doc.toString() === props.value) return;
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: props.value } });
  }, [props.value]);

  React.useEffect(() => {
    if (view.current) forceLinting(view.current);
  }, [props.error]);

  React.useEffect(() => {
    const v = view.current;
    if (!v || !props.jumpTo) return;
    const line = v.state.doc.line(Math.min(Math.max(1, props.jumpTo.line), v.state.doc.lines));
    v.dispatch({ selection: { anchor: line.from }, effects: EditorView.scrollIntoView(line.from, { y: "center" }) });
    v.focus();
  }, [props.jumpTo]);

  return <div ref={host} className={props.className} />;
}
