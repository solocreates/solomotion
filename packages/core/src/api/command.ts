import type { z } from "zod";
import type { MotionDocument } from "../schema";
import type { DocumentStore } from "../history/document-store";

/**
 * THE COMMAND — one verb of the app's public, headless API.
 *
 * A command is data plus one function: an id, a zod input, whether it reads or
 * writes, and `run`. Everything that drives the app from OUTSIDE a pointer —
 * the agent, the plugin bridge, a future MCP server, a test — speaks this one
 * vocabulary, so a verb is written once and every caller has it the day it
 * lands. That is the same bargain the effect and property registries strike,
 * one level up.
 *
 * Commands are pure over the document store. Anything only the host can do
 * (render pixels, read the clipboard, change the selection) is still a
 * command — the host registers it with the same shape — so callers never learn
 * which half of the app answered.
 */

export type CommandEffect = "read" | "write";

/**
 * The slice of editor SESSION a command may read. Passed in, never imported:
 * core has no session, and a headless caller (a test, the exporter, a server)
 * supplies its own answers.
 */
export interface ApiSession {
  /** The comp the user is looking at — where "here" is when no frame is named. */
  focusFrameId(): string | null;
  /** The playhead, in the focused comp's time. */
  playheadMs(): number;
  /** Selected layer ids. */
  selection(): readonly string[];
}

export interface CommandContext {
  store: DocumentStore;
  session: ApiSession;
  /**
   * Who is editing, as it should read in the Undo menu ("AI"). Every write a
   * command makes is labelled with it, so a user can always see which steps
   * were not theirs.
   */
  actor: string;
  /**
   * Undo grouping. Writes carrying the same key merge into ONE history entry
   * for as long as nothing else lands between them — so an agent turn that
   * makes twenty edits is one ⌘Z, and the user's own edit in the middle of it
   * starts a new one. Omit for one step per write.
   */
  historyKey?: string;
  /** Label of the grouped entry (the turn's request); defaults to the command's. */
  historyLabel?: string;
  signal?: AbortSignal;
  /**
   * Who is calling, stably — an agent session's id. Work that outlives its
   * call (an export job) is listed per caller, so a session sees its own.
   */
  caller?: string;
  /**
   * Where a long command says how it is doing ("Queued (#2)", "Generating ·
   * 40%") — the chat's tool row, the status bar. Optional; silence is fine.
   */
  progress?: (text: string) => void;
  /**
   * Hand a file the command made to the CALLER rather than the user's
   * downloads — the MCP bridge writes it on the agent's machine, where a
   * browser download from an embedded pane may never land. Present only for
   * callers that can take files; resolves to where the file landed.
   */
  deliver?: (file: DeliveredFile) => Promise<string>;
}

/** A file a command hands back through `CommandContext.deliver`. */
export interface DeliveredFile {
  name: string;
  bytes: Uint8Array;
  /** Where the caller asked for it — as the caller's `saveTo` named it (resolved by the bridge). */
  path: string;
}

/** The context `run` receives: the caller's, plus the one sanctioned writer. */
export interface CommandRuntime extends CommandContext {
  /** Read the live document. */
  doc(): MotionDocument;
  /**
   * The ONE way a command changes the document: an undoable store update,
   * labelled and grouped per the context. Returns whether anything changed.
   */
  write(label: string, recipe: (draft: MotionDocument) => void): boolean;
}

export interface CommandDef<S extends z.ZodTypeAny = z.ZodTypeAny, O = unknown> {
  /** Dotted, stable, lowercase: `layer.create`, `keyframes.set`. Never renamed. */
  id: string;
  /** One line: what it does, for the tool list. */
  summary: string;
  /**
   * Usage notes the model reads before calling — units, coordinate spaces,
   * what to call first. Short; the skill carries the craft, this carries the
   * contract.
   */
  details?: string;
  effect: CommandEffect;
  input: S;
  run(input: z.output<S>, rt: CommandRuntime): O | Promise<O>;
}

/** Identity helper that keeps `input` and `run` inferred together. */
export function defineCommand<S extends z.ZodTypeAny, O>(def: CommandDef<S, O>): CommandDef<S, O> {
  return def;
}

/**
 * A failure the CALLER can fix — a missing layer, a value out of range. The
 * message is written to be read by whoever made the call (often a model), and
 * `hint` says what to do instead. Anything else thrown is a bug in the command
 * and is reported as one.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export type CommandResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string; hint?: string; kind: "input" | "api" | "internal" };
