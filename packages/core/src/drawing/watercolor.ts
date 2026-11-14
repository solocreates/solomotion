import { GRAIN_TILE, grainTile, type GrainTexture } from "./grain";

/**
 * WET PAINT — a real shallow-water pigment simulation, small enough to run
 * every frame on a laptop.
 *
 * Watercolour is not a look you can paint. Its three signatures — the dark rim
 * around a drying wash, granulation pooling in the paper's valleys, and two wet
 * strokes bleeding into one another — are all CONSEQUENCES of pigment suspended
 * in water that is moving and evaporating. Fake any one of them with a filter
 * and the other two are missing, which is why "watercolour brushes" in most
 * tools read as soft-edged ink.
 *
 * So this simulates the cause, following Curtis et al.'s shallow-water model
 * (SIGGRAPH '97) reduced to what actually earns its cost in real time:
 *
 *   WATER    a depth field. Flows down its own gradient, slowed by the paper's
 *            height — so it runs along the tooth's valleys instead of spreading
 *            in a disc.
 *   PIGMENT  suspended in the water and carried by it. This is the bleeding.
 *   DEPOSIT  pigment that has settled onto the paper. This is what you see when
 *            it dries, and what a dry layer keeps.
 *
 * The two rates that make it look right:
 *
 *   DEPOSITION rises sharply as water gets shallow, so the last water to
 *   evaporate — the rim of a wash, where the film is thinnest — drops the most
 *   pigment. The dark edge is EMERGENT. Nothing draws it.
 *
 *   GRANULATION biases deposition toward the paper's low points, so a rough
 *   paper gets the mottled sediment a smooth one does not.
 *
 * COST. Every step is a fixed number of passes over a DIRTY RECT, never the
 * canvas: a wash in one corner costs that corner. Buffers are allocated once
 * and reused, so a step allocates nothing. The whole thing is typed arrays and
 * no closures in the inner loops.
 *
 * Pure data in, pure data out — no canvas, no DOM. The painter feeds it dabs
 * and reads back an RGBA image; a test feeds it a puddle and asserts that the
 * edge got darker.
 */

/** How the medium behaves. Every brush that paints wet carries one of these. */
export interface WetSettings {
  /** How freely water spreads. 0 = stays put, 1 = floods. */
  flow: number;
  /** How fast water leaves per step. Higher dries sooner and bleeds less. */
  evaporation: number;
  /** How strongly pigment settles into the paper's valleys. */
  granulation: number;
  /** How hard pigment piles up at the drying rim — the watercolour edge. */
  edge: number;
  /** How readily suspended pigment settles at all (a "staining" pigment is low). */
  deposition: number;
  /** Paper the water is running over. */
  texture: GrainTexture;
}

export const DEFAULT_WET: WetSettings = {
  flow: 0.75,
  // Per STEP, and a step is a frame: 0.012 dried a wash in about a second and a
  // half, so evaporation outran flow and the wash SHRANK instead of spreading.
  // A real wash stays workable for several seconds — which is the whole reason
  // wet-in-wet is a technique at all.
  evaporation: 0.004,
  granulation: 0.45,
  // Gentle by default. A wash that fades is the ordinary case; a wash with a
  // pronounced rim is a particular brush, and it asks for it.
  edge: 0.4,
  // Low, and that is the point: at 0.35 a wash had deposited ALL its pigment by
  // the time it was a third dry, so nothing was left suspended to travel and no
  // rim could form. Pigment has to outlive the water it rides on.
  deposition: 0.06,
  texture: "rough",
};

/** A rectangle of the field that has anything happening in it. */
export interface DirtyRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const EMPTY: DirtyRect = { x0: 0, y0: 0, x1: -1, y1: -1 };
const isEmpty = (r: DirtyRect) => r.x1 < r.x0 || r.y1 < r.y0;

/**
 * One layer's wet film.
 *
 * Deposited pigment is kept SEPARATE from suspended pigment, and that split is
 * the whole model: drying is not an effect applied to the layer, it is the
 * moment suspended pigment finishes becoming deposited pigment. "Dry this
 * layer" is therefore an honest operation with an obvious meaning rather than a
 * filter that has to guess.
 */
