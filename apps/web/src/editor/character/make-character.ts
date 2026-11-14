import { ENGINE } from "@/editor/names";
import {
  characterOf,
  clipBox,
  createCommandApi,
  createId,
  createShapeClip,
  groupClips,
  locateClip,
  makeCharacterStore,
  moveClipsToScope,
  placeClip,
  type AliveOptions,
  type MotionDocument,
  type CommandRegistry,
  type DocumentStore,
  type LifeBehavior,
} from "@solomotion/core";
import { toast } from "@/lib/toast";
import { editorApiSession, useSession } from "../state/session";
import { loadMouthPack, placeMouth } from "./mouth-pack";
import { setPosePreview } from "./pose-preview";

/**
 * MAKE CHARACTER, in the editor — the person's face of `character.bringToLife`
 * (core `rig/alive.ts`). Same verb an agent calls, through a registry of the
 * core verbs only (none of this needs a host verb), so the click and the call
 * cannot disagree. One undo step: `makeCharacterStore` folds every write in.
 */

let api: CommandRegistry | null = null;
const registry = () => (api ??= createCommandApi(ENGINE));
const ACTOR = "You";

/** Run the verb as one step. `store` may already be a `makeCharacterStore` (a host placed art first). */
async function run(store: DocumentStore, id: string, input: AliveOptions & { dryRun?: boolean }, label: string) {
  const grouped = makeCharacterStore(store, `character:${createId("run")}`, label);
  return registry().call("character.bringToLife", { id, ...input }, { store: grouped, actor: ACTOR, session: editorApiSession() });
}

/** Make character: select it, open its tab, blink once — the handshake. */
export async function makeCharacter(store: DocumentStore, id: string, placed?: DocumentStore, options: AliveOptions = {}): Promise<boolean> {
  const res = placed
    ? await registry().call("character.bringToLife", { id, ...options }, { store: placed, actor: ACTOR, session: editorApiSession() })
    : await run(store, id, options, "Make character");
  if (!res.ok) {
    toast.error(res.error);
    return false;
  }
  const session = useSession.getState();
  session.select([id]);
  session.setInspectorTab("character");
  handshake(store.getState(), id);
  const name = locateClip(store.getState(), id)?.clip.name ?? "It";
  toast(`${name} is a character — type a line to hear it`);
  return true;
}

/** One Life toggle — the same verb with one behavior set. */
export async function setLife(store: DocumentStore, id: string, behavior: LifeBehavior, on: boolean, extra: AliveOptions = {}): Promise<void> {
  const res = await run(store, id, { [behavior]: on, ...extra }, `${behavior[0]!.toUpperCase()}${behavior.slice(1)} ${on ? "on" : "off"}`);
  if (!res.ok) toast.error(res.error);
}

/** The 160 ms blink on the stage: a preview of the Eyes set's Closed pose — not a key, not playback. */
function handshake(doc: MotionDocument, id: string): void {
  const group = characterOf(doc, id);
  const set = group?.poses?.find((s) => s.vocabulary === "eyes");
  const closed = set?.poses.find((p) => p.name === "Closed");
  if (!group || !set || !closed) return;
  window.setTimeout(() => {
    setPosePreview({ groupId: group.id, setId: set.id, poseId: closed.id });
    window.setTimeout(() => setPosePreview(null), 160);
  }, 240);
}

// ── A flat picture: Click the mouth, Click each eye ──────────────────────────

export interface FlatPicks {
  mouth: { x: number; y: number };
  eyes: Array<{ x: number; y: number; colour?: string }>;
}

/**
 * Place a mouth and lids on a picture, group them with it and make the group
 * a character — one undo step. Points are in the picture's comp space.
 */
export async function makeFlatCharacter(store: DocumentStore, pictureId: string, picks: FlatPicks): Promise<boolean> {
  const pack = await loadMouthPack();
  const placed = makeCharacterStore(store, `character:${createId("run")}`, "Make character");
  let groupId: string | null = null;
  placed.update("Make character", (d) => {
    const pic = locateClip(d, pictureId)?.clip;
    if (!pic || pic.kind === "audio") return;
    const width = clipBox(d, pic).width * Math.abs(pic.transform.scale);
    const span = { frameId: pic.frameId, startMs: pic.startMs, durationMs: pic.durationMs };
    // A mouth about a quarter of the face.
    const mouth = placeMouth(d, pack, { ...span, ...picks.mouth, width: width * 0.26 });
    // Lids: skin-coloured ellipses over each eye; the character's left is the screen's right.
    const order = picks.eyes.slice().sort((a, b) => b.x - a.x);
    const lids: string[] = [];
    order.forEach((e, i) => {
      const lid = createShapeClip({ ...span, shape: "ellipse", x: e.x, y: e.y, width: width * 0.13, height: width * 0.09, fill: e.colour ?? "#e7b892", name: order.length === 1 ? "Lid" : i === 0 ? "Lid L" : "Lid R" });
      placeClip(d, lid, { landing: "surface" });
      lids.push(lid.id);
    });
    groupId = groupClips(d, [pictureId, ...(mouth ? [mouth] : []), ...lids], pic.name);
  });
  if (!groupId) return false;
  return makeCharacter(store, groupId, placed);
}

// ── Add a mouth ──────────────────────────────────────────────────────────────

/** A character with no mouth gets one where you clicked, and starts talking. One undo step. */
export async function addMouth(store: DocumentStore, characterId: string, at: { x: number; y: number }): Promise<boolean> {
  const pack = await loadMouthPack();
  const placed = makeCharacterStore(store, `character:${createId("run")}`, "Add mouth");
  let ok = false;
  placed.update("Add mouth", (d) => {
    const g = locateClip(d, characterId)?.clip;
    if (g?.kind !== "group") return;
    const width = clipBox(d, g).width * Math.abs(g.transform.scale);
    const mouth = placeMouth(d, pack, { frameId: g.frameId, startMs: g.startMs, durationMs: g.durationMs, ...at, width: Math.min(width * 0.26, 420) });
    if (!mouth) return;
    moveClipsToScope(d, [mouth], g.id);
    ok = true;
  });
  if (!ok) return false;
  const res = await registry().call("character.bringToLife", { id: characterId, talk: true }, { store: placed, actor: ACTOR, session: editorApiSession() });
  if (!res.ok) toast.error(res.error);
  useSession.getState().select([characterId]);
  return res.ok;
}

/**
 * A voice with no mouth in its comp: a mouth in the middle of the frame, made
 * a character that talks with THIS voice and does nothing else (a lone mouth
 * that breathes and nods reads as a bug). Selects it and opens its tab.
 */
export async function addMouthForVoice(store: DocumentStore, voiceId: string): Promise<boolean> {
  const pack = await loadMouthPack();
  const placed = makeCharacterStore(store, `character:${createId("run")}`, "Add mouth");
  let groupId: string | null = null;
  placed.update("Add mouth", (d) => {
    const voice = locateClip(d, voiceId)?.clip;
    const frame = voice ? d.frames.find((f) => f.id === voice.frameId) : undefined;
    if (!voice || !frame) return;
    const span = { frameId: frame.id, startMs: 0, durationMs: Math.max(voice.startMs + voice.durationMs, 1000) };
    const mouth = placeMouth(d, pack, { ...span, x: frame.width / 2, y: frame.height / 2, width: Math.min(frame.width, frame.height) * 0.28 });
    groupId = mouth ? groupClips(d, [mouth], `${voice.name} · mouth`) : null;
  });
  if (!groupId) return false;
  return makeCharacter(store, groupId, placed, { voice: voiceId, talk: true, blink: false, breathe: false, nod: false, look: false });
}
