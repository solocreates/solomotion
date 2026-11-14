import { current, isDraft } from "immer";
import type { MotionDocument, Clip, GroupClip, LayoutSpec, ShapeClip, TextClip, VisualClip } from "../schema";
import { layoutSpecSchema } from "../schema";
import { groupClips } from "../timeline/groups";
import { createShapeClip, createTrack } from "../factories";
import { clipNaturalSize, deleteClip, locateClip } from "../timeline/ops";
import { layoutBoxOf, layoutMembersOf, memberFootprint, resolveLayoutInDocument } from "./layout";

/**
 * AUTO LAYOUT OPS — the authoring verbs. The engine (`layout.ts`) says where
 * members go; these say how a person turns a pile of layers into a row, and
 * back, without anything jumping.
 */

/** A member's footprint placed in comp space, at rest. */
function placedFootprint(doc: MotionDocument, clip: VisualClip) {
  const box = clipNaturalSize(doc, clip);
  if (!box) return null;
  const fp = memberFootprint(clip, box);
  return { clip, minX: clip.transform.x + fp.minX, minY: clip.transform.y + fp.minY, width: fp.width, height: fp.height };
}

/**
 * The layout a set of members ALREADY HAS, read off their positions — Figma's
 * ⇧A trick. Side by side reads as a row, stacked reads as a column; the gap is
 * the mean space between neighbours along the flow; the box's corner is where
 * theirs is. Nothing moves the instant the layout lands, which is the whole
 * point: the layout describes the arrangement, then owns it.
 */
export function inferLayout(doc: MotionDocument, group: GroupClip): LayoutSpec {
  const fps = layoutMembersOf(doc, group)
    .map((c) => placedFootprint(doc, c))
    .filter((f): f is NonNullable<typeof f> => f !== null);
  const base = layoutSpecSchema.parse({ gap: 16, padding: { top: 0, right: 0, bottom: 0, left: 0 } });
  if (fps.length === 0) return { ...base, x: group.transform.x, y: group.transform.y };
  const minX = Math.min(...fps.map((f) => f.minX));
  const maxX = Math.max(...fps.map((f) => f.minX + f.width));
  const minY = Math.min(...fps.map((f) => f.minY));
  const maxY = Math.max(...fps.map((f) => f.minY + f.height));
  const cx = (f: (typeof fps)[number]) => f.minX + f.width / 2;
  const cy = (f: (typeof fps)[number]) => f.minY + f.height / 2;
  const spreadX = Math.max(...fps.map(cx)) - Math.min(...fps.map(cx));
  const spreadY = Math.max(...fps.map(cy)) - Math.min(...fps.map(cy));
  const flow: LayoutSpec["flow"] = fps.length > 1 && spreadY > spreadX ? "column" : "row";
  const sorted = fps.slice().sort((a, b) => (flow === "row" ? cx(a) - cx(b) : cy(a) - cy(b)));
  let gaps = 0;
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1]!;
    const b = sorted[i]!;
    gaps += flow === "row" ? b.minX - (a.minX + a.width) : b.minY - (a.minY + a.height);
  }
  const gap = sorted.length > 1 ? Math.max(0, Math.round(gaps / (sorted.length - 1))) : base.gap;
  return { ...base, flow, gap, x: minX, y: minY };
}

/**
 * Put the group's rows in SPATIAL order along the flow, so the member on the
 * left is first. Rows are reordered as whole rows (a row holding several clips
 * sorts by its leftmost); the block of rows keeps its place among the other
 * lanes, so nothing outside the group changes z.
 */
export function orderRowsByPosition(doc: MotionDocument, group: GroupClip, flow: LayoutSpec["flow"]): void {
  const rows = doc.tracks.map((t, i) => ({ t, i })).filter(({ t }) => t.groupId === group.id);
  if (rows.length < 2) return;
  const keyOf = ({ t }: (typeof rows)[number]) => {
    let k = Infinity;
    for (const c of t.clips) {
      if (c.kind === "audio") continue;
      const f = placedFootprint(doc, c);
      if (!f) continue;
      k = Math.min(k, flow === "column" ? f.minY + f.height / 2 : f.minX + f.width / 2);
    }
    return k;
  };
  // First member = BOTTOM row: paint order runs bottom → top.
  const ordered = rows.slice().sort((a, b) => keyOf(b) - keyOf(a)).map((r) => r.t);
  const slots = rows.map((r) => r.i);
  ordered.forEach((track, k) => {
    doc.tracks[slots[k]!] = track;
  });
}