export class WetLayer {
  readonly water: Float32Array;
  /** Suspended pigment, premultiplied RGBA, 0..1 per channel. */
  readonly pigment: Float32Array;
  /** Settled pigment, premultiplied RGBA — what survives drying. */
  readonly deposit: Float32Array;
  /**
   * Paper height, 0..1 — the 256² TILE, not a full-surface copy of it.
   *
   * Materialising it per surface cost ~8MB on a 1080×1920 layer to store the
   * same 65k values over and over. Sampling the tile with a modulo is the same
   * field for a fraction of the memory, which matters because a wet layer
   * already carries five full-resolution buffers.
   */
  private readonly paper: Uint8ClampedArray;
  /** Scratch for the flow pass — allocated once, never per step. */
  private readonly scratch: Float32Array;
  private readonly scratchPigment: Float32Array;

  private dirty: DirtyRect = { ...EMPTY };
  /**
   * Bumped by anything that changes what the layer LOOKS like.
   *
   * The painter has to know whether re-composing is worth it, and "is the layer
   * still wet" is the wrong question — a dab lands on an already-wet layer
   * without changing its wetness, and a dry layer's last frame still has to be
   * composed once. A version is the honest answer to "has this changed since I
   * last looked", and it is the difference between compositing on demand and
   * compositing sixty times a second for nothing.
   */
  version = 0;

  constructor(
    readonly width: number,
    readonly height: number,
    readonly settings: WetSettings = DEFAULT_WET,
  ) {
    const n = width * height;
    this.water = new Float32Array(n);
    this.pigment = new Float32Array(n * 4);
    this.deposit = new Float32Array(n * 4);
    this.scratch = new Float32Array(n);
    this.scratchPigment = new Float32Array(n * 4);

    // The paper is the SAME field the dry brushes gate their grain through, so
    // a wash granulates into the tooth its own brush would have skipped over.
    this.paper = grainTile(settings.texture, 1);
  }

  /** The region with wet paint in it. Empty when the layer is dry. */
  get dirtyRect(): DirtyRect {
    return this.dirty;
  }

  get isDry(): boolean {
    return isEmpty(this.dirty);
  }

  private grow(x0: number, y0: number, x1: number, y1: number): void {
    if (isEmpty(this.dirty)) {
      this.dirty = { x0, y0, x1, y1 };
      return;
    }
    if (x0 < this.dirty.x0) this.dirty.x0 = x0;
    if (y0 < this.dirty.y0) this.dirty.y0 = y0;
    if (x1 > this.dirty.x1) this.dirty.x1 = x1;
    if (y1 > this.dirty.y1) this.dirty.y1 = y1;
  }

