/**
 * EDIT SCOPES — the pluggable classification behind "what happens when I enter
 * this thing?".
 *
 * The editor has exactly ONE navigation model: you stand in a comp, and you can
 * step INTO something that has its own inside. Historically each such thing —
 * a component instance, a private nested clip, a flipbook cell, a vectorized
 * SVG — grew its own bespoke entering code in a surface file, which is why they
 * all behaved differently and none of them behaved well.
 *
 * Here a "scope kind" is an OBJECT implementing `EditScopeKind`, registered in
 * `editScopes`. It answers two questions and nothing else:
 *
 *   1. does this clip have an inside?          (`matches` + `sourceFrameId`)
 *   2. which workspace opens for it?           (`workspace`)
 *
 * There is deliberately no third question about WHERE the inside is edited.
 * Everything is edited IN PLACE, at the instance, in the real scene — see
 * `EditContext`. A scope that could relocate the canvas was the source of the
 * "my drawing lands in an empty area off to the side" class of bug: two
 * coordinate authorities (the hop chain and the source frame's own page x/y)
 * both claiming to say where the target lives.
 *
 * Everything downstream — the path, the context, the breadcrumb, isolation, the
 * stage, the timeline, playback — is written once against those answers. Adding
 * a new enterable concept (a 3D layer, a particle system, a linked document) is
 * `editScopes.register(new MyScope())` and nothing else changes.
 */

import type { MotionDocument, Clip, Frame } from "../schema";

/** Which editing surface the timeline area switches to for a target frame. */
export type ScopeWorkspace = "timeline" | "flipbook" | "static";

/** Icon/semantics hint for breadcrumb chips and panel badges. */
export type ScopeBadge = "component" | "nested" | "vector" | "static" | "flipbook";

export interface ScopeMatch {
  /** The registered kind that claimed this clip. */
  kind: EditScopeKind;
  /** The frame the clip opens into. */
  sourceFrameId: string;
}

/**
 * One enterable concept. Implement this to teach the whole editor a new kind of
 * "inside" — the base class `NestedFrameScope` already does the common work for
 * anything backed by a nested clip.
 */
export interface EditScopeKind {
  /** Stable id (also used in telemetry/labels). */
  readonly id: string;
  /** Higher wins when several kinds match the same clip. */
  readonly priority: number;
  readonly badge: ScopeBadge;
  /** Does this clip open into a frame? Return the frame id, or null. */
  sourceFrameId(doc: MotionDocument, clip: Clip): string | null;
  /** Which workspace the target opens in. */
  workspace(doc: MotionDocument, source: Frame): ScopeWorkspace;
  /** Breadcrumb label for the step INTO this clip. */
  label(doc: MotionDocument, clip: Clip, source: Frame): string;
}

/** The workspace a FRAME itself opens in, independent of how you got there. */
export function frameWorkspace(frame: Frame): ScopeWorkspace {
  return frame.mode === "flipbook" ? "flipbook" : frame.mode === "static" ? "static" : "timeline";
}

/**
 * Base implementation for every scope backed by a `nested` clip — which today
 * is all of them. Subclasses narrow `claims()` and override labels.
 */
export abstract class NestedFrameScope implements EditScopeKind {
  abstract readonly id: string;
  abstract readonly priority: number;
  abstract readonly badge: ScopeBadge;

  /** Extra condition on top of "it's a nested clip pointing at a real frame". */
  protected abstract claims(doc: MotionDocument, clip: Clip, source: Frame): boolean;

  sourceFrameId(doc: MotionDocument, clip: Clip): string | null {
    if (clip.kind !== "nested") return null;
    // Presented as one opaque layer: it still HAS an inside, you just aren't
    // allowed in. Gated HERE — the one seam that answers "does this clip have an
    // inside?" — so double-click, the breadcrumb, the layers panel and every
    // future caller agree without any of them knowing the flag exists.
    if (clip.flat) return null;
    const source = doc.frames.find((f) => f.id === clip.sourceFrameId);
    if (!source) return null;
    return this.claims(doc, clip, source) ? source.id : null;
  }

