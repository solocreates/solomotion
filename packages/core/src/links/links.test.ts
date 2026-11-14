import { describe, expect, it } from "vitest";
import type { Link, TextClip } from "../schema";
import { createEmptyDocument, createFrame, createShapeClip, createTextClip, createTrack } from "../factories";
import { createPage } from "../pages";
import { deleteFrame } from "../timeline/ops";
import { applyRangePatch, remapRangesAfterSplice } from "../text/ranges";
import { parseDocument } from "../io";
import { formatRoute, parseRoute, parseTimeParam, slugify, appPathOf } from "./address";
import { engineIdentity } from "../identity";

const APP = engineIdentity({ name: "Studio", ns: "studio", webOrigin: "https://app.example.com" });
import { formatLinkTarget, parseLinkTarget, pastedLinkTarget, safeHref } from "./target";
import { docLinks, linkClickIntent, linkForChain, linkSpans, locateProjectRoute, projectRouteFor, resolveLink } from "./resolve";
import { pdfLinkAction, pdfOutline, standaloneLinkHref } from "./pdf";

function project() {
  const doc = createEmptyDocument();
  const intro = doc.pages[0]!;
  intro.name = "Intro";
  const scenes = createPage("Scenes & Shots");
  doc.pages.push(scenes);
  const cover = doc.frames[0]!;
  cover.name = "Cover";
  const hero = createFrame({ name: "Hero", pageId: scenes.id });
  doc.frames.push(hero);
  const track = createTrack("Main");
  const button = createShapeClip({ frameId: cover.id, shape: "rect", startMs: 0, durationMs: 4000, x: 0, y: 0, width: 100, height: 40 });
  const title = createTextClip({ frameId: cover.id, text: "Read the docs now", startMs: 0 }) as TextClip;
  track.clips.push(button, title);
  doc.tracks.push(track);
  return { doc, intro, scenes, cover, hero, button, title };
}

const to = (node: string, t: number | null = null): Link => ({ target: { kind: "node", node: node as `frame:${string}`, t }, open: "auto" });

describe("the address grammar", () => {
  it("round-trips a deep link, keeping params it does not know", () => {
    const path = "/project/p_1/scenes-shots?at=frame:f_1,clip:c_2&t=1.5&cam=c_9";
    const route = parseRoute(path);
    expect(route).toEqual({ to: "project", projectId: "p_1", slug: "scenes-shots", at: ["frame:f_1", "clip:c_2"], t: 1500, params: { cam: "c_9" } });
    expect(formatRoute(route)).toBe(path);
    expect(parseRoute(formatRoute(route))).toEqual(route);
  });

  it("reads home, plugins, encoded keys and paths it does not know", () => {
    expect(parseRoute("/")).toEqual({ to: "home" });
    expect(parseRoute("/plugin/icons?q=arrow%20up")).toEqual({ to: "plugin", pluginId: "icons", params: { q: "arrow up" } });
    expect(parseRoute("/project/p?at=frame%3Af_1").to === "project" && parseRoute("/project/p?at=frame%3Af_1")).toMatchObject({ at: ["frame:f_1"] });
    expect(parseRoute("/community/plugins/x")).toEqual({ to: "unknown", path: "/community/plugins/x" });
    expect(formatRoute({ to: "plugin", pluginId: "icons", params: { q: "arrow up" } })).toBe("/plugin/icons?q=arrow%20up");
  });

  it("drops garbage keys rather than inventing nodes", () => {
    const r = parseRoute("/project/p?at=frame:a,nonsense,clip:b");
    expect(r.to === "project" && r.at).toEqual(["frame:a", "clip:b"]);
  });

  it("reads times the way people write them", () => {
    expect(parseTimeParam("12")).toBe(12000);
    expect(parseTimeParam("2.5")).toBe(2500);
    expect(parseTimeParam("1:30")).toBe(90000);
    expect(parseTimeParam("1m30s")).toBe(90000);
    expect(parseTimeParam("750ms")).toBe(750);
    expect(parseTimeParam("1h")).toBe(3600000);
    expect(parseTimeParam("soon")).toBeNull();
  });

  it("slugs every script and accepts this app's URLs in every spelling", () => {
    expect(slugify("Scenes & Shots!")).toBe("scenes-shots");
    expect(slugify("صفحه اول")).toBe("صفحه-اول");
    expect(slugify("Café")).toBe("cafe");
    expect(appPathOf("https://app.example.com/project/x?at=frame:y", APP)).toBe("/project/x?at=frame:y");
    expect(appPathOf("studio://project/x", APP)).toBe("/project/x");
    expect(appPathOf("http://localhost:3000/project/x", APP, ["http://localhost:3000"])).toBe("/project/x");
    expect(appPathOf("https://example.com/project/x", APP)).toBeNull();
  });
});

