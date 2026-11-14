import { createTextClip, type DocumentStore, type TextStyle,
  compFps,
} from "@solomotion/core";
import {
  METHOD_CAPABILITY,
  type Capability,
  type DocInfo,
  type NotifyLevel,
  type SelectionInfo,
} from "@solomotion/plugin-sdk";
import { placeClip } from "@solomotion/core";
import { activeCompId } from "../../timeline/timeline-utils";

/**
 * The host half of the plugin bridge — the SINGLE trust boundary. Every call a
 * sandboxed plugin makes lands in `handlePluginCall`, which:
 *   1. rejects unknown methods (fail closed), and
 *   2. rejects any method whose capability wasn't granted,
 * before touching the document. Writes go through the same `store.update`
 * undoable seam and the same `placeClip` placement the editor itself uses — a
 * plugin can't reach past the API into raw state.
 */

/** The slice of session state the bridge reads (passed in, never imported — keeps this pure/testable). */
export interface SessionSnapshot {
  activeFrameId: string | null;
  selectedFrameIds: string[];
  selectedClipIds: string[];
  playheadMs: number;
}

export interface BridgeDeps {
  store: DocumentStore;
  getSession: () => SessionSnapshot;
  granted: Capability[];
  notify: (message: string, level?: NotifyLevel) => void;
  resize: (width: number, height: number) => void;
  close: () => void;
}

export function selectionInfoFrom(s: SessionSnapshot): SelectionInfo {
  return { activeFrameId: s.activeFrameId, frameIds: s.selectedFrameIds, clipIds: s.selectedClipIds };
}

export async function handlePluginCall(deps: BridgeDeps, method: string, params: unknown): Promise<unknown> {
  const cap = METHOD_CAPABILITY[method];
  if (cap === undefined) throw new Error(`Unknown method “${method}”.`);
  if (cap !== null && !deps.granted.includes(cap)) {
    throw new Error(`Not permitted: “${method}” needs the “${cap}” capability, which this plugin didn't request.`);
  }

  switch (method) {
    case "document.getInfo": {
      const d = deps.store.getState();
      // `fps` is the FOCUSED comp's rate — there is no project-wide one (see DocInfo).
      const focused = activeCompId(d, deps.getSession().activeFrameId);
      const info: DocInfo = {
        id: d.id,
        name: d.name,
        fps: compFps(d, focused),
        durationMs: d.durationMs,
        frameCount: d.frames.length,
      };
      return info;
    }
    case "selection.get":
      return selectionInfoFrom(deps.getSession());
    case "document.insertText":
      return insertText(deps, params);
    case "ui.notify": {
      const p = (params ?? {}) as { message?: unknown; level?: unknown };
      deps.notify(String(p.message ?? ""), normalizeLevel(p.level));
      return null;
    }
    case "ui.resize": {
      const p = (params ?? {}) as { width?: unknown; height?: unknown };
      deps.resize(clampDim(p.width), clampDim(p.height));
      return null;
    }
    case "ui.close":
      deps.close();
      return null;
    default:
      throw new Error(`Unknown method “${method}”.`);
  }
}

function insertText(deps: BridgeDeps, params: unknown): { clipId: string } {
  const p = (params ?? {}) as { text?: unknown; x?: unknown; y?: unknown; fontSize?: unknown; color?: unknown };
  const text = typeof p.text === "string" ? p.text : "";
  if (!text.trim()) throw new Error("insertText needs a non-empty `text`.");

  const s = deps.getSession();
  const doc = deps.store.getState();
  const frameId = s.activeFrameId ?? doc.frames[0]?.id ?? null;
  if (!frameId) throw new Error("There's no frame to insert into.");

  const style: Partial<TextStyle> = {};
  if (typeof p.fontSize === "number" && p.fontSize > 0) style.fontSize = p.fontSize;
  if (typeof p.color === "string") style.color = p.color;

  const clip = createTextClip({
    frameId,
    text,
    startMs: Math.max(0, Math.round(s.playheadMs)),
    presetId: null,
    x: typeof p.x === "number" ? p.x : 0,
    y: typeof p.y === "number" ? p.y : 0,
    style,
  });
  deps.store.update("Insert text (plugin)", (d) => placeClip(d, clip));
  return { clipId: clip.id };
}

function normalizeLevel(level: unknown): NotifyLevel | undefined {
  return level === "success" || level === "warning" || level === "error" || level === "info" ? level : undefined;
}

function clampDim(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(120, Math.min(2400, Math.round(n))) : 0;
}
