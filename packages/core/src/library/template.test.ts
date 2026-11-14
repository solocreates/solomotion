import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import "../index";
import { BUILTIN_TEMPLATES } from "@solomotion/templates";
import { runSpeechEngine, type SynthesisResult } from "@solomotion/lipsync";
import { createCommandApi, defineCommand } from "../api";
import { createId } from "../ids";
import { installSpeechReader } from "../speech/reader";
import { poseEnvAt, resolvedDocAt } from "../evaluate/resolved-doc";
import { evaluateWorld } from "../world/evaluate";
import { getClipProperty } from "../animation/paths";
import { clipLookup } from "../timeline/frame-index";
import { parseDocument, serializeDocument } from "../io";
import { createEmptyDocument } from "../factories";
import { choosePose, poseSetLiveSource } from "../rig/pose-choice";
import { poseSetMixAt, resolvePose } from "../rig/poses";
import { characterLanes } from "../rig/character-lanes";
import { decide2d, memberOf } from "../rig/bind";
import { evaluateRig } from "../rig/pose";
import { clipsUnderGroup } from "../timeline/groups";
import { poseSetSubjects } from "../rig/pose-ops";
import { buildTemplateDocument, builtinTemplateItems, instantiateTemplate, type TemplateSource } from "./template";
import { makeComponent } from "../components";
import { createDocumentStore } from "../history/document-store";
import { duplicatePoseDrawing, poseDrawingOf, poseSetFromLayer } from "../rig/pose-ops";
import { localLibrary } from "./catalog";
import type { MotionDocument, Clip, GroupClip } from "../schema";

/**
 * THE FINAL TEST OF CHARACTERS 2.0 — the built-in "Talking Characters"
 * template, built the way the app builds it: its own build script, run
 * through the command registry in-process, with the Test Voice standing in
 * for the host's `generate.speech` exactly as the app's verb does (offline,
 * exact cues installed as the asset's track). Then the result is EVALUATED
 * the way the canvas draws it: Pip's mouth follows the voice, he blinks, his
 * hand machine waves then talks; Orbit's 3D mouth follows the same line.
 */

const tracks = new Map<string, SynthesisResult>();
installSpeechReader((assetId) => tracks.get(assetId) ?? null);
afterAll(() => installSpeechReader(null));

/** The app's Test Voice, as a core-only verb: synthesize, add the asset, install its exact track, place it. */
function testVoiceApi() {
  const api = createCommandApi();
  api.register(
    defineCommand({
      id: "generate.speech",
      summary: "Test Voice (test stand-in for the host verb).",
      effect: "write",
      input: z.object({
        text: z.string(),
        voice: z.string().optional(),
        place: z.object({ frameId: z.string().optional(), startMs: z.number().optional() }).optional(),
      }),
      async run(input, rt) {
        const line = (await runSpeechEngine("test-voice", { text: input.text }, { preset: "warm" })) as SynthesisResult;
        const assetId = createId("asset");
        tracks.set(assetId, line);
        rt.write("Add voice", (d) => {
          d.assets.push({ id: assetId, kind: "audio", name: "Test Voice.wav", mime: "audio/wav", bytes: 1, width: null, height: null, durationMs: Math.ceil(line.durationMs), fps: null, folderId: null, origin: null });
        });
        let clipId: string | undefined;
        if (input.place) {
          const res = await api.call("layer.create", { kind: "media", assetId, ...input.place }, rt);
          if (!res.ok) throw new Error(res.error);
          clipId = (res.value as { id: string }).id;
        }
        return { assetId, durationMs: Math.ceil(line.durationMs), clipId };
      },
    }),
  );
  return api;
}

const source = (BUILTIN_TEMPLATES as readonly TemplateSource[]).find((t) => t.id === "talking-characters")!;
const SAMPLES = Array.from({ length: 70 }, (_, i) => i * 100);

const locateClipOf = (doc: MotionDocument, id: string) => doc.tracks.flatMap((t) => t.clips).find((c) => c.id === id) as Exclude<Clip, { kind: "audio" }> | undefined;
const byName = (doc: MotionDocument, frameId: string, name: string): Clip =>
  doc.tracks.flatMap((t) => t.clips).find((c) => c.frameId === frameId && c.name === name)!;

let built: Awaited<ReturnType<typeof buildTemplateDocument>> | null = null;
async function build() {
  built ??= await buildTemplateDocument(source, { api: testVoiceApi() });
  return built;
}