describe("link targets", () => {
  it("allows web, email and phone — and never a script", () => {
    expect(safeHref("example.com/a")).toBe("https://example.com/a");
    expect(safeHref("https://example.com")).toBe("https://example.com");
    expect(safeHref("hi@example.com")).toBe("mailto:hi@example.com");
    expect(safeHref("+1 (555) 010-0199")).toBe("tel:+15550100199");
    expect(safeHref("localhost:3000/x")).toBe("https://localhost:3000/x");
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("data:text/html,<b>")).toBeNull();
    expect(safeHref("just some words")).toBeNull();
  });

  it("turns this project's own URL into a node link, another's into a route", () => {
    expect(parseLinkTarget("https://app.example.com/project/me/intro?at=frame:f1&t=2", { projectId: "me", app: APP })).toEqual({ kind: "node", node: "frame:f1", t: 2000 });
    expect(parseLinkTarget("/project/other?at=frame:f1", { projectId: "me", app: APP })).toEqual({ kind: "route", path: "/project/other?at=frame:f1" });
    expect(parseLinkTarget("clip:c1@1.5")).toEqual({ kind: "node", node: "clip:c1", t: 1500 });
    expect(parseLinkTarget("javascript:void(0)")).toBeNull();
    for (const s of ["clip:c1@1.5", "https://example.com", "/plugin/icons"]) expect(formatLinkTarget(parseLinkTarget(s)!)).toBe(s);
  });

  it("links a paste over selected text only when the clipboard is one address", () => {
    expect(pastedLinkTarget(" https://example.com/a ")).toEqual({ kind: "url", href: "https://example.com/a" });
    expect(pastedLinkTarget("www.example.com")).toEqual({ kind: "url", href: "https://www.example.com" });
    expect(pastedLinkTarget("mailto:hi@example.com")).toEqual({ kind: "url", href: "mailto:hi@example.com" });
    expect(pastedLinkTarget("https://app.example.com/project/me?at=frame:f1", { projectId: "me", app: APP })).toEqual({ kind: "node", node: "frame:f1", t: null });
    // Prose, a bare domain, an email, a phone number, a script: pasted as text.
    for (const s of ["see https://example.com", "example.com", "hi@example.com", "+1 555 0100", "javascript:alert(1)", "hello"]) expect(pastedLinkTarget(s)).toBeNull();
  });

  it("refuses an unsafe href stored by someone else, at follow time too", () => {
    const { doc } = project();
    expect(resolveLink(doc, { target: { kind: "url", href: "javascript:alert(1)" }, open: "auto" }).kind).toBe("blocked");
  });
});

