"use client";

import * as React from "react";
import {
  arity,
  checkProgram,
  exprMembersOf,
  layerReference,
  propertyReadSource,
  trackReadingSource,
  trackReference,
  resolveRef,
  evaluateProgram,
  exprTypeForVariable,
  FUNCTIONS,
  GLOBAL_CATEGORY_META,
  GLOBALS,
  GLOBALS_BY_NAME,
  layerPropertyIndex,
  parseExpression,
  signatureOf,
  tokenize,
  variablesByName,
  type CheckResult,
  type Diagnostic,
  type ExprContext,
  type ExprLayerApi,
  type ExprTrackApi,
  type ExprLayerProperty,
  type ExprType,
  type ExprValue,
  type Program,
  type RefScope,
  type Token,
  type PickCandidate,
} from "@solomotion/core";
import { AlertTriangle, CircleX, CornerDownLeft } from "lucide-react";
import { cn } from "@/lib/utils";
import { ScrollArea } from "@/components/ui/scroll-area";
import { AimButton } from "../pick/ObjectField";
import { beginPickDrag, enterPick, exitPick, usePickMode, type PickRequest } from "../pick/pick-mode";
import { useDoc } from "../state/document-context";
import { makeEditorScope } from "./expression-context";
import {
  EDITOR_PADDING,
  EDITOR_TEXT,
  isCallToken,
  paintKindFor,
  PAINT_CLASS,
  squiggleSpans,
  TYPE_CHIP,
} from "./expression-theme";

/**
 * THE EXPRESSION EDITOR — a real one, in the width of an inspector row.
 *
 * Deliberately hand-built rather than CodeMirror/Monaco: the grammar is ours,
 * the lexer already hands back spans, and a one-line field does not deserve
 * hundreds of kilobytes of editor framework. What it costs is this file; what it
 * buys is that highlighting, linting and autocomplete all read the SAME parse
 * the renderer will run, so the editor can never colour something green that the
 * document then refuses.
 *
 * Two layers, one set of metrics: a transparent `<textarea>` for editing (so
 * selection, undo, IME and every OS text affordance keep working) over a `<pre>`
 * painted from the token spans. `EDITOR_TEXT` is shared between them because a
 * single character of metric drift puts the caret beside the letter it is
 * supposed to be inside.
 */

// ── Analysis ─────────────────────────────────────────────────────────────────

export interface ExpressionAnalysis {
  /** Immediate — painting must never lag a keystroke. */
  tokens: Token[];
  /** Debounced — linting a half-typed word is noise, not help. */
  program: Program;
  check: CheckResult;
  refScope: RefScope;
  /** The document's variables, typed — feeds autocomplete from the same list
   *  the checker and the colouring read. */
  variables: Array<{ id: string; name: string; type: ExprType }>;
  /** The value at the playhead, when the expression can run. */
  preview: { value: ExprValue; type: ExprType } | null;
  errors: Diagnostic[];
  /** The source the lint describes — differs from what's typed mid-debounce. */
  settled: string;
  /** Every value the layer in scope exposes — the SAME projection its node card
   *  builds sockets from. Feeds the suggestions and the checker alike. */
  layerProperties?: Map<string, ExprLayerProperty>;
  /** The other layers in this composition, and what each of them exposes —
   *  the same API `layer("Name").x` reads through, so completing a cross-layer
   *  read and evaluating one cannot disagree about what exists. */
  layers?: ExprLayerApi;
  /** The trackers this expression can read — `track("Face").` completes from it. */
  tracks?: ExprTrackApi;
  /** The comp this expression runs in and the layer it is on — what a pick
   *  is scoped to, and what `#layer` means. */
  compId: string | null;
  selfId: string | null;
}

const LINT_DELAY_MS = 250;

/** Room for the aim button on BOTH layers — the mirror and the textarea must
 *  wrap at the same column or the caret drifts off its letter. */
const AIM_GUTTER = "pr-7";

