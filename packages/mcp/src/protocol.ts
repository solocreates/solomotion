/**
 * The wire between the MCP bridge (a local Node process) and a running editor
 * tab. The editor CONNECTS OUT to the bridge — a web page cannot listen — over
 * a WebSocket on 127.0.0.1, and proves it is the tab the user paired by
 * sending the token the bridge printed.
 *
 *   editor → bridge   hello     { token, app, tools, knowledge, bridge, features, origin, dev, visible, tab, claim }  once, on connect
 *   editor → bridge   state     { visible }                       the tab was hidden or shown (a hidden tab renders slowly)
 *   bridge → editor   welcome   { client, features }              the hub's agent app, and what it can do (below)
 *   bridge → editor   sessions  { sessions }                      every agent session sharing the link, on change
 *   bridge → editor   call      { id, name, input, session }      an MCP tools/call, and which session made it
 *   editor → bridge   progress  { id, text }                      a long call is alive ("Exporting · 40%")
 *   editor → bridge   file      { id, session, path, name, seq, data, last } a file for that session, in base64 chunks
 *   bridge → editor   ack       { id, seq }                       that chunk is handled: send the next (3.9+, "acks")
 *   bridge → editor   filed     { id, path?, error? }             the file is on disk (after its last chunk)
 *   bridge → editor   cancel    { id }                            the agent gave up: stop working on it
 *   editor → bridge   result    { id, content, isError }          its answer
 *   bridge → editor   moved     { to }                            the hub moved: link again through the port, keep this socket for the calls still on it
 *
 * A call has no fixed deadline: the bridge waits as long as the tab keeps
 * saying it is working (`progress`), and cancels it after a long silence, so
 * a render the agent gave up on stops instead of running on in the page.
 *
 * Files travel TO the agent's machine the way `localPath` brings them FROM it:
 * a `saveTo` argument is resolved to an absolute path by the calling bridge,
 * and a `file` is addressed to that SESSION, whose own bridge writes it — the
 * hub only relays (it writes for a bridge before 3.8, or one that has gone).
 * Addressed by session, not by call, so a file can arrive after its call has
 * answered: an export job finishes minutes later. A download from an embedded
 * browser pane may never land anywhere an agent can find it; this always does.
 *
 * Several agent sessions share ONE link: the bridge holding the port is the
 * hub, the others join it and relay through it (cli.mjs, "One link, every
 * session"). That bridge-to-bridge wire is internal to cli.mjs.
 */
export const MCP_BRIDGE_PORT = 7317;

export interface BridgeTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export type BridgeContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

/**
 * The knowledge the editor works by, served by the bridge as MCP resources.
 * The TAB is the authority, not the bridge's bundled copy and not GitHub: the
 * tools come from this editor, so the skill describing them has to come from
 * the same build — an app a version behind must not be taught verbs it lacks.
 * Paths are resource names: `skill/SKILL.md`, `skill/references/…`, `design/DESIGN.md`.
 */
export interface BridgeKnowledge {
  version: string;
  files: Record<string, string>;
}

/** What a bridge process is (3.8+): what tells a stale copy from the current one. */
export interface BridgeInfo {
  version: string;
  protocol: number;
  pid: number;
  startedAt: number;
  /** "repo", "installed", or "npx cache 637d88" — a cached npx copy is the usual stale one. */
  source: string;
  /** What started it: "Claude", "Cursor", "node drv.mjs" — a harness nobody uses is how a hub sat on the port for days. */
  owner?: string;
  features: BridgeFeature[];
}

/** One agent session on the link: its bridge's id, its agent app (`clientInfo.name`), the folder it runs in, and its bridge (absent before 3.8). */
export interface BridgeSession {
  id: string;
  client: string;
  label?: string;
  bridge?: BridgeInfo;
}

/** File bytes per `file` message (a third more as base64) — far under the socket's 100 MB frame. */
export const FILE_CHUNK_BYTES = 4 * 1024 * 1024;

/** "files": it writes `file` messages to disk (3.7+). "acks": it answers every `file` chunk with `ack` (3.9+). */
export type BridgeFeature = "files" | "acks";

/** "moved": the tab follows a handover on a second socket, so calls in flight on the first are not cut. */
export type EditorFeature = "moved";

export type EditorToBridge =
  /** `bridge`: the bridge release this app ships with — what a bridge calls itself stale against. */
  | {
      kind: "hello";
      token: string;
      app: string;
      tools: BridgeTool[];
      knowledge?: BridgeKnowledge;
      bridge?: string;
      features?: EditorFeature[];
      /** Where the tab runs, whether it is a dev build, and whether it can be seen — what makes an export crawl. */
      origin?: string;
      dev?: boolean;
      visible?: boolean;
      /** This tab, stable across its own reloads — the hub hands a reloading tab its link back by it. */
      tab?: string;
      /**
       * "user": the person pressed Link in this tab — it takes the link from any other.
       * "resume": the tab knocked on its own (load, retry) — the hub refuses it with 4002
       * while another tab holds the link or is reloading. Absent = "user" (tabs before 3.9).
       */
      claim?: "user" | "resume";
    }
  /** `rendering`: an export is running or queued at the tab — the hub does not move under it. */
  | { kind: "state"; visible: boolean; rendering?: boolean }
  | { kind: "progress"; id: string; text: string }
  /**
   * `id` names this transfer (unique per file). `session` is the session that asked; `path` its
   * resolved `saveTo`: a file, or a folder when it ends in "/" (the file keeps `name`).
   */
  | { kind: "file"; id: string; session?: string; path: string; name: string; seq: number; data: string; last: boolean }
  | { kind: "result"; id: string; content: BridgeContent[]; isError?: boolean };

export type BridgeToEditor =
  /** `session` is absent from a 3.x bridge, which served one session at a time. */
  | { kind: "call"; id: string; name: string; input: unknown; session?: BridgeSession }
  /** `features`: "files" = it writes `file` messages to disk (3.7+). Absent from an older bridge, which must not be sent files it would never answer. */
  | { kind: "welcome"; client: string; features?: BridgeFeature[] }
  | { kind: "sessions"; sessions: BridgeSession[] }
  | { kind: "cancel"; id: string }
  | { kind: "filed"; id: string; path?: string; error?: string }
  /** A chunk of transfer `id` is handled (written, or passed to its session's bridge): send more. */
  | { kind: "ack"; id: string; seq: number }
  | { kind: "moved"; to: BridgeSession | null };
