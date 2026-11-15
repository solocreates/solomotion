"use client";

import * as React from "react";
import { product } from "../product";

export type GithubTarget = { kind: "repo" | "user"; slug: string };

/** Where the free action lives, and what it is called. */
export const githubUrl = (t: GithubTarget) => `https://github.com/${t.slug}`;
export const githubVerb = (t: GithubTarget) => (t.kind === "repo" ? "Star on GitHub" : "Follow on GitHub");

const TTL = 6 * 60 * 60 * 1000;
const key = (t: GithubTarget) => `${product.ns}.support.github.${t.kind}.${t.slug}`;

function readCache(t: GithubTarget): { n: number; at: number } | null {
  try {
    const raw = localStorage.getItem(key(t));
    return raw ? (JSON.parse(raw) as { n: number; at: number }) : null;
  } catch {
    return null;
  }
}

/**
 * The live star (or follower) count from GitHub's public API — no auth, so it
 * is rate-limited per IP: cached for six hours, and any failure (offline, 403,
 * a renamed repo) just leaves the count out. Fetched when the popover opens,
 * never at boot.
 */
export function useGithubCount(t: GithubTarget): number | null {
  const [n, setN] = React.useState<number | null>(() => readCache(t)?.n ?? null);
  React.useEffect(() => {
    const cached = readCache(t);
    if (cached && Date.now() - cached.at < TTL) return;
    const ctl = new AbortController();
    const url = t.kind === "repo" ? `https://api.github.com/repos/${t.slug}` : `https://api.github.com/users/${t.slug}`;
    fetch(url, { signal: ctl.signal, headers: { Accept: "application/vnd.github+json" } })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { stargazers_count?: number; followers?: number } | null) => {
        const v = t.kind === "repo" ? j?.stargazers_count : j?.followers;
        if (typeof v !== "number") return;
        setN(v);
        try {
          localStorage.setItem(key(t), JSON.stringify({ n: v, at: Date.now() }));
        } catch {}
      })
      .catch(() => {});
    return () => ctl.abort();
  }, [t]);
  return n;
}

/** 1234 → "1.2k": a count, not an accounting. */
export const shortCount = (n: number) =>
  n < 1000 ? String(n) : n < 10_000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : `${Math.round(n / 1000)}k`;
