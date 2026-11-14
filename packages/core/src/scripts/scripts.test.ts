import { describe, expect, it } from "vitest";
import { createDocumentStore } from "../history/document-store";
import { createEmptyDocument } from "../factories";
import { createCommandApi, type CommandContext } from "../api";
import { locateClip } from "../timeline/ops";
import { SKILL_FILES } from "@solomotion/skill";
import { ALL_SECTIONS, BRIEF_FOCUSES, scriptHere, briefSections, clearScriptOutput, composeBrief, createdSince, docIds, findScript, focusSelection, saveScript, scriptLocation, scriptPath } from ".";

function harness() {
  const store = createDocumentStore(createEmptyDocument("Test"));
  const api = createCommandApi();
  const ctx: CommandContext = {
    store,
    actor: "Script",
    session: { focusFrameId: () => store.getState().frames[0]?.id ?? null, playheadMs: () => 0, selection: () => [] },
  };
  const call = async (id: string, input: unknown = {}) => {
    const res = await api.call(id, input, ctx);
    if (!res.ok) throw new Error(`${id}: ${res.error}`);
    return res.value as Record<string, unknown>;
  };
  return { store, api, call };
}

describe("script files", () => {
  it("saves by path, creates folders, overwrites in place and finds by path, name or id", async () => {
    const { store, call } = harness();
    const a = await call("script.save", { path: "intro/title", source: "1" });
    expect(a.path).toBe("intro/title.js");
    await call("script.save", { path: "intro/title.js", source: "2" });
    const doc = store.getState();
    expect(doc.scripts).toHaveLength(1);
    expect(doc.scriptFolders.map((f) => f.name)).toEqual(["intro"]);
    expect(findScript(doc, "title")?.source).toBe("2");
    expect(findScript(doc, a.id as string)?.source).toBe("2");
    const read = await call("script.read", { script: "intro/title.js" });
    expect(read.source).toBe("2");
  });

  it("refuses an ambiguous bare name and keeps sibling names unique", () => {
    const store = createDocumentStore(createEmptyDocument("Test"));
    store.update("x", (d) => {
      saveScript(d, "a/scene.js", "");
      saveScript(d, "b/scene.js", "");
    });
    const doc = store.getState();
    expect(findScript(doc, "scene.js")).toBeUndefined();
    expect(doc.scripts.map((s) => scriptPath(doc, s))).toEqual(["a/scene.js", "b/scene.js"]);
  });
});

describe("script output", () => {
  it("records only the roots a run created, and a re-run takes exactly those back", async () => {
    const { store, call } = harness();
    const keep = await call("layer.create", { kind: "shape", shape: "rect", width: 10, height: 10 });

    const before = docIds(store.getState());
    const a = await call("layer.create", { kind: "shape", shape: "rect", width: 20, height: 20 });
    const b = await call("layer.create", { kind: "shape", shape: "ellipse", width: 20, height: 20 });
    const { groupId } = (await call("layers.group", { ids: [a.id, b.id], name: "Pair" })) as { groupId: string };
    const loose = await call("layer.create", { kind: "shape", shape: "rect", width: 5, height: 5 });
    const comp = await call("frame.create", { name: "Extra", width: 100, height: 100 });

    const output = createdSince(before, store.getState());
    expect(output.clipIds.sort()).toEqual([groupId, loose.id].sort());
    expect(output.frameIds).toEqual([comp.id]);

    let cleared = { layers: 0, comps: 0 };
    store.update("clear", (d) => {
      cleared = clearScriptOutput(d, output);
    });
    const doc = store.getState();
    expect(cleared).toEqual({ layers: 2, comps: 1, kept: [] });
    expect(locateClip(doc, keep.id as string)).toBeTruthy();
    for (const id of [a.id, b.id, groupId, loose.id]) expect(locateClip(doc, id as string)).toBeFalsy();
    expect(doc.frames.some((f) => f.id === comp.id)).toBe(false);
  });

  it("skips what the person already deleted", async () => {
    const { store, call } = harness();
    const before = docIds(store.getState());
    const a = await call("layer.create", { kind: "shape", shape: "rect", width: 20, height: 20 });
    const output = createdSince(before, store.getState());
    await call("layers.delete", { ids: [a.id] });
    let cleared = { layers: -1, comps: -1 };
    store.update("clear", (d) => {
      cleared = clearScriptOutput(d, output);
    });
    expect(cleared).toEqual({ layers: 0, comps: 0, kept: [] });
  });
});

