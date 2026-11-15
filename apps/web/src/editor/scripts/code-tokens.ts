import { HighlightStyle } from "@codemirror/language";
import { tags as t, tagHighlighter, type Tag } from "@lezer/highlight";

/**
 * CODE COLOURS — the one table from syntax to colour, for every place the
 * editor shows code: the Scripts editor (CodeMirror) and code in the agent's
 * replies (`code-highlight.ts`).
 *
 * The colours are the site's: Shiki's CSS-variable tokens
 * (`--code-token-*`, mapped to the theme's own tones in the theme's parts),
 * so a script reads the same as the docs that teach it, in every look and
 * mode. No second palette: a new token is a row here, never a colour.
 */
export type CodeToken = "keyword" | "constant" | "string" | "comment" | "function" | "parameter" | "punctuation";

const RULES: ReadonlyArray<{ tag: Tag[]; token: CodeToken }> = [
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword, t.definitionKeyword, t.modifier, t.self], token: "keyword" },
  { tag: [t.number, t.bool, t.null, t.atom, t.typeName, t.className], token: "constant" },
  { tag: [t.string, t.special(t.string), t.regexp], token: "string" },
  { tag: [t.comment, t.lineComment, t.blockComment], token: "comment" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], token: "function" },
  { tag: [t.propertyName, t.labelName], token: "parameter" },
  { tag: [t.punctuation, t.bracket, t.operator, t.separator], token: "punctuation" },
];

export const tokenColor = (token: string) => `var(--code-token-${token})`;

/** The Scripts editor's highlighter. */
export const codeHighlightStyle = HighlightStyle.define(
  RULES.map((r) => ({ tag: r.tag, color: tokenColor(r.token), ...(r.token === "comment" ? { fontStyle: "italic" } : {}) })),
);

/** For static code: the "class" it hands back IS the token name. */
export const codeTokenHighlighter = tagHighlighter(RULES.flatMap((r) => r.tag.map((tag) => ({ tag, class: r.token }))));