describe("the resolver", () => {
  it("opens external links in a new tab and in-project links here, unless told otherwise", () => {
    const p = project();
    expect(resolveLink(p.doc, { target: { kind: "url", href: "https://a.co" }, open: "auto" })).toMatchObject({ kind: "external", newTab: true });
    expect(resolveLink(p.doc, to(`frame:${p.hero.id}`))).toMatchObject({ kind: "node", newTab: false });
    expect(resolveLink(p.doc, { ...to(`frame:${p.hero.id}`), open: "new" })).toMatchObject({ newTab: true });
    expect(resolveLink(p.doc, to(`frame:${p.hero.id}`), { forceNew: true })).toMatchObject({ newTab: true });
  });

  it("survives renames and reports deletes instead of dropping the link", () => {
    const p = project();
    p.button.link = to(`frame:${p.hero.id}`);
    p.hero.name = "Renamed";
    const ok = resolveLink(p.doc, p.button.link);
    expect(ok.kind === "node" && ok.node.name).toBe("Renamed");
    // Documents are snapshots (the index is cached per snapshot), so edit a copy.
    const after = structuredClone(p.doc);
    deleteFrame(after, p.hero.id);
    expect(resolveLink(after, p.button.link)).toEqual({ kind: "broken", reason: "Frame deleted" });
    expect(docLinks(after).filter((l) => l.resolution.kind === "broken")).toHaveLength(1);
  });

  it("formats the canonical route and finds its way back, ids beating stale slugs", () => {
    const p = project();
    const route = projectRouteFor(p.doc, "me", [`frame:${p.hero.id}`], 1500);
    expect(formatRoute(route)).toBe(`/project/me/scenes-shots?at=frame:${p.hero.id}&t=1.5`);
    // Renamed page: the old slug still in the URL, the id still wins.
    p.scenes.name = "Elsewhere";
    expect(locateProjectRoute(p.doc, route)).toMatchObject({ pageId: p.scenes.id, t: 1500, missing: [] });
    // Hand-typed: only a slug.
    expect(locateProjectRoute(p.doc, { ...route, slug: "elsewhere", at: [] }).pageId).toBe(p.scenes.id);
    // A page key on a later page keeps its id; the first page needs nothing.
    expect(formatRoute(projectRouteFor(p.doc, "me", [`page:${p.intro.id}`]))).toBe("/project/me/intro");
    expect(projectRouteFor(p.doc, "me", [`page:${p.scenes.id}`]).at).toEqual([`page:${p.scenes.id}`]);
  });

  it("bubbles like HTML: the run, then the layer, then its groups and hosts", () => {
    const p = project();
    const word: Link = { target: { kind: "url", href: "https://docs.example.com" }, open: "auto" };
    p.title.ranges = applyRangePatch(p.title.ranges, 9, 13, { link: word });
    p.title.link = to(`frame:${p.hero.id}`);
    expect(linkForChain(p.doc, [p.title.id], 10)).toMatchObject({ link: word, span: { start: 9, end: 13 } });
    expect(linkForChain(p.doc, [p.title.id], 2)).toMatchObject({ link: p.title.link, span: null });
    // An unlinked layer inside a linked host.
    p.button.link = to(`page:${p.scenes.id}`);
    p.title.link = undefined;
    expect(linkForChain(p.doc, [p.title.id, p.button.id], 2)?.clipId).toBe(p.button.id);
    expect(linkForChain(p.doc, [p.title.id], 2)).toBeNull();
  });

  it("is a select while editing and a follow while viewing", () => {
    expect(linkClickIntent("edit", { mod: false })).toBeNull();
    expect(linkClickIntent("edit", { mod: true })).toBe("follow");
    expect(linkClickIntent("view", { mod: false })).toBe("follow");
    expect(linkClickIntent("view", { mod: true })).toBe("follow-new");
  });
});

describe("text links ride the range algebra", () => {
  it("survive restyling, retyping and come back as one span", () => {
    const p = project();
    const link = to(`frame:${p.hero.id}`);
    let ranges = applyRangePatch(p.title.ranges, 0, 8, { link });
    // Bold half of the linked run: two ranges, still ONE link span.
    ranges = applyRangePatch(ranges, 0, 4, { style: { fontWeight: 700 } });
    expect(ranges.length).toBe(2);
    expect(linkSpans({ ranges })).toEqual([{ start: 0, end: 8, link }]);
    // Typing inside the run extends it; before it shifts it.
    ranges = remapRangesAfterSplice(ranges, 0, 0, 2);
    expect(linkSpans({ ranges })).toEqual([{ start: 2, end: 10, link }]);
    // Removing the link leaves the bold alone.
    ranges = applyRangePatch(ranges, 2, 10, { link: null });
    expect(linkSpans({ ranges })).toEqual([]);
    expect(ranges).toHaveLength(1);
    expect(ranges[0]!.link).toBeUndefined();
  });

  it("persists through save and load", () => {
    const p = project();
    p.button.link = { target: { kind: "url", href: "https://a.co" }, open: "new" };
    p.title.ranges = applyRangePatch(p.title.ranges, 0, 4, { link: to(`frame:${p.hero.id}`, 500) });
    const back = parseDocument(JSON.stringify(p.doc));
    const clips = back.tracks.flatMap((t) => t.clips);
    expect(clips.find((c) => c.id === p.button.id)).toMatchObject({ link: p.button.link });
    expect(linkSpans(clips.find((c) => c.id === p.title.id) as TextClip)[0]!.link).toEqual(to(`frame:${p.hero.id}`, 500));
  });
});