describe("script errors", () => {
  it("maps an engine frame back to the person's line", () => {
    const v8 = "Error: no\n    at layer (main.js:7:11)\n    at async main.js:9:3";
    expect(scriptLocation(v8, "main.js", 2)).toEqual({ line: 5, column: 11 });
    expect(scriptLocation("@main.js:3:1", "main.js", 0)).toEqual({ line: 3, column: 1 });
    expect(scriptLocation("at x (other.js:3:1)", "main.js", 2)).toBeNull();
    expect(scriptLocation("at main.js:1:1", "main.js", 2)).toBeNull();
  });
});

describe("script brief", () => {
  const sources = () => {
    const { api, store } = harness();
    return { appName: "Studio", registry: api, doc: store.getState(), focusFrameId: null, skill: SKILL_FILES };
  };

  it("derives sections from the skill, the catalogs and the registry, and leaves out what would recurse", () => {
    const sections = briefSections(sources());
    const ids = new Set(sections.map((s) => s.id));
    for (const id of ["rules", "project", "skill:SKILL.md", "skill:references/motion.md", "catalog:animations", "api:layer"]) expect(ids).toContain(id);
    expect(ids).not.toContain("skill:references/reporting.md");
    const api = sections.filter((s) => s.group === "api").map((s) => s.text).join("\n");
    expect(api).toContain("ac.layer.create(");
    expect(api).not.toContain("ac.api.batch(");
    expect(sections.find((s) => s.id === "catalog:animations")!.text).toContain("`fade-up`");
    // The names a chatbox guesses wrong without the list (`scaleX`).
    expect(sections.find((s) => s.id === "catalog:properties")!.text).toMatch(/`scale` Scale X .*`scaleY` Scale Y/);
  });

  it("always includes the rules, and puts the task context last", () => {
    const sections = briefSections(sources());
    const brief = composeBrief(sections, new Set(["project", "skill:references/motion.md"]), "Studio");
    expect(brief).toContain("# Scripts");
    expect(brief.indexOf("## This project")).toBeGreaterThan(brief.indexOf("# Motion"));
  });

  it("Everything expands to every section", () => {
    const ids = briefSections(sources()).map((s) => s.id);
    const all = focusSelection("all", [], ids);
    for (const id of ids) expect(all).toContain(id);
  });

  it("every focus names sections that exist", () => {
    const ids = new Set(briefSections(sources()).map((s) => s.id));
    // Verbs only the running editor registers; they exist there, not in a bare core registry.
    const host = new Set(["api:view", "api:sounds", "api:generate", "api:voices", "api:media", "api:font", "api:session", "api:app"]);
    const optional = new Set(["file", "run"]);
    for (const focus of BRIEF_FOCUSES) {
      for (const id of focusSelection(focus.id)) {
        if (id === ALL_SECTIONS) continue;
        if (host.has(id) || optional.has(id)) continue;
        expect(ids, `${focus.id} → ${id}`).toContain(id);
      }
    }
  });
});

describe("here", () => {
  it("is the focused comp, else the first visible one — the same comp a frameId-less call lands in", async () => {
    const { store, call } = harness();
    const extra = await call("frame.create", { name: "Extra", width: 400, height: 300 });
    const doc = store.getState();
    expect(scriptHere(doc, extra.id as string)).toMatchObject({ frameId: extra.id, name: "Extra", width: 400, height: 300 });
    expect(scriptHere(doc, "gone")?.frameId).toBe(doc.frames[0]!.id);
  });
});
