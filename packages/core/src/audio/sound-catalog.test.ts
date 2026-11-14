import { describe, expect, it } from "vitest";
import { createEmptyDocument, soundCatalog, soundOptionId, type DeviceSound } from "../index";

/**
 * The sound catalogue: the one answer to "what can this project play?". The
 * cases that matter are the collisions — the same bytes reachable from three
 * places must surface exactly once, under the name closest to the project.
 */
describe("soundCatalog", () => {
  const device: DeviceSound[] = [
    { id: "a1", name: "Device click", hitMs: 12, mime: "audio/wav", bytes: 100, durationMs: 200 },
  ];

  it("offers every synth pack, in schema order", () => {
    const packs = soundCatalog(createEmptyDocument()).filter((o) => o.group === "packs");
    expect(packs.map((p) => p.pack)).toEqual(["mechanical", "soft", "vintage", "thock", "digital", "pop", "marimba", "kalimba", "glass", "pluck", "wood"]);
    expect(packs.every((p) => !p.needsAdoption)).toBe(true);
  });

  it("surfaces device sounds and library audio, each needing adoption", () => {
    const doc = createEmptyDocument();
    doc.assets.push({
      id: "a2",
      kind: "audio",
      name: "Imported track",
      mime: "audio/mpeg",
      bytes: 900,
      width: null,
      height: null,
      durationMs: 4000,
      fps: null,
      folderId: null,
      origin: null,
    });
    const byId = new Map(soundCatalog(doc, device).map((o) => [o.id, o]));
    expect(byId.get("asset:a1")?.group).toBe("device");
    expect(byId.get("asset:a2")?.group).toBe("library");
    expect(byId.get("asset:a1")?.needsAdoption).toBe(true);
    expect(byId.get("asset:a2")?.needsAdoption).toBe(true);
  });

  it("lets an adopted sound win over its device and library twins", () => {
    const doc = createEmptyDocument();
    doc.assets.push({
      id: "a1",
      kind: "audio",
      name: "Raw file name",
      mime: "audio/wav",
      bytes: 100,
      width: null,
      height: null,
      durationMs: 200,
      fps: null,
      folderId: null,
      origin: null,
    });
    doc.customSounds.push({ id: "c1", name: "My click", assetId: "a1", hitMs: 40 });
    const matches = soundCatalog(doc, device).filter((o) => o.assetId === "a1");
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ group: "project", name: "My click", hitMs: 40, needsAdoption: false });
  });

  it("keys a voice to its option, pack or file", () => {
    expect(soundOptionId({ pack: "thock", custom: null })).toBe("pack:thock");
    expect(soundOptionId({ pack: "thock", custom: { assetId: "a9", hitMs: 0 } })).toBe("asset:a9");
  });
});
