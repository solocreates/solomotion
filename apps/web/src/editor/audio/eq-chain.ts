import { eqTypeUsesGain, type AudioEqBand } from "@solomotion/core";

/**
 * The ONE place a parametric EQ band list becomes WebAudio `BiquadFilterNode`s.
 * Shared by the live conductor, the exporter and the offline bake so all three
 * apply EQ identically — there is no second copy of "band → biquad" to drift.
 * The band model + the drawn magnitude curve live in core (`audio/eq.ts`); this
 * is only the graph plumbing.
 */

/** Point a biquad node at one band's current type/freq/gain/Q. */
export function applyBandToNode(node: BiquadFilterNode, band: AudioEqBand): void {
  node.type = band.type;
  node.frequency.value = band.freqHz;
  node.Q.value = band.q;
  // Pass/notch filters ignore gain; setting it is harmless but keep it at 0 so
  // a later retype doesn't inherit a stale boost.
  node.gain.value = eqTypeUsesGain(band.type) ? band.gainDb : 0;
}

/** A fresh biquad node configured for a band. */
export function makeBiquad(ctx: BaseAudioContext, band: AudioEqBand): BiquadFilterNode {
  const node = ctx.createBiquadFilter();
  applyBandToNode(node, band);
  return node;
}

/**
 * Build a static EQ filter chain from a band list and return its input/output
 * nodes (already connected in series). Returns null when there are no enabled
 * bands, so the caller wires its source straight through. Used by export + bake
 * (static per render); the live conductor manages its own rebuildable chain so
 * it can keep a single `MediaElementAudioSourceNode` alive.
 */
export function buildStaticEqChain(
  ctx: BaseAudioContext,
  bands: AudioEqBand[],
): { input: AudioNode; output: AudioNode } | null {
  const active = bands.filter((b) => b.enabled);
  if (active.length === 0) return null;
  const nodes = active.map((b) => makeBiquad(ctx, b));
  for (let i = 0; i < nodes.length - 1; i++) nodes[i]!.connect(nodes[i + 1]!);
  return { input: nodes[0]!, output: nodes[nodes.length - 1]! };
}
