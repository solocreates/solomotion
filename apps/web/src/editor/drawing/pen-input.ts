import {
  PenSampleNormalizer,
  createStabilizer,
  stabilizerPush,
  type PenSample,
  type PressureSettings,
  type StabilizerState,
} from "@solomotion/core";

/**
 * THE PEN'S FRONT END — a pointer event in, the samples a brush engine eats out.
 *
 * Every brush in the app reads the hand the same way: every coalesced sample
 * (a fast flick is a line, not a polygon), the stabiliser's leash measured in
 * SCREEN px (the same distance to the hand at every zoom and every camera),
 * then mapped into the space the stroke lives in, then the pen's pressure
 * normalised by the app's pen response (a mouse gets velocity pressure, a
 * finger none). The flat canvas and a 3D world each had their own copy of
 * this, and the 3D one had already lost the streamline the flat one fed —
 * the same brush felt different in the two places. One class, two callers.
 */
export class PenInput {
  /** The leash, in screen px — created at the first sample that asks for one (⇧ can arrive mid-stroke). */
  stab: StabilizerState | null = null;
  private last: { pressure: number; tiltX: number; tiltY: number; timeMs: number } | null = null;
  private readonly normalizer: PenSampleNormalizer;

  constructor(
    pressure: PressureSettings,
    pointerType: string,
    /** The leash length right now, screen px — read per sample so ⇧ works mid-stroke. */
    private readonly leash: () => number,
  ) {
    this.normalizer = new PenSampleNormalizer(pressure, pointerType === "pen");
  }

  /**
   * The samples one event carries. `screen` reads an event's position in the
   * surface's screen px; `map` carries a stabilised screen point into the
   * stroke's own space (identity when the stroke is drawn in screen px).
   */
  take(
    e: PointerEvent,
    screen: (ev: PointerEvent) => { x: number; y: number },
    map: (p: { x: number; y: number }) => { x: number; y: number } = (p) => p,
  ): PenSample[] {
    const out: PenSample[] = [];
    for (const ev of coalescedEvents(e)) {
      const raw = screen(ev);
      this.last = { pressure: ev.pressure, tiltX: ev.tiltX ?? 0, tiltY: ev.tiltY ?? 0, timeMs: ev.timeStamp };
      const radius = this.leash();
      if (radius > 0 && !this.stab) {
        // The tool starts AT the cursor; the leash only governs where it goes
        // next. Without this first point a tap under smoothing marks nothing.
        this.stab = createStabilizer(raw, radius);
        out.push(this.sample(map(raw)));
        continue;
      }
      for (const q of this.stab ? stabilizerPush(this.stab, raw, radius) : [raw]) out.push(this.sample(map(q)));
    }
    return out;
  }

  private sample(p: { x: number; y: number }): PenSample {
    const pen = this.last;
    return this.normalizer.normalize({
      x: p.x,
      y: p.y,
      pressure: pen?.pressure ?? 0.5,
      tiltX: pen?.tiltX ?? 0,
      tiltY: pen?.tiltY ?? 0,
      timeMs: pen?.timeMs ?? performance.now(),
    });
  }
}

/** Every sample the pointer took since the last event — or the event itself, where the browser keeps none (synthetic events, some platforms). */
export function coalescedEvents(e: PointerEvent): PointerEvent[] {
  const list = typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : [];
  return list.length ? list : [e];
}
