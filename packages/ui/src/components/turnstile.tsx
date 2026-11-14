"use client";

import { useEffect, useRef, useState } from "react";

interface TurnstileApi {
  render(
    el: HTMLElement,
    opts: {
      sitekey: string;
      theme?: "dark" | "light" | "auto";
      appearance?: "always" | "execute" | "interaction-only";
      callback: (token: string) => void;
      "expired-callback"?: () => void;
      "error-callback"?: () => void;
      "before-interactive-callback"?: () => void;
    },
  ): string;
  remove(id: string): void;
  reset(id: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

function loadScript(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  return new Promise((resolve, reject) => {
    let script = document.querySelector<HTMLScriptElement>(`script[src="${SRC}"]`);
    if (!script) {
      script = document.createElement("script");
      script.src = SRC;
      script.async = true;
      document.head.appendChild(script);
    }
    script.addEventListener("load", () => (window.turnstile ? resolve(window.turnstile) : reject(new Error("turnstile"))));
    script.addEventListener("error", () => reject(new Error("turnstile")));
  });
}

/**
 * Cloudflare Turnstile, invisible unless Cloudflare actually wants a human to
 * click something (`interaction-only`). With no site key it renders nothing
 * and the server skips the check — local dev.
 *
 * `onToken(null)` means "no valid token right now" (expired or failed), so the
 * form can hold its submit until a fresh one arrives. `onState` says why it's
 * waiting, so the button can ask for the right thing instead of spinning.
 */
export type ChallengeState = "checking" | "interactive" | "failed" | "passed";

export function Turnstile({
  siteKey,
  onToken,
  onState,
  theme = "dark",
}: {
  siteKey: string | null;
  onToken: (token: string | null) => void;
  onState?: (state: ChallengeState) => void;
  theme?: "dark" | "light" | "auto";
}) {
  const ref = useRef<HTMLDivElement>(null);
  const cb = useRef(onToken);
  cb.current = onToken;
  const st = useRef(onState);
  st.current = onState;
  // `interaction-only` hides the widget but Cloudflare still sizes its box, so
  // a form grew a 70px hole above its button. Collapsed until a person is
  // actually asked to click something.
  const [asking, setAsking] = useState(false);

  useEffect(() => {
    if (!siteKey || !ref.current) return;
    let id: string | null = null;
    let cancelled = false;
    loadScript()
      .then((api) => {
        if (cancelled || !ref.current) return;
        id = api.render(ref.current, {
          sitekey: siteKey,
          theme,
          appearance: "interaction-only",
          callback: (t) => {
            cb.current(t);
            setAsking(false);
            st.current?.("passed");
          },
          "expired-callback": () => {
            cb.current(null);
            st.current?.("checking");
          },
          "error-callback": () => {
            cb.current(null);
            st.current?.("failed");
          },
          "before-interactive-callback": () => {
            setAsking(true);
            st.current?.("interactive");
          },
        });
      })
      .catch(() => {
        cb.current(null);
        st.current?.("failed");
      });
    return () => {
      cancelled = true;
      if (id && window.turnstile) window.turnstile.remove(id);
    };
  }, [siteKey, theme]);

  if (!siteKey) return null;
  return (
    <div className={asking ? undefined : "pointer-events-none absolute size-px overflow-hidden opacity-0"}>
      <div ref={ref} />
    </div>
  );
}
