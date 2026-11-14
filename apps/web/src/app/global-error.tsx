"use client";

import * as React from "react";
import { normalizeError, reportError } from "@solomotion/core";
import { CrashScreen } from "@/editor/runtime/ErrorBoundary";
import "./globals.css";

/**
 * The root layout's own fallback. It REPLACES the layout, so it must supply
 * the document itself — and the stylesheet, or the crash screen would render
 * unstyled at the exact moment it needs to look like the product.
 */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  React.useEffect(() => {
    reportError(error, { source: "react", panel: "root", digest: error.digest });
  }, [error]);
  return (
    <html lang="en" className="dark">
      <body>
        <CrashScreen error={normalizeError(error)} retry={reset} />
      </body>
    </html>
  );
}