export function useExpressionAnalysis(
  source: string,
  opts: {
    /** The field's type; null when nothing constrains the result. */
    expect: ExprType | null;
    ctx: ExprContext;
    /** A stable key for this binding — seeds random()/wiggle() in the preview. */
    seedKey: string;
    available?: { layer?: boolean; comp?: boolean };
  },
): ExpressionAnalysis {
  const doc = useDoc();
  const { expect, ctx, seedKey, available } = opts;

  // Tokens track every keystroke; the checker waits for a pause.
  const tokens = React.useMemo(() => tokenize(source), [source]);
  const [settled, setSettled] = React.useState(source);
  React.useEffect(() => {
    const timer = setTimeout(() => setSettled(source), LINT_DELAY_MS);
    return () => clearTimeout(timer);
  }, [source]);

  const variables = React.useMemo(
    () =>
      doc.variables.flatMap((v) => {
        const type = exprTypeForVariable(v.type);
        return type ? [{ id: v.id, name: v.name, type }] : [];
      }),
    [doc.variables],
  );

  return React.useMemo(() => {
    // The layer surface, from the SAME projection a Layer node's sockets come
    // from — so what the editor suggests, what the checker accepts and what a
    // wire exposes are one list, not three that drift.
    const layerProperties = ctx.layer?.id
      ? layerPropertyIndex(ctx.layers?.propertiesOf(ctx.layer.id) ?? [])
      : undefined;
    const layerPropertiesByName = (name: string) => {
      const id = ctx.layers?.idFor(name);
      return id ? layerPropertyIndex(ctx.layers!.propertiesOf(id)) : undefined;
    };
    // A tracker's readings, typed — `track("Face").topLeft` is checked, not
    // merely permitted, from the same table its Track node's outputs are.
    const trackReadingsByName = (name: string) => {
      const id = ctx.tracks?.idFor(name);
      return id ? new Map(ctx.tracks!.readingsOf(id).map((r) => [r.id, r.type] as const)) : undefined;
    };
    const program = parseExpression(settled);
    const check = checkProgram(program, {
      variables,
      expect,
      available,
      layerProperties,
      layerPropertiesByName,
      trackReadingsByName,
    });

    const byName = variablesByName(doc.variables);
    const refScope: RefScope = {
      locals: new Map(check.locals.map((l) => [l.name, l.type])),
      lookupVariable: (name) => {
        const v = byName.get(name.trim().toLowerCase());
        if (!v) return undefined;
        const type = exprTypeForVariable(v.type);
        // A paint has no expression type — naming one reads as an unknown
        // variable, which is exactly what it is from inside an expression.
        return type ? { id: v.id, name: v.name, type } : undefined;
      },
      layerProperties,
    };

    const errors = check.diagnostics.filter((d) => d.severity === "error");
    const preview =
      errors.length === 0
        ? (evaluateProgram(program, makeEditorScope(doc.variables, ctx, seedKey)) ?? null)
        : null;

    return {
      tokens,
      program,
      check,
      refScope,
      variables,
      preview,
      errors,
      settled,
      layerProperties,
      layers: ctx.layers,
      tracks: ctx.tracks,
      compId: ctx.compId ?? null,
      selfId: ctx.layer?.id ?? null,
    };
  }, [settled, tokens, variables, expect, available, ctx, seedKey, doc.variables]);
}

/** A value as the preview chip shows it — short, and honest about its type. */
export function previewText(preview: { value: ExprValue; type: ExprType } | null): string | null {
  if (!preview) return null;
  const { value } = preview;
  if (typeof value === "number") return String(Math.round(value * 1000) / 1000);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "object") return `${round(value.x)}, ${round(value.y)}`;
  return value;
}

const round = (v: number) => Math.round(v * 100) / 100;

// ── The editor ───────────────────────────────────────────────────────────────