/**
 * WHAT ⇧A MEANS FOR THIS SELECTION — the one answer the shortcut, the layer
 * menu and the inspector all read, so none of them offers it where the others
 * would refuse. A layout arranges SEVERAL things: a group (on or off), or
 * several layers (grouped into one first). A lone layer has nothing to arrange,
 * so it gets nothing — not a disabled row, not a one-member row.
 */
export function autoLayoutVerb(doc: MotionDocument, clipIds: readonly string[]): "add" | "remove" | null {
  const clips = clipIds.map((id) => locateClip(doc, id)?.clip);
  if (clips.length === 0 || clips.some((c) => !c || c.kind === "audio")) return null;
  if (clips.length > 1) return "add";
  const only = clips[0]!;
  // A rig and a switch already place their members (bones; one at a time) — a layout would fight them.
  if (only.kind === "group" && (only.rig || only.switch)) return null;
  return only.kind === "group" ? (only.layout ? "remove" : "add") : null;
}

/**
 * ⇧A — give a group an auto layout that describes what it already looks like.
 * Returns false when the clip is not a group.
 */
export function addAutoLayout(doc: MotionDocument, groupId: string, spec?: Partial<LayoutSpec>): boolean {
  const group = locateClip(doc, groupId)?.clip;
  if (!group || group.kind !== "group" || group.rig || group.switch) return false;
  // Text inside a layout sizes its height from its words (Figma's auto
  // height) — measured before the arrangement is read, so it is read from the
  // boxes the layout will actually use.
  for (const m of layoutMembersOf(doc, group)) if (m.kind === "text" && !m.path) m.maxHeight = null;
  const inferred = inferLayout(doc, group);
  const layout = { ...inferred, ...spec };
  orderRowsByPosition(doc, group, layout.flow);
  group.layout = layout;
  seedMemberFill(doc, group);
  return true;
}

/**
 * Which layers can take the size a layout offers — the ones whose size is their
 * own geometry (a shape's box, a painting's canvas, a text's wrap box, a
 * laid-out group's box). Media keeps its pixels' proportions.
 */
export function layoutCanFill(clip: Clip): boolean {
  return clip.kind === "shape" || clip.kind === "text" || clip.kind === "raster" || (clip.kind === "group" && clip.layout !== null);
}

/**
 * RESIZING THE BOX SHOULD DO SOMETHING. Members that already agree on a size
 * along an axis are set to FILL it, so the moment a layout lands nothing moves
 * (they fill exactly the size they already share), and from then on stretching
 * the box stretches them — a stack of equal cards widens with its column, a
 * row of equal buttons shares the width it is given. Members that disagree keep
 * their own sizes: filling them would reshape the artwork the instant the
 * layout was added, which is the one thing adding a layout must never do.
 */
function seedMemberFill(doc: MotionDocument, group: GroupClip): void {
  // Text is left to hug: filling it rewraps the words, which is a change to the
  // artwork rather than to the space around it.
  const members = layoutMembersOf(doc, group).filter((m) => !m.layoutItem.absolute && m.kind !== "text" && layoutCanFill(m));
  if (members.length < 2) return;
  const sizes = members.map((m) => placedFootprint(doc, m)).filter((f): f is NonNullable<typeof f> => f !== null);
  if (sizes.length !== members.length) return;
  const agree = (vals: number[]) => Math.max(...vals) - Math.min(...vals) <= 1;
  const sameW = agree(sizes.map((f) => f.width));
  const sameH = agree(sizes.map((f) => f.height));
  for (const m of members) {
    if (sameW) m.layoutItem.fillX = true;
    if (sameH) m.layoutItem.fillY = true;
  }
}

/**
 * Take the layout off a group and leave every member EXACTLY where the layout
 * had put it at `compMs` — the resolved positions become the members' own, so
 * nothing moves and the row is now just layers again.
 */
