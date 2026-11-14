"use client";

import * as React from "react";
import { normalizeError, reportError } from "@solomotion/core";
import { CrashScreen } from "@/editor/runtime/ErrorBoundary";

/**
 * The route segment's fallback — what the framework renders when something
 * throws ABOVE the editor's own boundaries (the layout, a provider). The same
 * crash screen the editor shows, so a person meets one page for a failure,
 * however it arrived, and it carries the same bug report.
 */
export default function RouteError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  React.useEffect(() => {
    reportError(error, { source: "react", panel: "route", digest: error.digest });
  }, [error]);
  return <CrashScreen error={normalizeError(error)} retry={reset} />;
}
