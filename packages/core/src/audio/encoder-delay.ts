/**
 * AN AUDIO ENCODER'S DELAY — where its output sits against its input.
 *
 * A lossy encoder (AAC above all) puts PRIMING in front of the signal: the
 * first frames it emits hold the filter's warm-up, and the input's first sample
 * comes out a fixed number of samples later (2112 for a typical AAC-LC encoder,
 * 2592 measured from Chrome's WebCodecs AAC on macOS, 2026-11-17). A container
 * normally removes it with an edit list. The exporter's muxer writes none, so
 * every exported film played its sound that far behind the picture: 54 ms,
 * three frames at 60 fps, which is a footstep visibly before its sound.
 *
 * The delay is a property of the encoder on this machine, not a constant to
 * hard-code, so it is MEASURED: encode an impulse, decode it, see where it
 * came out. The exporter then feeds the mix that many samples early (`leadIn`)
 * and the written audio lands on the picture. What that costs is the first
 * `delay` samples of the mix (~50 ms), which in practice is pre-roll silence.
 */

/**
 * Where an impulse placed at `impulseAt` came out of an encode → decode round
 * trip, as a delay in samples; null when the probe says nothing usable (no
 * signal, or a delay outside 0..`maxDelay`, which no real encoder has).
 */
export function impulseDelay(decoded: ArrayLike<number>, impulseAt: number, maxDelay = 8192): number | null {
  let at = -1;
  let peak = 0;
  for (let i = 0; i < decoded.length; i++) {
    const v = Math.abs(decoded[i]!);
    if (v > peak) {
      peak = v;
      at = i;
    }
  }
  if (at < 0 || peak < 1e-3) return null;
  const delay = at - impulseAt;
  return delay >= 0 && delay <= maxDelay ? delay : null;
}

/**
 * The mix as the encoder must be fed it so that its output lines up with the
 * picture: `delay` samples early, the end padded with silence so the length
 * (and so the track's duration) does not change.
 */
export function leadIn(channel: Float32Array, delay: number): Float32Array {
  if (delay <= 0) return channel;
  const out = new Float32Array(channel.length);
  out.set(channel.subarray(Math.min(delay, channel.length)));
  return out;
}