export function ExpressionEditor({
  source,
  onChange,
  analysis,
  autoFocus,
  rows = 3,
  onSubmit,
  className,
}: {
  source: string;
  onChange: (next: string) => void;
  analysis: ExpressionAnalysis;
  autoFocus?: boolean;
  rows?: number;
  /** ⌘/Ctrl+Enter — the "I'm done" gesture. Plain Enter inserts a newline. */
  onSubmit?: () => void;
  className?: string;
}) {
  const textarea = React.useRef<HTMLTextAreaElement>(null);
  const [caret, setCaret] = React.useState(0);
  const [dismissed, setDismissed] = React.useState(false);
  const [focused, setFocused] = React.useState(false);
  const [active, setActive] = React.useState(0);

  const query = React.useMemo(() => completionQuery(source, caret), [source, caret]);
  const suggestions = React.useMemo(
    () => (query ? suggestionsFor(query, analysis) : []),
    [query, analysis],
  );
  const open = focused && !dismissed && suggestions.length > 0;

  React.useEffect(() => setActive(0), [query?.word, query?.kind]);

  const accept = (index: number) => {
    const choice = suggestions[index];
    if (!choice || !query) return;
    const before = source.slice(0, query.start);
    const after = source.slice(caret);
    const next = before + choice.insert + after;
    const position = before.length + choice.caretOffset;
    onChange(next);
    setDismissed(true);
    requestAnimationFrame(() => {
      const el = textarea.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(position, position);
      setCaret(position);
    });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (open) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive((a) => (a + 1) % suggestions.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive((a) => (a - 1 + suggestions.length) % suggestions.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        accept(active);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setDismissed(true);
        return;
      }
    }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      onSubmit?.();
      return;
    }
    // A bare Escape belongs to whatever is hosting the editor (close the panel),
    // so it is deliberately NOT swallowed once the suggestion list is gone.
    if (e.key === " " && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      setDismissed(false);
    }
  };

  // Has the person put the caret anywhere yet? Until they have, a pick
  // appends — the start of the line is never where you meant.
  const placed = React.useRef(false);
  const syncCaret = () => {
    const el = textarea.current;
    if (!el) return;
    placed.current = true;
    setCaret(el.selectionStart);
  };

  // POINT AT A LAYER (or one of its values) and its reference lands at the
  // caret — the keyed form a pick always writes, so a rename cannot break it.
  const insert = (text: string) => {
    const at = placed.current ? Math.min(caret, source.length) : source.length;
    const next = source.slice(0, at) + text + source.slice(at);
    onChange(next);
    placed.current = true;
    requestAnimationFrame(() => {
      const el = textarea.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(at + text.length, at + text.length);
      setCaret(at + text.length);
    });
  };
  const owner = React.useId();
  const aiming = usePickMode((s) => s.request?.owner === owner);
  const aim = (): PickRequest => ({
    owner,
    filter: { kinds: ["layer", "property", "tracker", "track-reading"], ...(analysis.compId ? { frameId: analysis.compId } : {}) },
    refine: (picked) => {
      if (picked.kind === "layer") return { filter: { kinds: ["property"], ofLayers: [picked.id] }, allowPicked: "The layer itself" };
      const tracker = picked.id;
      if (picked.kind === "tracker") return { filter: { kinds: ["track-reading"], predicate: (c) => c.ownerId === tracker }, allowPicked: "The tracker itself" };
      return null;
    },
    onPick: (c) => insert(referenceSource(c, analysis.selfId)),
  });

  return (
    <div className={cn("flex flex-col", className)}>
      <div className="relative">
        <pre
          aria-hidden
          className={cn(
            "pointer-events-none absolute inset-0 overflow-hidden text-foreground",
            EDITOR_TEXT,
            EDITOR_PADDING,
            AIM_GUTTER,
          )}
        >
          {paintSource(source, analysis)}
        </pre>
        <textarea
          ref={textarea}
          value={source}
          rows={rows}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          // eslint-disable-next-line jsx-a11y/no-autofocus -- the panel exists to type in
          autoFocus={autoFocus}
          aria-label="Expression"
          onChange={(e) => {
            onChange(e.target.value);
            setDismissed(false);
            placed.current = true;
            setCaret(e.target.selectionStart);
          }}
          onKeyDown={onKeyDown}
          onKeyUp={syncCaret}
          onClick={syncCaret}
          onSelect={syncCaret}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false);
            setDismissed(true);
          }}
          style={{ caretColor: "var(--foreground)" }}
          className={cn(
            "relative block w-full resize-none bg-transparent text-transparent outline-none selection:bg-primary/25",
            EDITOR_TEXT,
            EDITOR_PADDING,
            AIM_GUTTER,
          )}
        />
        <AimButton
          armed={aiming}
          small
          label="Pick a layer or value"
          className="absolute right-1 top-1"
          onPress={(e) => (aiming ? exitPick("cancel") : beginPickDrag(e, aim()))}
          onKeyboard={() => (aiming ? exitPick("cancel") : enterPick(aim()))}
        />
        {open && (
          <SuggestionList
            suggestions={suggestions}
            active={active}
            onHover={setActive}
            onPick={accept}
          />
        )}
      </div>
      <DiagnosticsStrip analysis={analysis} onGoTo={(span) => {
        const el = textarea.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(span.start, span.end);
        setCaret(span.end);
      }} />
    </div>
  );
}