export function removeAutoLayout(doc: MotionDocument, groupId: string, compMs: number): boolean {
  const group = locateClip(doc, groupId)?.clip;
  if (!group || group.kind !== "group" || !group.layout) return false;
  // The resolver clones; a draft cannot be cloned, so it reads the snapshot.
  const snapshot = isDraft(doc) ? current(doc) : doc;
  const resolved = resolveLayoutInDocument(snapshot, compMs);
  for (const member of layoutMembersOf(doc, group)) {
    const laid = locateClip(resolved, member.id)?.clip;
    if (!laid || laid.kind === "audio") continue;
    member.transform.x = laid.transform.x;
    member.transform.y = laid.transform.y;
    if (member.kind === "shape" && laid.kind === "shape") {
      member.width = laid.width;
      member.height = laid.height;
    } else if (member.kind === "text" && laid.kind === "text") {
      member.maxWidth = laid.maxWidth;
      member.maxHeight = laid.maxHeight;
    } else if (member.kind === "group" && laid.kind === "group" && member.layout && laid.layout) {
      member.layout = { ...member.layout, width: laid.layout.width, height: laid.layout.height };
    }
  }
  releaseBoxAsRect(doc, group, compMs);
  group.layout = null;
  return true;
}

/**
 * THE BOX COMES BACK AS A RECTANGLE. A laid-out group paints its own box —
 * that is how a rectangle became a button in `wrapTextInShape` — so taking the
 * layout off has to give that look back to a layer, or the fill would fall on
 * the members (a plain group's fill tints its contents). The rectangle takes
 * the box's place and size at this instant, behind everything in the group.
 */
function releaseBoxAsRect(doc: MotionDocument, group: GroupClip, compMs: number): void {
  const paints = group.fills.some((f) => f.enabled) || group.strokes.some((st) => st.enabled);
  if (!paints) return;
  const snapshot = isDraft(doc) ? current(doc) : doc;
  const resolved = resolveLayoutInDocument(snapshot, compMs);
  const laid = locateClip(resolved, group.id)?.clip;
  const box = laid && laid.kind === "group" ? layoutBoxOf(resolved, laid) : layoutBoxOf(doc, group);
  if (!box) return;
  const rect = createShapeClip({
    frameId: group.frameId,
    shape: "rect",
    startMs: group.startMs,
    durationMs: group.durationMs,
    x: box.cx,
    y: box.cy,
    width: box.width,
    height: box.height,
  }) as ShapeClip;
  rect.name = group.name;
  rect.fills = group.fills.map((f) => ({ ...f }));
  rect.strokes = group.strokes.map((st) => ({ ...st }));
  rect.cornerRadius = { ...group.borderRadius };
  rect.opacity = group.opacity;
  rect.effects = group.effects.map((e) => ({ ...e }));
  group.fills = [];
  group.strokes = [];
  group.borderRadius = { tl: 0, tr: 0, br: 0, bl: 0 };
  group.opacity = 1;
  group.effects = [];
  // Behind the members: the group's LAST row paints first (bottom).
  const rows = doc.tracks.map((t, i) => ({ t, i })).filter(({ t }) => t.groupId === group.id);
  const at = rows.length > 0 ? rows[rows.length - 1]!.i + 1 : doc.tracks.length;
  const lane = createTrack(rect.name, group.frameId, group.id);
  lane.clips.push(rect);
  doc.tracks.splice(at, 0, lane);
}

/**
 * Move a member to a new place in the flow — the drag-to-reorder. `toIndex`
 * is the index in layout order (0 = first). The member's row is re-seated
 * among the group's rows; other lanes never move.
 */
export function reorderLayoutMember(doc: MotionDocument, groupId: string, clipId: string, toIndex: number): boolean {
  const rows = doc.tracks.map((t, i) => ({ t, i })).filter(({ t }) => t.groupId === groupId);
  const from = rows.findIndex(({ t }) => t.clips.some((c) => c.id === clipId));
  if (from < 0) return false;
  // Layout order is bottom row first: index 0 = the LAST row in `rows`.
  const order = rows.slice().reverse();
  const fromIdx = order.length - 1 - from;
  const [row] = order.splice(fromIdx, 1);
  order.splice(Math.max(0, Math.min(order.length, toIndex)), 0, row!);
  const back = order.slice().reverse();
  rows.forEach(({ i }, k) => {
    doc.tracks[i] = back[k]!.t;
  });
  return true;
}

