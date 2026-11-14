"use client";

import * as React from "react";

/**
 * FULLSCREEN — read from the browser, never stored.
 *
 * The temptation is a boolean in a store that a button flips. It is wrong for
 * one reason that shows up immediately: Escape and F11 leave fullscreen without
 * asking the app, so a stored flag is a second answer to a question the
 * platform already answers — and the two disagree the first time anybody
 * presses Escape, leaving a button that says "exit" over a windowed app.
 *
 * So this subscribes to `fullscreenchange` and reports what is actually true.
 * The icon can then be derived rather than remembered, which is what makes it
 * impossible for it to be wrong.
 *
 * `webkit*` still exists because iPad Safari has no standard
 * `Element.requestFullscreen` — and an iPad is precisely the device this button
 * matters most on.
 */

interface WebkitDoc extends Document {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
}
interface WebkitEl extends HTMLElement {
  webkitRequestFullscreen?: () => Promise<void> | void;
}

function activeElement(): Element | null {
  if (typeof document === "undefined") return null;
  const d = document as WebkitDoc;
  return d.fullscreenElement ?? d.webkitFullscreenElement ?? null;
}

export interface Fullscreen {
  active: boolean;
  /** False where the platform has no fullscreen at all (iPhone Safari) — the
   *  button hides rather than throwing when pressed. */
  supported: boolean;
  toggle: () => void;
}

export function useFullscreen(): Fullscreen {
  const [active, setActive] = React.useState(false);
  const [supported, setSupported] = React.useState(false);

  React.useEffect(() => {
    const el = document.documentElement as WebkitEl;
    setSupported(
      typeof el.requestFullscreen === "function" || typeof el.webkitRequestFullscreen === "function",
    );
    const sync = () => setActive(activeElement() !== null);
    sync();
    // Both spellings: WebKit fires only its prefixed event, and a listener for
    // the standard one alone leaves the icon stale on Safari forever.
    document.addEventListener("fullscreenchange", sync);
    document.addEventListener("webkitfullscreenchange", sync);
    return () => {
      document.removeEventListener("fullscreenchange", sync);
      document.removeEventListener("webkitfullscreenchange", sync);
    };
  }, []);

  const toggle = React.useCallback(() => {
    const d = document as WebkitDoc;
    const el = document.documentElement as WebkitEl;
    // The promise rejects when the gesture wasn't user-initiated or the
    // browser refuses. Swallowed: there is nothing to tell the user that the
    // unchanged icon does not already say.
    if (activeElement()) void Promise.resolve(d.exitFullscreen?.() ?? d.webkitExitFullscreen?.()).catch(() => {});
    else void Promise.resolve(el.requestFullscreen?.() ?? el.webkitRequestFullscreen?.()).catch(() => {});
  }, []);

  return { active, supported, toggle };
}