/** What a pick inserts: the layer in scope reads as `#layer.<path>` (unless an
 *  intrinsic owns that name); any other layer by its key. */
function referenceSource(c: PickCandidate, selfId: string | null): string {
  if (c.kind === "tracker") return trackReference(c.id);
  if (c.kind === "track-reading" && c.ownerId && c.path) return trackReadingSource(c.ownerId, c.path);
  if (c.kind === "property" && c.ownerId && c.path) {
    const ownName = `layer.${c.path}`;
    if (c.ownerId === selfId && !GLOBALS_BY_NAME.has(ownName) && /^[A-Za-z_][A-Za-z0-9_.]*$/.test(c.path)) return `#${ownName}`;
    return propertyReadSource(c.ownerId, c.path);
  }
  return layerReference(c.id);
}

// ── Painting ─────────────────────────────────────────────────────────────────

function paintSource(source: string, analysis: ExpressionAnalysis): React.ReactNode {
  const { tokens, refScope, errors } = analysis;
  const squiggles = squiggleSpans(errors, source.length);
  const nodes: React.ReactNode[] = [];
  let at = 0;

  tokens.forEach((token, i) => {
    if (token.start > at) nodes.push(source.slice(at, token.start));
    const kind = paintKindFor(token, refScope, isCallToken(tokens, i));
    const squiggled = squiggles.some((d) => d.span.start < token.end && d.span.end > token.start);
    nodes.push(
      <span
        key={`${token.start}-${i}`}
        className={cn(
          PAINT_CLASS[kind],
          squiggled && "underline decoration-destructive decoration-wavy underline-offset-4",
        )}
      >
        {token.text}
      </span>,
    );
    at = token.end;
  });
  if (at < source.length) nodes.push(source.slice(at));
  // A trailing newline keeps the painted block exactly as tall as the textarea
  // when the source itself ends in one.
  nodes.push("\n");
  return nodes;
}

// ── Diagnostics ──────────────────────────────────────────────────────────────