  workspace(_doc: MotionDocument, source: Frame): ScopeWorkspace {
    return frameWorkspace(source);
  }

  label(_doc: MotionDocument, clip: Clip, source: Frame): string {
    return clip.name || source.name;
  }
}

/** A nested clip whose source frame is a shared COMPONENT definition. */
export class ComponentScope extends NestedFrameScope {
  readonly id = "component";
  readonly priority = 100;
  readonly badge: ScopeBadge = "component";
  protected claims(_doc: MotionDocument, _clip: Clip, source: Frame): boolean {
    return source.component != null;
  }
}

/** A nested clip whose source is a FLIPBOOK sheet (its cells are the frames). */
export class FlipbookScope extends NestedFrameScope {
  readonly id = "flipbook";
  readonly priority = 90;
  readonly badge: ScopeBadge = "flipbook";
  protected claims(_doc: MotionDocument, _clip: Clip, source: Frame): boolean {
    return source.mode === "flipbook";
  }
}

/** A nested clip whose source is a STATIC frame — a drawing, a design, a still. */
export class StaticScope extends NestedFrameScope {
  readonly id = "static";
  readonly priority = 90;
  readonly badge: ScopeBadge = "static";
  protected claims(_doc: MotionDocument, _clip: Clip, source: Frame): boolean {
    return source.mode === "static";
  }
}

/**
 * A nested clip carrying VECTOR artwork lifted out of an imported SVG. It is an
 * ordinary private nested comp — the distinct kind exists so the breadcrumb can
 * say "vectors" and so a future SVG-specific toolset has a hook. Recognised by
 * the marker the vectorizer stamps on the source frame.
 */
export const VECTOR_SOURCE_TAG = "svg";

export class VectorArtScope extends NestedFrameScope {
  readonly id = "vector";
  readonly priority = 80;
  readonly badge: ScopeBadge = "vector";
  protected claims(_doc: MotionDocument, _clip: Clip, source: Frame): boolean {
    return source.sourceTag === VECTOR_SOURCE_TAG;
  }
}

/** Any other private nested comp (precompose, "make nested", flipbook cell). */
export class PrivateNestedScope extends NestedFrameScope {
  readonly id = "nested";
  readonly priority = 0;
  readonly badge: ScopeBadge = "nested";
  protected claims(): boolean {
    return true;
  }
}

/**
 * The registry. One process-wide instance (`editScopes`); plugins may register
 * more kinds at load time. Resolution is highest-priority-first, so a
 * specialised kind always beats the generic nested fallback.
 */
export class EditScopeRegistry {
  private kinds: EditScopeKind[] = [];

  register(kind: EditScopeKind): this {
    this.kinds = [...this.kinds.filter((k) => k.id !== kind.id), kind].sort(
      (a, b) => b.priority - a.priority,
    );
    return this;
  }

  list(): readonly EditScopeKind[] {
    return this.kinds;
  }

  get(id: string): EditScopeKind | null {
    return this.kinds.find((k) => k.id === id) ?? null;
  }

  /** The kind that claims this clip, with the frame it opens into. */
  resolve(doc: MotionDocument, clip: Clip): ScopeMatch | null {
    for (const kind of this.kinds) {
      const sourceFrameId = kind.sourceFrameId(doc, clip);
      if (sourceFrameId) return { kind, sourceFrameId };
    }
    return null;
  }
}

export const editScopes = new EditScopeRegistry()
  .register(new ComponentScope())
  .register(new FlipbookScope())
  .register(new StaticScope())
  .register(new VectorArtScope())
  .register(new PrivateNestedScope());

/** Does this clip have an inside you can step into? */
export function isEnterable(doc: MotionDocument, clip: Clip): boolean {
  return editScopes.resolve(doc, clip) != null;
}

/** The frame a clip opens into, or null. */
export function scopeSourceFrameId(doc: MotionDocument, clip: Clip): string | null {
  return editScopes.resolve(doc, clip)?.sourceFrameId ?? null;
}
