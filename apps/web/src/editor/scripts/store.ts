"use client";

import { create } from "zustand";
import type { Cloned, LogLevel, ScriptFault } from "./protocol";

/**
 * The Scripts panel's SESSION — which file is open and what the runs said.
 * Nothing here is project content (that is `doc.scripts`); closing the app
 * loses the output the way closing DevTools does.
 */

export interface RunLog {
  level: LogLevel;
  args: Cloned[];
  /** The line in the script that logged it. */
  line?: number;
}

export type RunStatus = "queued" | "running" | "ok" | "error" | "stopped";

/** Who ended a run early: the Stop button, an agent's `script.stop`, or its own time budget. */
export type StoppedBy = "person" | "agent" | "timeout";

export interface RunRecord {
  id: string;
  /** `intro/title.js`, or `console` for the prompt. */
  path: string;
  repl: boolean;
  code: string;
  scriptId?: string;
  /** The comp it ran in (`here`), by name — where to look for what it made. */
  here?: string;
  status: RunStatus;
  startedAt: number;
  ms: number;
  logs: RunLog[];
  /** Logs past the cap, counted rather than kept. */
  dropped: number;
  value?: Cloned;
  error?: ScriptFault & { line?: number; column?: number };
  /** Layers + comps this run created. */
  created: number;
  /** Which ones — what a failed or stopped run left behind is exactly these. */
  made?: { clipIds: string[]; frameIds: string[] };
  stoppedBy?: StoppedBy;
  /** The run stops itself past this many ms (agent runs; a person has the Stop button). */
  budgetMs?: number;
  /** Layers + comps the previous run made that this one took back. */
  replaced: number;
  /** Commands still in flight when the script returned — a missing `await`. */
  unawaited: number;
}

const MAX_ENTRIES = 80;

interface ScriptsState {
  openId: string | null;
  entries: RunRecord[];
  running: string | null;
  history: string[];
  setOpen(id: string | null): void;
  push(entry: RunRecord): void;
  patch(id: string, fn: (r: RunRecord) => RunRecord): void;
  setRunning(id: string | null): void;
  remember(line: string): void;
  clear(): void;
}

export const useScripts = create<ScriptsState>((set) => ({
  openId: null,
  entries: [],
  running: null,
  history: [],
  setOpen: (openId) => set({ openId }),
  push: (entry) => set((s) => ({ entries: [...s.entries, entry].slice(-MAX_ENTRIES) })),
  patch: (id, fn) => set((s) => ({ entries: s.entries.map((e) => (e.id === id ? fn(e) : e)) })),
  setRunning: (running) => set({ running }),
  remember: (line) => set((s) => ({ history: [...s.history.filter((h) => h !== line), line].slice(-100) })),
  clear: () => set((s) => ({ entries: s.entries.filter((e) => e.status === "running") })),
}));