function DiagnosticsStrip({
  analysis,
  onGoTo,
}: {
  analysis: ExpressionAnalysis;
  onGoTo: (span: { start: number; end: number }) => void;
}) {
  const shown = analysis.check.diagnostics.slice(0, 3);
  const preview = previewText(analysis.preview);

  if (shown.length === 0) {
    return (
      <div className="flex h-7 items-center gap-1.5 border-t border-border/60 px-2.5 text-[11px]">
        {preview === null ? (
          <span className="text-muted-foreground/70">Type # for a value, or a letter for a function.</span>
        ) : (
          <>
            <span className="text-muted-foreground/70">now</span>
            <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground" title={preview}>
              {preview}
            </span>
            {analysis.preview && (
              <span className="shrink-0 rounded bg-muted px-1 text-[9px] uppercase tracking-wide text-muted-foreground">
                {TYPE_CHIP[analysis.preview.type]}
              </span>
            )}
          </>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col border-t border-border/60">
      {shown.map((d, i) => (
        <button
          key={i}
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onGoTo(d.span)}
          className={cn(
            "flex items-start gap-1.5 px-2.5 py-1.5 text-left text-[11px] leading-snug transition-colors hover:bg-muted/60",
            d.severity === "error" ? "text-destructive" : "text-amber-400",
          )}
        >
          {d.severity === "error" ? (
            <CircleX className="mt-px size-3 shrink-0" />
          ) : (
            <AlertTriangle className="mt-px size-3 shrink-0" />
          )}
          <span className="min-w-0 flex-1">{d.message}</span>
        </button>
      ))}
    </div>
  );
}

// ── Autocomplete ─────────────────────────────────────────────────────────────

interface Suggestion {
  key: string;
  label: string;
  detail: string;
  describe: string;
  insert: string;
  /** Where the caret lands relative to the start of the replacement. */
  caretOffset: number;
  kind: "global" | "variable" | "local" | "function" | "property";
}

interface Query {
  kind: "ref" | "call" | "layerName" | "layerProperty" | "trackName" | "trackReading";
  word: string;
  /** Where the replacement begins (the `#` for a reference). */
  start: number;
  /** For `layerProperty`: the layer named in the call being completed. */
  layerName?: string;
}

const WORD = /[A-Za-z0-9_.]/;

/** Inside the quotes of `layer("…` — the layer NAME is what comes next. */
const LAYER_NAME_AT_CARET = /layer\(\s*"([^"]*)$/;
/** After `layer("Name").` — that layer's own properties are what comes next. */
const LAYER_PROPERTY_AT_CARET = /layer\(\s*"([^"]*)"\s*\)\.([A-Za-z0-9_.]*)$/;

/** The same two positions inside `track("…")`, for trackers and their readings. */
const TRACK_NAME_AT_CARET = /track\(\s*"([^"]*)$/;
const TRACK_READING_AT_CARET = /track\(\s*"([^"]*)"\s*\)\.([A-Za-z0-9_]*)$/;

/** What the caret is in the middle of typing, if anything completable. */
function completionQuery(source: string, caret: number): Query | null {
  const before = source.slice(0, caret);
  const reading = TRACK_READING_AT_CARET.exec(before);
  if (reading) return { kind: "trackReading", word: reading[2] ?? "", start: caret - (reading[2]?.length ?? 0), layerName: reading[1] };
  const tracker = TRACK_NAME_AT_CARET.exec(before);
  if (tracker) return { kind: "trackName", word: tracker[1] ?? "", start: caret - (tracker[1]?.length ?? 0) };
  // Cross-layer reads are checked FIRST: inside `layer("…")` the ordinary
  // word rules would offer functions and globals, which cannot appear there.
  const prop = LAYER_PROPERTY_AT_CARET.exec(before);
  if (prop) {
    return {
      kind: "layerProperty",
      word: prop[2] ?? "",
      start: caret - (prop[2]?.length ?? 0),
      layerName: prop[1],
    };
  }
  const named = LAYER_NAME_AT_CARET.exec(before);
  if (named) {
    return { kind: "layerName", word: named[1] ?? "", start: caret - (named[1]?.length ?? 0) };
  }
  let i = caret;
  while (i > 0 && WORD.test(source[i - 1] ?? "")) i--;
  const word = source.slice(i, caret);
  if (source[i - 1] === "#") return { kind: "ref", word, start: i - 1 };
  // A bare word is on its way to being a function call. One character is enough
  // to start helping; zero would pop the list open on every click.
  if (word.length >= 1 && !/^[0-9]/.test(word)) return { kind: "call", word, start: i };
  return null;
}

const PAINT_BY_KIND: Record<Suggestion["kind"], string> = {
  global: PAINT_CLASS.global,
  variable: PAINT_CLASS.variable,
  local: PAINT_CLASS.local,
  function: PAINT_CLASS.function,
  // A layer's own property is a built-in fact about the document, like a global.
  property: PAINT_CLASS.global,
};

