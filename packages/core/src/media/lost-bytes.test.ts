import { describe, expect, it } from "vitest";
import { createAsset } from "../factories";
import type { Asset } from "../schema";
import { assetsLostAs } from "./lost-bytes";

const audio = (name: string, bytes: number, sha256?: string): Asset => ({
  ...createAsset({ kind: "audio", name, mime: "audio/mpeg", bytes }),
  ...(sha256 ? { sha256 } : {}),
});

const file = (name: string, bytes: number, sha256 = "f") => ({ kind: "audio" as const, name, bytes, sha256 });
const ids = (as: Asset[]) => as.map((a) => a.id);

describe("assetsLostAs", () => {
  it("heals every byte-less copy of a file lost more than once (the Particle Reel)", () => {
    // Three rounds of loss left three copies of the marimba; a renamed one and
    // another file of the very same size must not be taken for it.
    const renamed = audio("marimba", 17179);
    const a = audio("marimba-c5.mp3", 17179);
    const b = audio("marimba-c5.mp3", 17179);
    const c = audio("marimba-c5.mp3", 17179);
    const other = audio("glitter.mp3", 17179);
    const uses: Record<string, number> = { [c.id]: 1049, [a.id]: 3 };
    const got = assetsLostAs([renamed, a, b, c, other], file("marimba-c5.mp3", 17179), () => false, (id) => uses[id] ?? 0);
    expect(ids(got)).toEqual([c.id, a.id, b.id]);
  });

  it("trusts the fingerprint over the name", () => {
    const same = audio("take.wav", 100, "aa");
    const sameNameOtherBytes = audio("take.wav", 100, "bb");
    const renamed = audio("Intro VO", 100, "aa");
    expect(ids(assetsLostAs([same, sameNameOtherBytes, renamed], file("take.wav", 100, "aa"), () => false))).toEqual([same.id, renamed.id]);
  });

  it("keeps the old rule for one unclaimed byte-less asset, and refuses to guess between two", () => {
    const only = audio("Renamed sound", 50);
    expect(ids(assetsLostAs([only], file("hit.wav", 50), () => false))).toEqual([only.id]);
    expect(assetsLostAs([only, audio("Another", 50)], file("hit.wav", 50), () => false)).toEqual([]);
    // A fingerprinted asset of another file is not "the one candidate".
    expect(assetsLostAs([audio("x", 50, "zz")], file("hit.wav", 50, "aa"), () => false)).toEqual([]);
  });

  it("never touches an asset that still has its bytes, or another kind", () => {
    const present = audio("hit.wav", 50, "aa");
    const pic = { ...createAsset({ kind: "image", name: "hit.wav", mime: "image/png", bytes: 50 }), sha256: "aa" };
    expect(assetsLostAs([present, pic], file("hit.wav", 50, "aa"), (id) => id === present.id)).toEqual([]);
  });
});
