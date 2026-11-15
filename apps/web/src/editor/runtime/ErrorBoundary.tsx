"use client";

import { identity } from "@/editor/identity";
import { product } from "@/editor/product";
import * as React from "react";
import { normalizeError, reportError, type EngineError } from "@solomotion/core";
import { AlertTriangle, Bug, ClipboardCopy, RotateCcw, ScrollText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { copyableBugReport, useCopier } from "../console/console-report";
import { useSession } from "../state/session";

/**
 * THE RENDER BOUNDARIES — where a React error stops being a page.
 *
 * The runtime already funnels every thrown value into one spine: uncaught
 * errors, rejections, a bad layer in the renderer. What it could not reach was
 * the one failure React handles on its own terms — a throw during RENDER —
 * because React's answer to an unhandled render error is to unmount the tree.
 * With nothing above the editor to catch it, that meant a blank page wearing
 * the framework's stock apology, the document still in memory and no way back
 * to it. This is the other half of the funnel.
 *
 * Two grains, on purpose:
 *
 *   PANEL   the inspector, the stage, the bottom region, the left column. A
 *           panel that cannot draw shows a card in its own frame and the rest
 *           of the editor keeps working — the document, the undo stack, the
 *           playhead, all untouched. A wrong value in one clip's properties
 *           should cost you one panel until you select something else, not
 *           the session.
 *   APP     the last resort under the whole editor, for a failure the panels
 *           did not contain. It says what happened, offers the bug report with
 *           everything already in it, and reloads. The project autosaves, so
 *           the honest promise is "your work is on disk", and it is made.
 *
 * Both do exactly one thing with the error: `reportError`. Toasting, logging
 * and the Activity row are decided by the subscribers, as for any other throw.
 */

interface BoundaryProps {
  /** What the person calls this region — "Properties", not "InspectorPanel". */
  name: string;
  /** Changing this retries on its own: a panel that broke on one selection heals on the next. */
  resetKey?: unknown;
  fallback: (ctx: { error: EngineError; retry: () => void }) => React.ReactNode;
  children: React.ReactNode;
}

interface BoundaryState {
  error: EngineError | null;
  /** The resetKey the error was caught under, so a later key clears it. */
  caughtAt: unknown;
}

class Boundary extends React.Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { error: null, caughtAt: undefined };

  static getDerivedStateFromError(error: unknown): Partial<BoundaryState> {
    // This is the switch to the fallback, and it has to happen HERE: React
    // re-renders the subtree from this state before `componentDidCatch` runs,
    // so a boundary that only records the error there renders the broken
    // children a second time, throws again, and hands the error up to the
    // next boundary — the app-level one. Normalised once; the report below
    // recognises it and adds context rather than wrapping it again.
    return { error: normalizeError(error) };
  }

  componentDidCatch(error: unknown, info: React.ErrorInfo) {
    reportError(this.state.error ?? error, {
      source: "react",
      panel: this.props.name,
      componentStack: info.componentStack ?? undefined,
    });
    this.setState({ caughtAt: this.props.resetKey });
  }

  componentDidUpdate(prev: BoundaryProps) {
    if (this.state.error && prev.resetKey !== this.props.resetKey && this.state.caughtAt !== this.props.resetKey) {
      this.retry();
    }
  }

  retry = () => this.setState({ error: null, caughtAt: undefined });

  render() {
    if (this.state.error) return this.props.fallback({ error: this.state.error, retry: this.retry });
    return this.props.children;
  }
}

// ── the panel grain ──────────────────────────────────────────────────────────

export function PanelBoundary({
  name,
  resetKey,
  children,
}: {
  name: string;
  resetKey?: unknown;
  children: React.ReactNode;
}) {
  return (
    <Boundary
      name={name}
      resetKey={resetKey}
      fallback={({ error, retry }) => <PanelFallback name={name} error={error} retry={retry} />}
    >
      {children}
    </Boundary>
  );
}

function PanelFallback({ name, error, retry }: { name: string; error: EngineError; retry: () => void }) {
  return (
    <div className="flex h-full min-h-0 items-center justify-center p-4">
      <div className="flex w-full max-w-72 flex-col gap-3 rounded-lg border bg-card/60 p-4">
        <div className="flex items-start gap-2.5">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
          <div className="min-w-0">
            <div className="text-[12px] font-semibold text-foreground">{name} couldn’t draw</div>
            <div className="mt-0.5 line-clamp-3 text-[11px] leading-snug text-muted-foreground">
              {error.userMessage}
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Button size="xs" onClick={retry}>
            <RotateCcw /> Retry
          </Button>
          <Button size="xs" variant="ghost" onClick={() => useSession.getState().setConsoleOpen(true)}>
            <ScrollText /> Details
          </Button>
          <Button size="xs" variant="ghost" onClick={() => product.feedback.open("bug", { note: `${name} couldn’t draw: ${error.code} ${error.message}` })}>
            <Bug /> Report
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── the app grain ────────────────────────────────────────────────────────────

export function AppBoundary({ children }: { children: React.ReactNode }) {
  return (
    <Boundary name={identity.name} fallback={({ error, retry }) => <CrashScreen error={error} retry={retry} />}>
      {children}
    </Boundary>
  );
}

/**
 * The page a person sees when nothing narrower caught it. Also what the
 * framework's own route-level fallbacks render (`app/error.tsx`), so there is
 * one crash screen however the error arrived.
 */
export function CrashScreen({
  error,
  retry,
  className,
}: {
  error: EngineError;
  /** Try rendering again without a reload — offered when the caller can. */
  retry?: () => void;
  className?: string;
}) {
  const copy = useCopier();
  // The form renders HERE rather than as the dialog: this screen is also what
  // the route-level fallback shows, where the editor's dialog was never mounted.
  const [reporting, setReporting] = React.useState(false);
  // The product's inline report form, when it has one (read at render: the product loads after this module).
  const FeedbackForm = product.feedback.Form;
  const note = `${error.code} ${error.message}`;
  return (
    <div className={cn("flex min-h-dvh flex-col items-center justify-center overflow-y-auto bg-background p-6 text-foreground", className)}>
      <div className="flex w-full max-w-md flex-col gap-5">
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 size-5 shrink-0 text-warning" />
          <div className="min-w-0">
            <h1 className="text-base font-semibold tracking-tight">{identity.name} hit a problem it couldn’t recover from</h1>
            <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">
              Your project is saved as you work, so reloading brings it back.
            </p>
          </div>
        </div>
        <pre className="max-h-40 overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-[11px] leading-relaxed text-muted-foreground">
          {error.code}
          {"\n"}
          {error.message}
        </pre>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={() => window.location.reload()}>
            <RotateCcw /> Reload
          </Button>
          {retry && (
            <Button size="sm" variant="outline" onClick={retry}>
              Try again
            </Button>
          )}
          {!reporting && (
            <Button size="sm" variant="outline" onClick={() => (FeedbackForm ? setReporting(true) : product.feedback.open("bug", { note }))}>
              <Bug /> Send report
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => copy(copyableBugReport(note), "bug report")}>
            <ClipboardCopy /> Copy
          </Button>
        </div>
        {reporting && FeedbackForm && (
          <FeedbackForm
            topic="bug"
            note={note}
            autoFocus
            onDone={() => setReporting(false)}
            className="rounded-xl border bg-card p-4"
          />
        )}
      </div>
    </div>
  );
}