function suggestionsFor(query: Query, analysis: ExpressionAnalysis): Suggestion[] {
  const term = query.word.toLowerCase();
  const matches = (name: string) => name.toLowerCase().includes(term);
  const out: Suggestion[] = [];

  if (query.kind === "ref") {
    // After a dot on a VALUE (`#offset.`, `#Brand.`): its members, from the
    // checker's own table — so a member offered is a member that checks.
    const dot = query.word.lastIndexOf(".");
    if (dot > 0) {
      const base = query.word.slice(0, dot).split(".");
      const resolved = resolveRef(base, analysis.refScope);
      const members = resolved && resolved.consumed === base.length ? exprMembersOf(resolved.target.type) : [];
      const tail = query.word.slice(dot + 1).toLowerCase();
      for (const m of members) {
        if (!m.startsWith(tail)) continue;
        const written = `#${base.join(".")}.${m}`;
        out.push({
          key: `member:${m}`,
          label: `.${m}`,
          detail: `${TYPE_CHIP[resolved!.target.type]} · number`,
          describe: `The ${m} of ${written.slice(0, written.lastIndexOf("."))}.`,
          insert: written,
          caretOffset: written.length,
          kind: "property",
        });
      }
      if (out.length) return out;
    }
    for (const local of analysis.check.locals) {
      if (!matches(local.name)) continue;
      out.push({
        key: `local:${local.name}`,
        label: `#${local.name}`,
        detail: "defined above",
        describe: "A value you defined earlier in this expression.",
        insert: `#${local.name}`,
        caretOffset: local.name.length + 1,
        kind: "local",
      });
    }
    for (const global of GLOBALS) {
      if (!matches(global.name)) continue;
      out.push({
        key: `global:${global.name}`,
        label: `#${global.name}`,
        detail: GLOBAL_CATEGORY_META[global.category].label,
        describe: global.describe,
        insert: `#${global.name}`,
        caretOffset: global.name.length + 1,
        kind: "global",
      });
    }
    // EVERY value this layer actually has, from the same projection its node
    // card builds sockets from. This is what makes the two surfaces one: what
    // you can wire, you can write, and the list you are shown is generated from
    // the document rather than from a table somebody has to remember to grow.
    for (const [path, prop] of analysis.layerProperties ?? []) {
      const name = `layer.${path}`;
      // The intrinsics win the name (`#layer.height` is the box you can see, not
      // a shape's height field), and they are already listed above — so offering
      // the property under the same name would be two rows that insert the same
      // text and mean one thing.
      if (GLOBALS_BY_NAME.has(name)) continue;
      if (!matches(name) && !matches(prop.label)) continue;
      out.push({
        key: `prop:${path}`,
        label: `#${name}`,
        detail: `${prop.group} · ${TYPE_CHIP[prop.type]}`,
        describe: `This layer’s ${prop.label.toLowerCase()} — the same value its node card shows.`,
        insert: `#${name}`,
        caretOffset: name.length + 1,
        kind: "property",
      });
    }
    // Document variables come from the ref scope so the list and the colouring
    // are answering from exactly the same place.
    for (const v of analysis.variables) {
      if (!matches(v.name)) continue;
      const needsQuotes = /[^A-Za-z0-9_]/.test(v.name);
      const written = needsQuotes ? `#"${v.name}"` : `#${v.name}`;
      out.push({
        key: `var:${v.id}`,
        label: written,
        detail: "variable",
        describe: "A document variable — edit it in the Variables window.",
        insert: written,
        caretOffset: written.length,
        kind: "variable",
      });
    }
  } else if (query.kind === "layerName") {
    // Layers are named, not numbered: the timeline's label IS the address, so
    // the list you pick from is the list you are looking at.
    for (const layer of analysis.layers?.all() ?? []) {
      if (!matches(layer.name)) continue;
      out.push({
        key: `layer:${layer.id}`,
        label: layer.name,
        detail: "layer",
        describe: "Read this layer’s values — layer(“…”).x, .opacity, and the rest of its card.",
        insert: layer.name,
        caretOffset: layer.name.length,
        kind: "property",
      });
    }
  } else if (query.kind === "layerProperty") {
    // THAT layer's surface, from the same projection as its own node card — so
    // reading another layer offers exactly what selecting it would.
    const id = query.layerName ? analysis.layers?.idFor(query.layerName) : undefined;
    for (const prop of id ? (analysis.layers?.propertiesOf(id) ?? []) : []) {
      if (!matches(prop.path) && !matches(prop.label)) continue;
      out.push({
        key: `xprop:${prop.path}`,
        label: prop.path,
        detail: `${prop.group} · ${TYPE_CHIP[prop.type]}`,
        describe: `${prop.label} on “${(query.layerName && id ? analysis.layers?.nameOf(id) : undefined) ?? query.layerName}” — the same value its node card shows.`,
        insert: prop.path,
        caretOffset: prop.path.length,
        kind: "property",
      });
    }
  } else if (query.kind === "trackName") {
    for (const t of analysis.tracks?.all() ?? []) {
      if (!matches(t.name)) continue;
      out.push({
        key: `tracker:${t.id}`,
        label: t.name,
        detail: "tracker",
        describe: "Read what this tracker follows — track(“…”).position, .rotation, a corner of a surface.",
        insert: t.name,
        caretOffset: t.name.length,
        kind: "property",
      });
    }
  } else if (query.kind === "trackReading") {
    // THAT tracker's readings table — the Track node's outputs, one list.
    const id = query.layerName ? analysis.tracks?.idFor(query.layerName) : undefined;
    for (const r of id ? (analysis.tracks?.readingsOf(id) ?? []) : []) {
      if (!matches(r.id)) continue;
      out.push({
        key: `reading:${r.id}`,
        label: r.id,
        detail: `tracker · ${TYPE_CHIP[r.type]}`,
        describe: r.describe ?? `${r.id} of the tracked thing, in this comp’s space.`,
        insert: r.id,
        caretOffset: r.id.length,
        kind: "property",
      });
    }
  } else {
    for (const fn of FUNCTIONS) {
      if (!matches(fn.name)) continue;
      const { min } = arity(fn);
      out.push({
        key: `fn:${fn.name}`,
        label: signatureOf(fn),
        detail: fn.category,
        describe: fn.describe,
        insert: `${fn.name}()`,
        // Land inside the brackets when the function actually takes something.
        caretOffset: fn.name.length + (min > 0 ? 1 : 2),
        kind: "function",
      });
    }
  }

  // Names that START with what you typed are what you meant; the rest are still
  // offered, just underneath.
  return out
    .sort((a, b) => rank(a.label, term) - rank(b.label, term) || a.label.localeCompare(b.label))
    .slice(0, 40);
}