describe("links in a PDF", () => {
  it("maps every target to a GoTo, a URI, or nothing", () => {
    const p = project();
    const pages = [
      { frameId: p.cover.id, timeMs: 0, index: 0, count: 1 },
      { frameId: p.hero.id, timeMs: 0, index: 0, count: 2 },
      { frameId: p.hero.id, timeMs: 500, index: 1, count: 2 },
    ];
    const ctx = { pages, projectId: "me", webOrigin: APP.webOrigin, layerTop: () => 120 };
    expect(pdfLinkAction(p.doc, to(`frame:${p.hero.id}`), ctx)).toEqual({ kind: "goto", page: 2, top: 0 });
    expect(pdfLinkAction(p.doc, to(`clip:${p.button.id}`), ctx)).toEqual({ kind: "goto", page: 1, top: 120 });
    expect(pdfLinkAction(p.doc, to(`page:${p.scenes.id}`), ctx)).toEqual({ kind: "goto", page: 2, top: 0 });
    expect(pdfLinkAction(p.doc, { target: { kind: "url", href: "mailto:a@example.com" }, open: "auto" }, ctx)).toEqual({ kind: "uri", uri: "mailto:a@example.com" });
    expect(pdfLinkAction(p.doc, { target: { kind: "route", path: "/plugin/icons" }, open: "auto" }, ctx)).toEqual({ kind: "uri", uri: "https://app.example.com/plugin/icons" });
    // Not in this PDF → the web deep link; deleted → nothing.
    expect(pdfLinkAction(p.doc, to(`frame:${p.hero.id}`), { ...ctx, pages: pages.slice(0, 1) })).toEqual({
      kind: "uri",
      uri: `https://app.example.com/project/me/scenes-shots?at=frame:${p.hero.id}`,
    });
    expect(pdfLinkAction(p.doc, to("frame:gone"), ctx)).toBeNull();
  });

  it("is always an address in a file with no pages of its own (SVG)", () => {
    const p = project();
    expect(standaloneLinkHref(p.doc, to(`frame:${p.hero.id}`), "me", APP.webOrigin)).toBe(`https://app.example.com/project/me/scenes-shots?at=frame:${p.hero.id}`);
    expect(standaloneLinkHref(p.doc, { target: { kind: "url", href: "https://example.com" }, open: "auto" }, null, APP.webOrigin)).toBe("https://example.com");
    expect(standaloneLinkHref(p.doc, to(`frame:${p.hero.id}`), null, APP.webOrigin)).toBeNull();
  });

  it("bookmarks every frame once, under its page when there are several", () => {
    const p = project();
    const pages = [
      { frameId: p.cover.id, timeMs: 0, index: 0, count: 1 },
      { frameId: p.hero.id, timeMs: 0, index: 0, count: 2 },
      { frameId: p.hero.id, timeMs: 500, index: 1, count: 2 },
    ];
    expect(pdfOutline(p.doc, pages)).toEqual([
      { title: "Intro", page: 1, children: [{ title: "Cover", page: 1, children: [] }] },
      { title: "Scenes & Shots", page: 2, children: [{ title: "Hero", page: 2, children: [] }] },
    ]);
    expect(pdfOutline(p.doc, pages.slice(1))).toEqual([{ title: "Hero", page: 1, children: [] }]);
  });
});