  /**
   * Lay down wet paint: a circular dab of water carrying pigment.
   *
   * `wetness` is how much WATER the dab carries, separately from how much
   * pigment — which is the difference between a loaded wash that runs and a
   * thirsty brush that stains where it touches and stops.
   */
  dab(cx: number, cy: number, radius: number, rgb: readonly [number, number, number], alpha: number, wetness: number): void {
    const x0 = Math.max(0, Math.floor(cx - radius));
    const y0 = Math.max(0, Math.floor(cy - radius));
    const x1 = Math.min(this.width - 1, Math.ceil(cx + radius));
    const y1 = Math.min(this.height - 1, Math.ceil(cy + radius));
    if (x1 < x0 || y1 < y0) return;

    const r2 = radius * radius;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x - cx;
        const dy = y - cy;
        const d2 = dx * dx + dy * dy;
        if (d2 > r2) continue;
        // A soft brush edge; the simulation supplies all the interesting shape.
        const falloff = 1 - Math.sqrt(d2) / radius;
        // Pigment follows the SAME plateau the water does. A cone of pigment
        // under a flat puddle starts the centre so far ahead that no amount of
        // outward migration can overtake it — the rim really does end up with
        // several times the pigment it started with, and still reads lighter
        // than the middle. A brush lays colour across its contact patch, not in
        // a spike under its axis.
        const spread = Math.min(1, falloff * 3);
        const a = alpha * spread;
        const i = y * this.width + x;
        // A brush leaves a PUDDLE — a plateau held up by surface tension with a
        // thin pinned meniscus at the rim — not a cone. Pigment still follows
        // the soft falloff; only the water is flat-topped. That contrast is what
        // gives the rim somewhere to form.
        this.water[i] = Math.min(1.5, this.water[i]! + wetness * spread);
        const p = i * 4;
        this.pigment[p] = Math.min(1, this.pigment[p]! + rgb[0] * a);
        this.pigment[p + 1] = Math.min(1, this.pigment[p + 1]! + rgb[1] * a);
        this.pigment[p + 2] = Math.min(1, this.pigment[p + 2]! + rgb[2] * a);
        this.pigment[p + 3] = Math.min(1, this.pigment[p + 3]! + a);
      }
    }
    this.version++;
    this.grow(x0, y0, x1, y1);
  }

  /**
   * Advance the simulation one step. Returns the region that changed, so the
   * painter re-uploads only that.
   *
   * Three passes over the dirty rect, in the order the physics happens:
   *   1. water flows, carrying its pigment with it
   *   2. water evaporates
   *   3. pigment settles out, faster where the film is thin
   */
  step(dt = 1): DirtyRect {
    if (isEmpty(this.dirty)) return this.dirty;

    // Flow runs over the WET rect and reaches its 4-neighbours, so water can
    // land at most one pixel outside it. Measuring over the rect grown by one
    // therefore sees everything — and running FLOW over the grown rect instead
    // would push water two pixels out, where nothing would ever look at it
    // again: a slow leak that left a canvas permanently, invisibly wet.
    const fx0 = this.dirty.x0;
    const fy0 = this.dirty.y0;
    const fx1 = this.dirty.x1;
    const fy1 = this.dirty.y1;
    const x0 = Math.max(0, fx0 - 1);
    const y0 = Math.max(0, fy0 - 1);
    const x1 = Math.min(this.width - 1, fx1 + 1);
    const y1 = Math.min(this.height - 1, fy1 + 1);

    this.flow(fx0, fy0, fx1, fy1, dt);
    this.settle(x0, y0, x1, y1, dt);

    // Re-measure: a region that has fully dried must stop costing anything.
    let nx0 = this.width;
    let ny0 = this.height;
    let nx1 = -1;
    let ny1 = -1;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if (this.water[y * this.width + x]! > WET_EPSILON) {
          if (x < nx0) nx0 = x;
          if (y < ny0) ny0 = y;
          if (x > nx1) nx1 = x;
          if (y > ny1) ny1 = y;
        }
      }
    }
    this.dirty = nx1 < nx0 ? { ...EMPTY } : { x0: nx0, y0: ny0, x1: nx1, y1: ny1 };
    this.version++;
    return { x0, y0, x1, y1 };
  }

  /** Paper height at a pixel, 0..1 — the tile, wrapped. */
  private paperAt(x: number, y: number): number {
    return this.paper[(y % GRAIN_TILE) * GRAIN_TILE + (x % GRAIN_TILE)]! / 255;
  }

  /**
   * Water runs downhill, and "downhill" is its own depth PLUS the paper's
   * height — which is what makes a wash creep along the tooth's valleys and
   * granulate, rather than expanding as a tidy disc.
   */
  private flow(x0: number, y0: number, x1: number, y1: number, dt: number): void {
    const { water, pigment, scratch, scratchPigment, width } = this;
    const rate = Math.min(0.24, this.settings.flow * 0.24) * dt;

    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const i = y * width + x;
        scratch[i] = water[i]!;
        const p = i * 4;
        scratchPigment[p] = pigment[p]!;
        scratchPigment[p + 1] = pigment[p + 1]!;
        scratchPigment[p + 2] = pigment[p + 2]!;
        scratchPigment[p + 3] = pigment[p + 3]!;
      }
    }

    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const i = y * width + x;
        const w = scratch[i]!;
        if (w <= WET_EPSILON) continue;

        // Head = depth + terrain. Water only moves to a LOWER head, so this is
        // unconditionally stable and can never create water from nothing.
        const head = w + this.paperAt(x, y) * PAPER_RELIEF;
        for (let k = 0; k < 4; k++) {
          const nx = x + NEIGHBOUR_X[k]!;
          const ny = y + NEIGHBOUR_Y[k]!;
          if (nx < 0 || ny < 0 || nx >= this.width || ny >= this.height) continue;
          const j = ny * width + nx;
          const drop = head - (scratch[j]! + this.paperAt(nx, ny) * PAPER_RELIEF);
          if (drop <= 0) continue;

          const move = Math.min(w * 0.22, drop * rate);
          if (move <= 0) continue;
          water[i] = water[i]! - move;
          water[j] = water[j]! + move;

          // Pigment goes where its water goes — the bleed, in one line.
          const carried = move / w;
          const pi = i * 4;
          const pj = j * 4;
          for (let c = 0; c < 4; c++) {
            const amount = scratchPigment[pi + c]! * carried;
            pigment[pi + c] = pigment[pi + c]! - amount;
            pigment[pj + c] = pigment[pj + c]! + amount;
          }
          this.grow(nx, ny, nx, ny);
        }
      }
    }
  }

  /**
   * Evaporate, then drop pigment — and the coupling between those two is the
   * entire reason a wash gets a dark rim.
   *
   * Deposition scales with `1/water`: as the film thins, the same pigment has
   * less water to stay suspended in, so it falls out faster. The rim is the
   * thinnest water in the wash, so the rim goes darkest. Nobody draws it.
   */
  private settle(x0: number, y0: number, x1: number, y1: number, dt: number): void {
    const { water, pigment, deposit, width } = this;
    const evap = this.settings.evaporation * dt;
    const base = this.settings.deposition * dt;
    const gran = this.settings.granulation;
    const edge = this.settings.edge;

    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const i = y * width + x;
        let w = water[i]!;
        // `> 0`, not `> WET_EPSILON`: a pixel left with a trace of water below
        // the threshold is skipped by the rect measurement too, so skipping it
        // here as well abandoned it — wet for ever, invisible, and enough of
        // them to keep a "dry" layer holding measurable water.
        if (w <= 0) continue;

        // THE COFFEE RING. Evaporation is faster where the film is thin, so the
        // rim loses depth fastest; the flow pass then refills it from the
        // interior, and that outward current carries pigment to the edge where
        // it is promptly stranded. This is the mechanism behind a watercolour
        // edge — which is why nothing anywhere draws one.
        const thinFilm = 1 - Math.min(1, w / WET_FULL);
        w = Math.max(0, w - evap * (1 + 2.5 * thinFilm));
        water[i] = w;

        // DEPOSITION VS DEPTH — the curve the whole effect lives on.
        //
        // It must be near-zero in deep water and enormous in thin water. A
        // gentle 1/w gave the CENTRE of a wash a ~60% deposition rate, so the
        // centre — which starts with the most pigment — locked it in place
        // before any could migrate outward, and the rim never formed. Squaring
        // the dryness makes the contrast between "plenty of water" and "almost
        // gone" steep enough that pigment stays suspended, travels with the
        // flow, and falls out only at the drying edge.
        // The rim's strength, and it is very easy to overdo. At ×8 a drying
        // wash ended up with a nearly-opaque outline around a 63% body — a
        // 1.5× ratio, which reads as a DRAWN BORDER rather than as pigment
        // having pooled, and made every wash look like a sticker.
        //
        // Most watercolour simply fades out. The hard rim is a specific thing
        // that happens to a specific kind of wash, so it belongs to the BRUSH
        // (`edge`) and not to the medium: the gain here only decides how much a
        // brush that asks for a rim can get.
        const dryness = 1 - Math.min(1, w / WET_FULL);
        const thinness = edge * dryness * dryness * EDGE_GAIN;
        // Low points in the paper hold pigment — granulation.
        const valley = 1 + gran * (1 - this.paperAt(x, y));
        const rate = Math.min(0.9, base * (0.05 + thinness) * valley);

        const p = i * 4;
        for (let c = 0; c < 4; c++) {
          const moved = pigment[p + c]! * rate;
          pigment[p + c] = pigment[p + c]! - moved;
          deposit[p + c] = Math.min(1, deposit[p + c]! + moved);
        }

        // The last of the water takes its remaining pigment down with it —
        // otherwise a layer would never fully dry and the sim would tick for
        // ever over pixels nobody can see.
        if (w <= WET_EPSILON) {
          water[i] = 0;
          for (let c = 0; c < 4; c++) {
            deposit[p + c] = Math.min(1, deposit[p + c]! + pigment[p + c]!);
            pigment[p + c] = 0;
          }
        }
      }
    }
  }

  /**
   * DRY IT NOW — every suspended pigment settles where it stands.
   *
   * The same operation the simulation reaches on its own, done at once: this is
   * "Dry layer", and it is one loop rather than a special case because drying
   * was already defined as suspended pigment becoming deposited pigment.
   */
  dryAll(): DirtyRect {
    const was = this.dirty;
    if (isEmpty(was)) return was;
    for (let y = was.y0; y <= was.y1; y++) {
      for (let x = was.x0; x <= was.x1; x++) {
        const i = y * this.width + x;
        this.water[i] = 0;
        const p = i * 4;
        for (let c = 0; c < 4; c++) {
          this.deposit[p + c] = Math.min(1, this.deposit[p + c]! + this.pigment[p + c]!);
          this.pigment[p + c] = 0;
        }
      }
    }
    this.dirty = { ...EMPTY };
    this.version++;
    return was;
  }

  /**
   * THE DRYING FAN — evaporate hard under a moving point.
   *
   * A local multiplier on evaporation, which means the fan needs no rules of
   * its own: blow on the middle of a wash and the middle dries first, so the
   * rim it would have formed appears where you stopped blowing. That is what a
   * real hairdryer does to a wash, and it falls out of the model for free.
   */
  fan(cx: number, cy: number, radius: number, strength: number): DirtyRect {
    const x0 = Math.max(0, Math.floor(cx - radius));
    const y0 = Math.max(0, Math.floor(cy - radius));
    const x1 = Math.min(this.width - 1, Math.ceil(cx + radius));
    const y1 = Math.min(this.height - 1, Math.ceil(cy + radius));
    if (x1 < x0 || y1 < y0) return { ...EMPTY };

    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x - cx;
        const dy = y - cy;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d > radius) continue;
        const i = y * this.width + x;
        if (this.water[i]! <= 0) continue;
        this.water[i] = Math.max(0, this.water[i]! - strength * (1 - d / radius));
      }
    }
    // The settle pass turns that lost water into deposited pigment, so the fan
    // never needs to touch pigment itself.
    this.settle(x0, y0, x1, y1, 1);
    this.version++;
    return { x0, y0, x1, y1 };
  }

  /**
   * The layer as premultiplied RGBA bytes: what has settled, plus what is still
   * suspended. Written into `out` (4 bytes per pixel) so the caller can own a
   * reusable ImageData and never allocate per frame.
   */
  compose(out: Uint8ClampedArray, rect: DirtyRect = { x0: 0, y0: 0, x1: this.width - 1, y1: this.height - 1 }): void {
    for (let y = Math.max(0, rect.y0); y <= Math.min(this.height - 1, rect.y1); y++) {
      for (let x = Math.max(0, rect.x0); x <= Math.min(this.width - 1, rect.x1); x++) {
        const i = y * this.width + x;
        const p = i * 4;
        // Suspended pigment reads slightly lighter than settled pigment — wet
        // paint genuinely is lighter than the same paint dried down.
        const a = Math.min(1, this.deposit[p + 3]! + this.pigment[p + 3]! * 0.85);
        // Below half a byte the pixel IS transparent — writing colour under a
        // zero alpha would leave premultiplied garbage behind.
        if (a * 255 < 0.5) {
          out[p] = 0;
          out[p + 1] = 0;
          out[p + 2] = 0;
          out[p + 3] = 0;
          continue;
        }
        for (let c = 0; c < 3; c++) {
          const v = this.deposit[p + c]! + this.pigment[p + c]! * 0.85;
          out[p + c] = Math.round(Math.min(1, v / a) * 255);
        }
        out[p + 3] = Math.round(a * 255);
      }
    }
  }

  /** Total water on the layer — the tests' conservation check. */
  totalWater(): number {
    let sum = 0;
    for (let i = 0; i < this.water.length; i++) sum += this.water[i]!;
    return sum;
  }

  /** Total pigment, suspended plus settled. Drying must not lose any. */
  totalPigment(): number {
    let sum = 0;
    for (let i = 3; i < this.pigment.length; i += 4) sum += this.pigment[i]! + this.deposit[i]!;
    return sum;
  }
}

/** The depth at which a film counts as "plenty of water" for deposition. */
const WET_FULL = 0.6;
/** How hard thin water deposits relative to deep water — the rim's ceiling. */
const EDGE_GAIN = 2.2;
/** Below this, water is gone and the pixel stops being simulated. */
const WET_EPSILON = 0.004;
/** How much the paper's texture counts against water depth when routing flow. */
const PAPER_RELIEF = 0.05;

const NEIGHBOUR_X = [1, -1, 0, 0];
const NEIGHBOUR_Y = [0, 0, 1, -1];
