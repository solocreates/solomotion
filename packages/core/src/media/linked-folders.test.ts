import { describe, expect, it } from "vitest";
import {
  applyLinkedDiff,
  diffLinkedFolder,
  removedRelPaths,
  type ScannedFile,
} from "./linked-folders";
import type { LinkedFolder } from "../schema/assets";

const file = (relPath: string, mtimeMs: number, size: number): ScannedFile => ({ relPath, mtimeMs, size });

describe("diffLinkedFolder", () => {
  it("treats every file as added against an empty index", () => {
    const diff = diffLinkedFolder({}, [file("a.png", 1, 10), file("sub/b.mp4", 2, 20)]);
    expect(diff.added.map((f) => f.relPath)).toEqual(["a.png", "sub/b.mp4"]);
    expect(diff.changed).toEqual([]);
    expect(diff.removedAssetIds).toEqual([]);
    expect(diff.unchanged).toBe(0);
  });

  it("re-syncing an unchanged folder is a no-op", () => {
    const index: LinkedFolder["index"] = { "a.png": { assetId: "A", mtimeMs: 1, size: 10 } };
    const diff = diffLinkedFolder(index, [file("a.png", 1, 10)]);
    expect(diff.added).toEqual([]);
    expect(diff.changed).toEqual([]);
    expect(diff.removedAssetIds).toEqual([]);
    expect(diff.unchanged).toBe(1);
  });

  it("detects a changed file by mtime or size and keeps its asset id", () => {
    const index: LinkedFolder["index"] = {
      "a.png": { assetId: "A", mtimeMs: 1, size: 10 },
      "b.png": { assetId: "B", mtimeMs: 5, size: 50 },
    };
    const diff = diffLinkedFolder(index, [file("a.png", 9, 10), file("b.png", 5, 999)]);
    expect(diff.changed).toEqual([
      { relPath: "a.png", mtimeMs: 9, size: 10, assetId: "A" },
      { relPath: "b.png", mtimeMs: 5, size: 999, assetId: "B" },
    ]);
    expect(diff.added).toEqual([]);
  });

  it("reports assets whose file vanished from disk", () => {
    const index: LinkedFolder["index"] = {
      "a.png": { assetId: "A", mtimeMs: 1, size: 10 },
      "gone.png": { assetId: "G", mtimeMs: 2, size: 20 },
    };
    const diff = diffLinkedFolder(index, [file("a.png", 1, 10)]);
    expect(diff.removedAssetIds).toEqual(["G"]);
    expect(diff.unchanged).toBe(1);
  });
});

describe("applyLinkedDiff / removedRelPaths", () => {
  it("folds imported files in and drops removed paths", () => {
    const index: LinkedFolder["index"] = {
      "a.png": { assetId: "A", mtimeMs: 1, size: 10 },
      "gone.png": { assetId: "G", mtimeMs: 2, size: 20 },
    };
    const scan = [file("a.png", 1, 10), file("new.png", 3, 30)];
    const removed = removedRelPaths(index, scan);
    expect(removed).toEqual(["gone.png"]);

    const next = applyLinkedDiff(
      index,
      [{ relPath: "new.png", assetId: "N", mtimeMs: 3, size: 30 }],
      removed,
    );
    expect(next).toEqual({
      "a.png": { assetId: "A", mtimeMs: 1, size: 10 },
      "new.png": { assetId: "N", mtimeMs: 3, size: 30 },
    });
  });

  it("updates an entry in place when a changed file re-imports onto its id", () => {
    const index: LinkedFolder["index"] = { "a.png": { assetId: "A", mtimeMs: 1, size: 10 } };
    const next = applyLinkedDiff(index, [{ relPath: "a.png", assetId: "A", mtimeMs: 9, size: 11 }], []);
    expect(next["a.png"]).toEqual({ assetId: "A", mtimeMs: 9, size: 11 });
  });
});
