"use client";

import * as React from "react";
import type { CodeRun } from "./code-highlight";
import { tokenColor } from "./code-tokens";

/**
 * Code shown, not edited: plain ink at once, coloured a moment later when the
 * parser chunk arrives (and instantly after that). Same colours as the Scripts
 * editor and the site's docs (`code-tokens.ts`).
 */
let load: Promise<typeof import("./code-highlight")> | null = null;
let ready: typeof import("./code-highlight") | null = null;

export function HighlightedCode({ code, lang = "js" }: { code: string; lang?: string }) {
  const [runs, setRuns] = React.useState<CodeRun[] | null>(() => (ready ? ready.highlightRuns(code, lang) : null));
  React.useEffect(() => {
    let live = true;
    if (ready) {
      setRuns(ready.highlightRuns(code, lang));
      return;
    }
    load ??= import("./code-highlight").then((m) => (ready = m));
    void load.then((m) => live && setRuns(m.highlightRuns(code, lang)));
    return () => {
      live = false;
    };
  }, [code, lang]);
  if (!runs) return <>{code}</>;
  return (
    <>
      {runs.map((r, i) =>
        r.token ? (
          <span key={i} style={{ color: tokenColor(r.token), fontStyle: r.token === "comment" ? "italic" : undefined }}>
            {r.text}
          </span>
        ) : (
          r.text
        ),
      )}
    </>
  );
}