/**
 * TEXT INSIDE A SHAPE — a rect and a text become one container: the rect's
 * fills, strokes and corners move onto a new laid-out group sized to the
 * rect, the text is its centred member, and the rect itself is gone. It is
 * the Figma way of building a button, and it is one verb because "put this
 * text in that box" is one thought. Returns the group's id, or null when the
 * shape is not a rectangle (a container's box is a rectangle).
 */
export function wrapTextInShape(doc: MotionDocument, textId: string, shapeId: string): string | null {
  const text = locateClip(doc, textId)?.clip as TextClip | undefined;
  const shape = locateClip(doc, shapeId)?.clip as ShapeClip | undefined;
  if (!text || text.kind !== "text" || !shape || shape.kind !== "shape" || shape.shape !== "rect") return null;
  const sx = Math.abs(shape.transform.scale);
  const sy = Math.abs(shape.transform.scaleY ?? shape.transform.scale);
  const w = Math.max(1, shape.width * sx);
  const h = Math.max(1, shape.height * sy);
  const rect = { minX: shape.transform.x - w / 2, minY: shape.transform.y - h / 2, maxX: shape.transform.x + w / 2, maxY: shape.transform.y + h / 2 };
  // A text's height always FOLLOWS its words inside a box — a typed line must
  // grow the button, not spill out of it.
  const textBox = text.maxWidth !== null;
  text.maxHeight = null;
  const fp = placedFootprint(doc, text);
  const groupId = groupClips(doc, [textId], shape.name);
  if (!groupId || !fp) return groupId;
  const group = locateClip(doc, groupId)?.clip as GroupClip | undefined;
  if (!group) return null;
  // THE PADDING IS WHERE THE TEXT ALREADY SITS in the rectangle, side by side,
  // so the box lands exactly on the rectangle and nothing moves. A text poking
  // out of a side gets no padding there — the box grows to hold it.
  // Kept to the hundredth, not rounded to whole pixels: rounding four sides is
  // up to two pixels of drift, and "nothing moves" is the promise.
  const exact = (v: number) => Math.max(0, Math.round(v * 100) / 100);
  const padding = {
    left: exact(fp.minX - rect.minX),
    top: exact(fp.minY - rect.minY),
    right: exact(rect.maxX - (fp.minX + fp.width)),
    bottom: exact(rect.maxY - (fp.minY + fp.height)),
  };
  group.layout = layoutSpecSchema.parse({
    x: Math.min(rect.minX, fp.minX),
    y: Math.min(rect.minY, fp.minY),
    // One line of text: the box HUGS it both ways, so typing widens the button
    // and a bigger font grows it. A text box: the box keeps the rectangle's
    // width, the words fill it and wrap, and the height hugs what they need.
    width: textBox ? w : null,
    height: null,
    gap: 0,
    padding,
    alignX: "center",
    alignY: "center",
  });
  if (textBox) text.layoutItem = { ...text.layoutItem, fillX: true, fillY: false };
  group.fills = shape.fills.map((f) => ({ ...f }));
  group.strokes = shape.strokes.map((s) => ({ ...s }));
  group.borderRadius = { ...shape.cornerRadius };
  group.opacity = shape.opacity;
  group.effects = shape.effects.map((e) => ({ ...e }));
  deleteClip(doc, shapeId);
  return groupId;
}

// ── Sizing: Fixed · Hug · Fill, Figma's three words ──────────────────────────

export type LayoutAxis = "x" | "y";
export type LayoutSizing = "fixed" | "hug" | "fill";

/**
 * What a layer inside a layout does along one axis. FILL takes the slot the
 * box offers; HUG sizes to content (a text's words, a laid-out group's
 * members); FIXED keeps a number. Shapes and media have no content to hug.
 */
export function memberSizing(clip: VisualClip, axis: LayoutAxis): LayoutSizing {
  if (axis === "x" ? clip.layoutItem.fillX : clip.layoutItem.fillY) return "fill";
  if (clip.kind === "text") return (axis === "x" ? clip.maxWidth : clip.maxHeight) === null ? "hug" : "fixed";
  if (clip.kind === "group" && clip.layout) return (axis === "x" ? clip.layout.width : clip.layout.height) === null ? "hug" : "fixed";
  return "fixed";
}

/** The sizings this layer can take on an axis. */
export function memberSizings(clip: VisualClip): LayoutSizing[] {
  const hug = clip.kind === "text" || (clip.kind === "group" && clip.layout !== null);
  return [...(layoutCanFill(clip) ? (["fill"] as const) : []), ...(hug ? (["hug"] as const) : []), "fixed"];
}