function rank(label: string, term: string): number {
  const at = label.toLowerCase().replace(/^#/, "").indexOf(term);
  return at < 0 ? 99 : at;
}

function SuggestionList({
  suggestions,
  active,
  onHover,
  onPick,
}: {
  suggestions: Suggestion[];
  active: number;
  onHover: (index: number) => void;
  onPick: (index: number) => void;
}) {
  const list = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    list.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const current = suggestions[active];

  return (
    <div className="absolute left-0 right-0 top-full z-20 mt-1 overflow-hidden rounded-md border border-border bg-popover shadow-lg">
      <ScrollArea viewportRef={list} className="max-h-44" viewportClassName="py-1">
        {suggestions.map((s, i) => (
          <button
            key={s.key}
            type="button"
            data-active={i === active}
            onMouseEnter={() => onHover(i)}
            // Keep focus in the textarea: a blur would close the list before the
            // click could land on it.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onPick(i)}
            className={cn(
              "flex w-full items-center gap-2 px-2.5 py-1 text-left text-[11px] transition-colors",
              i === active ? "bg-primary/15" : "hover:bg-muted/60",
            )}
          >
            <span className={cn("min-w-0 flex-1 truncate font-mono", PAINT_BY_KIND[s.kind])}>{s.label}</span>
            <span className="shrink-0 text-[9px] uppercase tracking-wide text-muted-foreground/60">
              {s.detail}
            </span>
          </button>
        ))}
      </ScrollArea>
      {current && (
        <div className="flex items-start gap-1.5 border-t border-border/60 bg-muted/25 px-2.5 py-1.5 text-[10px] leading-snug text-muted-foreground">
          <CornerDownLeft className="mt-px size-2.5 shrink-0 opacity-60" />
          <span className="min-w-0 flex-1">{current.describe}</span>
        </div>
      )}
    </div>
  );
}
