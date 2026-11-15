import { javascriptLanguage, jsxLanguage, tsxLanguage, typescriptLanguage } from "@codemirror/lang-javascript";
import { highlightCode } from "@lezer/highlight";
import { codeTokenHighlighter } from "./code-tokens";

/**
 * Static code → coloured runs, for code shown but not edited (the agent's
 * replies). Loaded lazily: the parser is the Scripts editor's, and a chat
 * with no code never pays for it. Languages we don't parse come back as one
 * plain run.
 */
export interface CodeRun {
  text: string;
  /** A `CodeToken`, or "" for plain ink. */
  token: string;
}

const PARSERS = {
  js: javascriptLanguage.parser,
  javascript: javascriptLanguage.parser,
  json: javascriptLanguage.parser,
  jsx: jsxLanguage.parser,
  ts: typescriptLanguage.parser,
  typescript: typescriptLanguage.parser,
  tsx: tsxLanguage.parser,
} as const;

export function highlightRuns(code: string, lang: string): CodeRun[] {
  const parser = PARSERS[lang.toLowerCase() as keyof typeof PARSERS];
  if (!parser) return [{ text: code, token: "" }];
  // JSON as a script is a block with labels; as an expression it is an object.
  const isJson = lang.toLowerCase() === "json";
  const src = isJson ? `(${code})` : code;
  const runs: CodeRun[] = [];
  highlightCode(
    src,
    parser.parse(src),
    codeTokenHighlighter,
    (text, token) => runs.push({ text, token }),
    () => runs.push({ text: "\n", token: "" }),
  );
  if (isJson) {
    // Drop the wrapping parens again.
    if (runs[0]?.text.startsWith("(")) runs[0] = { ...runs[0], text: runs[0].text.slice(1) };
    const last = runs[runs.length - 1];
    if (last?.text.endsWith(")")) runs[runs.length - 1] = { ...last, text: last.text.slice(0, -1) };
  }
  return runs;
}