describe("Talking Characters — the built-in template", () => {
  it("ships as a library item that draws itself", () => {
    const items = localLibrary({ doc: createEmptyDocument(), templates: [source] }).filter((i) => i.kind === "template");
    expect(items).toEqual(builtinTemplateItems([source]));
    expect(items[0]).toMatchObject({ source: "builtin", preview: { type: "render" }, action: { type: "template", templateId: "talking-characters" } });
  });

  it("builds a valid project from its own script, carrying that script", async () => {
    const { doc, logs } = await build();
    expect(() => parseDocument(serializeDocument(doc))).not.toThrow();
    expect(doc.frames.map((f) => f.name)).toEqual(["Pip", "Orbit", "Title"]);
    // Side by side on the page, never stacked on one another.
    const xs = doc.frames.map((f) => [f.x, f.x + f.width] as const).sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < xs.length; i++) expect(xs[i]![0]).toBeGreaterThanOrEqual(xs[i - 1]![1]);
    const entry = doc.scripts.find((s) => s.name === "build.js")!;
    expect(entry.source).toContain("character.bringToLife");
    expect(entry.output.frameIds.length + entry.output.clipIds.length).toBeGreaterThan(0);
    expect(logs.join("\n")).toMatch(/Pip: .*mouth/);
  }, 60_000);

  it("Pip lives: talks with the voice, blinks, waves then talks with his hand", async () => {
    const { doc } = await build();
    const pip = doc.frames.find((f) => f.name === "Pip")!.id;
    const mouth = byName(doc, pip, "Mouth").id;
    const eyeL = byName(doc, pip, "Eye.L").id;
    const handL = byName(doc, pip, "Hand.L").id;
    const at = (t: number) => clipLookup(resolvedDocAt(doc, t, pip));
    const mouths = SAMPLES.map((t) => getClipProperty(at(t)(mouth) as Clip, "switch"));
    expect(new Set(mouths).size).toBeGreaterThan(4); // it really talks
    expect(mouths[0]).toBe("X"); // silent before the line
    const eyes = Array.from({ length: 200 }, (_, i) => getClipProperty(at(i * 33)(eyeL) as Clip, "switch"));
    expect(eyes).toContain("Closed");
    expect(eyes.filter((e) => e === "Open").length).toBeGreaterThan(150);
    const hands = SAMPLES.map((t) => getClipProperty(at(t)(handL) as Clip, "switch"));
    expect(hands[3]).toBe("Wave");
    expect(hands).toContain("Open");
    // The wave lifts the arm: the upper-arm bone turns while waving.
    const rigId = byName(doc, pip, "Pip").id;
    const upper = (doc.tracks.flatMap((t) => t.clips).find((c) => c.id === rigId) as GroupClip).rig!.bones.find((b) => b.name === "UpperArm.L")!.id;
    expect(Number(getClipProperty(at(600)(rigId) as Clip, `bone.${upper}.rotation`))).toBeLessThan(-60);
    // One skeleton: the eyes and their target hang off Body, so dragging or
    // posing the character carries its gaze (separate roots stayed behind).
    const bones = (doc.tracks.flatMap((t) => t.clips).find((c) => c.id === rigId) as GroupClip).rig!.bones;
    const body = bones.find((b) => b.name === "Body")!.id;
    for (const n of ["Pupil.L", "Pupil.R", "Look"]) expect(bones.find((b) => b.name === n)?.parent, n).toBe(body);
  }, 60_000);

  it("choosing a pose on a live set never silently does nothing", async () => {
    const { doc } = await build();
    const pip = doc.frames.find((f) => f.name === "Pip")!.id;
    const group = byName(doc, pip, "Pip") as GroupClip;
    const setNamed = (n: string) => group.poses!.find((s) => s.name === n)!;
    const mouthLayer = byName(doc, pip, "Mouth").id;
    // Lip-synced mouth: the click FIXES the syllable under the playhead.
    const t = SAMPLES.find((ms) => ms > 600 && getClipProperty(clipLookup(resolvedDocAt(doc, ms, pip))(mouthLayer) as Clip, "switch") !== "O")!;
    const draft = structuredClone(doc);
    const g = clipLookup(draft)(group.id) as GroupClip;
    const r = choosePose(draft, g, g.poses!.find((s) => s.name === "Mouth")!, "O", t);
    expect(r.kind).toBe("fixed");
    expect(getClipProperty(clipLookup(resolvedDocAt(draft, t, pip))(mouthLayer) as Clip, "switch")).toBe("O");
    // The eyes' blink rides on their own choice (`#value`): the pick keys it, and it shows.
    expect(poseSetLiveSource(doc, group, setNamed("Eyes"))).toBeNull();
    expect(choosePose(draft, g, g.poses!.find((s) => s.name === "Eyes")!, "Closed", t)).toEqual({ kind: "keyed" });
    const eyes = g.poses!.find((s) => s.name === "Eyes")!;
    expect(resolvePose(eyes, eyes.show)?.name).toBe("Closed");
    // Before the voice starts nothing live speaks: the pick is yours, a key.
    expect(choosePose(draft, g, g.poses!.find((s) => s.name === "Mouth")!, "O", 0, { record: true })).toEqual({ kind: "keyed" });
  }, 60_000);

  it("a pose tile frames what its set changes — the eyes, the waving arm — not the whole character", async () => {
    const { doc } = await build();
    const pip = doc.frames.find((f) => f.name === "Pip")!.id;
    const group = byName(doc, pip, "Pip") as GroupClip;
    const names = (set: string) => poseSetSubjects(doc, group.id, group.poses!.find((s) => s.name === set)!.id).map((id) => clipLookup(doc)(id)!.name).sort();
    expect(names("Eyes")).toEqual(["Eye.L", "Eye.R"]);
    const hand = names(group.poses!.find((s) => /hand/i.test(s.name) && /l/i.test(s.name))!.name);
    // The hand drawings and the arm the wave turns — never the body.
    expect(hand).toEqual(expect.arrayContaining(["Hand.L"]));
    expect(hand).not.toContain("Torso");
  }, 60_000);

  it("the timeline's pose lanes say exactly what the canvas shows, every frame", async () => {
    const { doc } = await build();
    const pip = doc.frames.find((f) => f.name === "Pip")!.id;
    const group = byName(doc, pip, "Pip") as GroupClip;
    const lanes = characterLanes(doc, group.id, undefined, (t) => poseEnvAt(doc, t, pip));
    expect(lanes.map((l) => l.name)).toEqual(group.poses!.map((s) => s.name));
    const mouth = lanes.find((l) => l.name === "Mouth")!;
    expect(mouth.mode).toBe("live");
    expect(new Set(mouth.blocks.map((b) => b.name)).size).toBeGreaterThan(3);
    for (const lane of lanes) {
      const set = group.poses!.find((s) => s.id === lane.setId)!;
      for (const t of SAMPLES) {
        if (t < group.startMs || t >= group.startMs + group.durationMs) continue;
        const block = lane.blocks.find((b) => t >= b.fromMs && t < b.toMs);
        const overlay = lane.overlays.find((b) => t >= b.fromMs && t < b.toMs);
        const shown = poseSetMixAt(doc, group, set, t, poseEnvAt(doc, t, pip))!.target;
        expect((overlay ?? block)?.poseId, `${lane.name} at ${t}`).toBe(shown);
      }
    }
  }, 60_000);

  it("the face rides the body — a cheek never follows an arm", async () => {
    const { doc } = await build();
    const pip = doc.frames.find((f) => f.name === "Pip")!.id;
    const g = byName(doc, pip, "Pip") as GroupClip;
    const pose = evaluateRig(g.rig!, { planar: true });
    const rides = (name: string) => {
      const id = byName(doc, pip, name).id;
      const d = decide2d(doc, memberOf(doc, id)!, pose);
      return g.rig!.bones.find((b) => b.id === d.bone)?.name;
    };
    // Each cheek sits where a raised arm's bone begins; auto-binding put it on the arm.
    for (const n of ["Cheek.L", "Cheek.R", "Mouth", "Eye.L", "Brow.R", "Stem"]) expect(rides(n), n).toBe("Body");
    expect(rides("Pupil.L")).toBe("Pupil.L");
    expect(clipsUnderGroup(doc, g.id).length).toBeGreaterThan(10);
  }, 60_000);

  it("Orbit's 3D mouth says the same line", async () => {
    const { doc } = await build();
    const orbit = doc.frames.find((f) => f.name === "Orbit")!;
    const head = doc.tracks.flatMap((t) => t.clips).find((c) => c.frameId === orbit.id && c.kind === "mesh" && (c.shapeKeys?.length ?? 0) > 0)!;
    const weightsAt = (t: number) => {
      const baked = resolvedDocAt(doc, t, orbit.id);
      const obj = evaluateWorld(baked, orbit, t).objects.find((o) => o.id === head.id)!;
      const c = obj.clip as Clip & { shapeKeys?: Array<{ id: string }> };
      return (c.shapeKeys ?? []).map((k) => Number(getClipProperty(clipLookup(baked)(head.id) as Clip, `key.${k.id}`) ?? 0));
    };
    const weights = SAMPLES.map((t) => weightsAt(t));
    const sums = weights.map((w) => w.reduce((a, b) => a + b, 0));
    expect(Math.max(...sums)).toBeGreaterThan(0.3);
    // The mouth makes many different shapes (the key that leads), not one opening and closing.
    const leads = weights.filter((w) => Math.max(...w) > 0.3).map((w) => w.indexOf(Math.max(...w)));
    expect(new Set(leads).size).toBeGreaterThan(4);
  }, 60_000);

  it("New from template: every id fresh, nothing shared with the source", async () => {
    const { doc } = await build();
    const { doc: copy, assetIdMap } = instantiateTemplate(doc, { ns: "studio", name: "My talking scene" });
    expect(copy.name).toBe("My talking scene");
    expect(() => parseDocument(serializeDocument(copy))).not.toThrow();
    const ids = (d: MotionDocument) => new Set([d.id, ...d.frames.map((f) => f.id), ...d.tracks.flatMap((t) => [t.id, ...t.clips.map((c) => c.id)]), ...d.assets.map((a) => a.id)]);
    const before = ids(doc);
    for (const id of ids(copy)) expect(before.has(id)).toBe(false);
    expect(Object.keys(assetIdMap)).toEqual(doc.assets.map((a) => a.id));
    // References follow: the copy's mouth still talks.
    const pip = copy.frames.find((f) => f.name === "Pip")!.id;
    const mouth = byName(copy, pip, "Mouth").id;
    for (const [from, to] of Object.entries(assetIdMap)) tracks.set(to, tracks.get(from)!);
    const said = SAMPLES.map((t) => getClipProperty(clipLookup(resolvedDocAt(copy, t, pip))(mouth) as Clip, "switch"));
    expect(new Set(said).size).toBeGreaterThan(4);
  }, 60_000);

  it("each character becomes a component without moving — 2D and 3D alike", async () => {
    const { doc: built } = await build();
    const doc = structuredClone(built);
    const orbit = doc.frames.find((f) => f.name === "Orbit")!;
    const pip = doc.frames.find((f) => f.name === "Pip")!;
    const skin = byName(doc, orbit.id, "Skin");
    const where = (d: MotionDocument, id: string, t = 1200) => {
      const o = evaluateWorld(resolvedDocAt(d, t, orbit.id), orbit, t).objects.find((x) => x.id === id || x.id.endsWith(`/${id}`));
      return o ? [o.matrix[12], o.matrix[13], o.matrix[14]].map((v) => Math.round(v!)) : null;
    };
    const before = where(doc, skin.id);
    const pipGroup = doc.tracks.flatMap((t) => t.clips).find((c) => c.frameId === pip.id && c.kind === "group" && c.name === "Pip") as GroupClip;
    const roots0 = pipGroup.rig!.bones.filter((b) => !b.parent).map((b) => [b.rest.x, b.rest.y]);
    const mouth0 = byName(doc, pip.id, "Mouth") as Exclude<Clip, { kind: "audio" }>;
    const placed0 = [mouth0.transform.x + pipGroup.transform.x, mouth0.transform.y + pipGroup.transform.y];
    const orbitGroup = doc.tracks.flatMap((t) => t.clips).find((c) => c.frameId === orbit.id && c.kind === "group" && c.name === "Orbit")!;
    const edited = structuredClone(doc); // a fresh identity: resolutions are memoised per document
    const o = makeComponent(edited, [orbitGroup.id])!;
    const p = makeComponent(edited, [pipGroup.id])!;
    // 3D: a world of its own, instanced in Orbit's world as objects — where they stood.
    expect(edited.frames.find((f) => f.id === o.frameId)!.world).toBeTruthy();
    expect(where(edited, skin.id)).toEqual(before);
    const objs = evaluateWorld(resolvedDocAt(edited, 1200, orbit.id), orbit, 1200).objects;
    expect(objs.some((x) => x.id === `${o.clipId}/${skin.id}` && x.instanceOf === skin.id)).toBe(true);
    expect(objs.filter((x) => x.kind === "camera")).toHaveLength(1); // the host's camera alone
    // …and it still looks at the face it was aimed at, now inside the instance.
    const cam0 = evaluateWorld(resolvedDocAt(doc, 1200, orbit.id), orbit, 1200).objects.find((x) => x.kind === "camera")!;
    const cam1 = objs.find((x) => x.kind === "camera")!;
    expect(cam1.matrix.map((v) => Math.round(v * 100))).toEqual(cam0.matrix.map((v) => Math.round(v * 100)));
    // The component's own world brought a lens and light with it, for its own picture.
    const own = evaluateWorld(resolvedDocAt(edited, 1200, o.frameId), edited.frames.find((f) => f.id === o.frameId)!, 1200).objects;
    expect(own.some((x) => x.kind === "camera") && own.some((x) => x.kind === "light")).toBe(true);
    // 2D: a character's comp is the frame it lived in — its rig carries it anywhere in there.
    const pipComp = edited.frames.find((f) => f.id === p.frameId)!;
    expect([pipComp.width, pipComp.height]).toEqual([pip.width, pip.height]);
    // The rig moved with its art — root bones shifted by exactly the instance's offset.
    const inst = locateClipOf(edited, p.clipId)!;
    const moved = (locateClipOf(edited, pipGroup.id) as GroupClip).rig!.bones.filter((b) => !b.parent).map((b) => [b.rest.x + inst.transform.x, b.rest.y + inst.transform.y]);
    expect(moved).toEqual(roots0);
    // …and the art with it, once: a leaf plus its group's delta plus the instance's offset is where it stood.
    const mouth1 = locateClipOf(edited, mouth0.id)!;
    const g1 = locateClipOf(edited, pipGroup.id)!;
    expect([mouth1.transform.x + g1.transform.x + inst.transform.x, mouth1.transform.y + g1.transform.y + inst.transform.y]).toEqual(placed0);
  }, 60_000);

  it("a pose's drawing is a layer you can edit, or copy into a new pose; any layer can become a part", async () => {
    const { doc: built } = await build();
    const store = createDocumentStore(structuredClone(built));
    const pipFrame = store.getState().frames.find((f) => f.name === "Pip")!;
    const g = store.getState().tracks.flatMap((t) => t.clips).find((c) => c.frameId === pipFrame.id && c.kind === "group" && c.name === "Pip") as GroupClip;
    const hands = g.poses!.find((s) => s.name === "Left hand")!;
    const fist = hands.poses.find((p) => p.name === "Fist")!;
    const drawing = poseDrawingOf(store.getState(), g.id, hands.id, fist.id)!;
    expect(drawing).toBeTruthy();
    // Inside an edit (a draft), as the app does it.
    let made: ReturnType<typeof duplicatePoseDrawing> = null;
    store.update("Duplicate drawing", (d) => void (made = duplicatePoseDrawing(d, g.id, hands.id, fist.id)));
    const after = store.getState();
    const set2 = (locateClipOf(after, g.id) as GroupClip).poses!.find((s) => s.id === hands.id)!;
    const copy = set2.poses.find((p) => p.id === made!.poseId)!;
    expect(copy.name).not.toBe("Fist");
    expect(poseDrawingOf(after, g.id, hands.id, copy.id)!.memberId).toBe(made!.memberId);
    expect(made!.memberId).not.toBe(drawing.memberId);
    // The copy is a member of the same switch; the original is untouched.
    expect(poseDrawingOf(after, g.id, hands.id, fist.id)!.memberId).toBe(drawing.memberId);
    const stem = after.tracks.flatMap((t) => t.clips).find((c) => c.frameId === pipFrame.id && c.name === "Stem")!;
    let setId: string | null = null;
    store.update("Part from layer", (d) => void (setId = poseSetFromLayer(d, g.id, stem.id)));
    const part = (locateClipOf(store.getState(), g.id) as GroupClip).poses!.find((s) => s.id === setId)!;
    expect(part).toMatchObject({ name: "Stem", part: stem.id });
    expect(part.poses.map((p) => p.name)).toEqual(["Rest"]);
  }, 60_000);

  it("builds without a voice where there is no speech verb (the poster path)", async () => {
    const { doc, logs } = await buildTemplateDocument(source);
    expect(doc.frames.map((f) => f.name)).toEqual(["Pip", "Orbit", "Title"]);
    expect(logs.join("\n")).toMatch(/without a voice/);
  }, 60_000);
});
