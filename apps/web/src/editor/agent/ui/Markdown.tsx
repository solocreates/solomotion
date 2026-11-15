"use client";

import * as React from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";
import { HighlightedCode } from "../../scripts/HighlightedCode";

/**
 * Markdown for chat replies — the subset models actually write (paragraphs,
 * headings, lists, quotes, fenced code, inline code, bold, italic, links,
 * rules, simple tables), rendered to React elements. Never to HTML: a model's
 * output is untrusted text, and building elements means nothing in it can
 * become markup. Small enough to live in the agent chunk without a dependency.
 */

type Block =
  | { t: "p"; text: string }
  | { t: "h"; level: number; text: string }
  | { t: "ul" | "ol"; items: string[] }
  | { t: "quote"; text: string }
  | { t: "code"; lang: string; text: string }
  | { t: "hr" }
  | { t: "table"; head: string[]; rows: string[][] };

function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const fence = /^```(\w*)/.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i]!)) body.push(lines[i++]!);
      i++;
      out.push({ t: "code", lang: fence[1] ?? "", text: body.join("\n") });
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      out.push({ t: "h", level: h[1]!.length, text: h[2]! });
      i++;
      continue;
    }
    if (/^(-{3,}|\*{3,})\s*$/.test(line)) {
      out.push({ t: "hr" });
      i++;
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:-]+\|/.test(lines[i + 1]!)) {
      const cells = (l: string) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]!)) rows.push(cells(lines[i++]!));
      out.push({ t: "table", head, rows });
      continue;
    }
    const list = /^\s*([-*+]|\d+[.)])\s+/.exec(line);
    if (list) {
      const ordered = /\d/.test(list[1]!);
      const items: string[] = [];
      while (i < lines.length) {
        const m = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]!);
        if (m) items.push(m[2]!);
        else if (/^\s{2,}\S/.test(lines[i]!) && items.length) items[items.length - 1] += ` ${lines[i]!.trim()}`;
        else break;
        i++;
      }
      out.push({ t: ordered ? "ol" : "ul", items });
      continue;
    }
    if (/^>\s?/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i]!)) body.push(lines[i++]!.replace(/^>\s?/, ""));
      out.push({ t: "quote", text: body.join(" ") });
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !/^(#{1,4}\s|```|\s*([-*+]|\d+[.)])\s|>)/.test(lines[i]!)) para.push(lines[i++]!);
    out.push({ t: "p", text: para.join("\n") });
  }
  return out;
}

const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*|_[^_\s][^_]*_)|(\[[^\]]+\]\([^)\s]+\))/g;

function inline(text: string, key = 0): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let last = 0;
  let k = key;
  for (const m of text.matchAll(INLINE)) {
    if (m.index! > last) out.push(...withBreaks(text.slice(last, m.index), k++));
    const s = m[0];
    if (m[1]) out.push(<code key={k++} className="rounded-(--r-xs) bg-raised px-1 py-px font-mono text-[0.92em] text-(--code-foreground)">{s.slice(1, -1)}</code>);
    else if (m[2]) out.push(<strong key={k++} className="font-semibold text-foreground">{inline(s.slice(2, -2), k * 100)}</strong>);
    else if (m[3]) out.push(<em key={k++}>{inline(s.slice(1, -1), k * 100)}</em>);
    else if (m[4]) {
      const lm = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(s)!;
      const href = /^(https?:|mailto:)/i.test(lm[2]!) ? lm[2]! : undefined;
      out.push(
        href ? (
          <a key={k++} href={href} target="_blank" rel="noreferrer" className="text-primary underline-offset-2 hover:underline">
            {lm[1]}
          </a>
        ) : (
          <span key={k++}>{lm[1]}</span>
        ),
      );
    }
    last = m.index! + s.length;
  }
  if (last < text.length) out.push(...withBreaks(text.slice(last), k++));
  return out;
}

function withBreaks(text: string, key: number): React.ReactNode[] {
  const parts = text.split("\n");
  return parts.flatMap((p, i) => (i === 0 ? [p] : [<br key={`${key}-br-${i}`} />, p]));
}

export const Markdown = React.memo(function Markdown({ text, className }: { text: string; className?: string }) {
  const blocks = React.useMemo(() => parseBlocks(text), [text]);
  return (
    <div className={cn("space-y-2 text-sm leading-relaxed text-foreground/90 [overflow-wrap:anywhere]", className)}>
      {blocks.map((b, i) => {
        switch (b.t) {
          case "p":
            return <p key={i}>{inline(b.text)}</p>;
          case "h":
            return (
              <p key={i} className={cn("font-semibold text-foreground", b.level <= 2 ? "pt-1 text-base" : "text-sm")}>
                {inline(b.text)}
              </p>
            );
          case "ul":
          case "ol": {
            const Tag = b.t;
            return (
              <Tag key={i} className={cn("space-y-1 pl-4", b.t === "ul" ? "list-disc" : "list-decimal", "marker:text-muted-foreground")}>
                {b.items.map((it, j) => (
                  <li key={j}>{inline(it)}</li>
                ))}
              </Tag>
            );
          }
          case "quote":
            return (
              <blockquote key={i} className="border-l-2 border-primary/50 pl-3 text-muted-foreground">
                {inline(b.text)}
              </blockquote>
            );
          case "code":
            return (
              <CodeBlock key={i} code={b.text} lang={b.lang} />
            );
          case "hr":
            return <hr key={i} className="border-border" />;
          case "table":
            return (
              <div key={i} className="overflow-x-auto rounded-md border">
                <table className="w-full text-xs">
                  <thead className="bg-muted/50">
                    <tr>
                      {b.head.map((h, j) => (
                        <th key={j} className="px-2 py-1 text-left font-medium">
                          {inline(h)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows.map((r, j) => (
                      <tr key={j} className="border-t">
                        {r.map((c, x) => (
                          <td key={x} className="px-2 py-1 align-top">
                            {inline(c)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
        }
      })}
    </div>
  );
});

const LANG_LABEL: Record<string, string> = { js: "JavaScript", javascript: "JavaScript", ts: "TypeScript", typescript: "TypeScript", tsx: "TSX", jsx: "JSX", json: "JSON", bash: "Shell", sh: "Shell", css: "CSS", diff: "Diff" };

/**
 * Fenced code, drawn as the site's docs draw it: ink on the panel inside a
 * hairline frame, the docs' token colours, the language and a copy button on
 * a quiet head.
 */
function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const [copied, setCopied] = React.useState(false);
  const copy = () => {
    void navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    });
  };
  const label = LANG_LABEL[lang.toLowerCase()] ?? (lang || "Code");
  return (
    <figure className="group/code overflow-hidden rounded-(--r-md) border border-(--line)">
      <figcaption className="flex h-7 items-center justify-between border-b border-(--line) pl-3 pr-1">
        <span data-part="label" className="text-meta text-fg-faint">{label}</span>
        <button
          type="button"
          onClick={copy}
          aria-label="Copy code"
          className="grid size-6 place-items-center rounded-(--r-xs) text-fg-faint opacity-0 transition hover:bg-hover hover:text-fg focus-visible:opacity-100 group-hover/code:opacity-100 [@media(pointer:coarse)]:opacity-100 [&_svg]:size-3.5"
        >
          {copied ? <Check className="text-success" /> : <Copy />}
        </button>
      </figcaption>
      <pre className="overflow-x-auto px-3 py-2.5 font-mono text-xs leading-[1.7] text-(--code-foreground)">
        <code>
          <HighlightedCode code={code} lang={lang} />
        </code>
      </pre>
    </figure>
  );
}