/**
 * Set a member's sizing — and keep the one rule that makes the three words
 * mean something: a child can only FILL an axis its box does not HUG (there
 * is nothing to fill in a box sized by its children). So asking to fill a
 * hugging axis FIXES the box there at its current size first, exactly as
 * Figma does. Hug and Fixed on a text are its auto / fixed width and height.
 */
export function setMemberSizing(doc: MotionDocument, clipId: string, axis: LayoutAxis, mode: LayoutSizing): boolean {
  const clip = locateClip(doc, clipId)?.clip;
  if (!clip || clip.kind === "audio") return false;
  const container = containerOfMember(doc, clipId);
  const key = axis === "x" ? "fillX" : "fillY";
  const size = placedFootprint(doc, clip);
  if (mode === "fill") {
    if (!layoutCanFill(clip)) return false;
    if (container?.layout && (axis === "x" ? container.layout.width : container.layout.height) === null) {
      const box = layoutBoxOf(doc, container);
      if (box) container.layout = { ...container.layout, [axis === "x" ? "width" : "height"]: Math.round(axis === "x" ? box.width : box.height) };
    }
    clip.layoutItem = { ...clip.layoutItem, [key]: true };
    return true;
  }
  clip.layoutItem = { ...clip.layoutItem, [key]: false };
  if (clip.kind === "text") {
    if (axis === "x") {
      // Auto WIDTH is one line: its height follows too.
      clip.maxWidth = mode === "hug" ? null : Math.max(1, Math.round(size?.width ?? 100));
      if (mode === "hug") clip.maxHeight = null;
    } else {
      clip.maxHeight = mode === "hug" ? null : Math.max(1, Math.round(size?.height ?? 40));
    }
  } else if (clip.kind === "group" && clip.layout) {
    const k = axis === "x" ? "width" : "height";
    const box = layoutBoxOf(doc, clip);
    clip.layout = { ...clip.layout, [k]: mode === "hug" ? null : Math.round((axis === "x" ? box?.width : box?.height) ?? 100) };
  }
  return true;
}

/**
 * The box's own sizing on an axis. Making it HUG takes FILL off every member
 * on that axis (they become their content size — Figma's rule, the same one
 * as above from the other side); making it FIXED keeps its current size.
 */
export function setBoxSizing(doc: MotionDocument, groupId: string, axis: LayoutAxis, mode: "fixed" | "hug"): boolean {
  const group = locateClip(doc, groupId)?.clip;
  if (!group || group.kind !== "group" || !group.layout) return false;
  const k = axis === "x" ? "width" : "height";
  if (mode === "fixed") {
    if (group.layout[k] !== null) return true;
    const box = layoutBoxOf(doc, group);
    group.layout = { ...group.layout, [k]: Math.max(1, Math.round((axis === "x" ? box?.width : box?.height) ?? 100)) };
    // YOU SIZED THE BOX, so what was hugging inside it now follows it: a
    // button's label wraps at the width you gave the button, a card's text
    // fills the card. Across the flow always (a column's width is every
    // member's width); along it only for a member alone on the line — several
    // hugging labels in a row keep their own widths rather than share yours.
    const members = layoutMembersOf(doc, group).filter((m) => !m.layoutItem.absolute);
    const along = (group.layout.flow === "column") === (axis === "y");
    for (const m of members) {
      if (memberSizing(m, axis) !== "hug" || !layoutCanFill(m)) continue;
      if (along && members.length > 1) continue;
      m.layoutItem = { ...m.layoutItem, [axis === "x" ? "fillX" : "fillY"]: true };
    }
    return true;
  }
  for (const m of layoutMembersOf(doc, group)) {
    if (memberSizing(m, axis) === "fill") setMemberSizing(doc, m.id, axis, m.kind === "text" || (m.kind === "group" && m.layout) ? "hug" : "fixed");
  }
  group.layout = { ...group.layout, [k]: null };
  return true;
}

function containerOfMember(doc: MotionDocument, clipId: string): GroupClip | null {
  const track = doc.tracks.find((t) => t.clips.some((c) => c.id === clipId));
  const parent = track?.groupId ? locateClip(doc, track.groupId)?.clip : null;
  return parent && parent.kind === "group" && parent.layout ? parent : null;
}
