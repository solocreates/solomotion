/**
 * THE GAIN A WEB AUDIO COMPRESSOR ADDS BY ITSELF.
 *
 * `DynamicsCompressorNode` is specified with an automatic makeup gain that
 * cannot be switched off: (1 / the curve's gain at 0 dBFS) ^ 0.6 (Web Audio
 * spec › DynamicsCompressorNode processing; Chromium's DynamicsCompressorKernel,
 * which WebKit and Gecko share). A speech leveler at −26 dB, 3:1 squeezes a
 * full-scale signal by ~17 dB, so the browser quietly adds ~10 dB back — every
 * narrated export came out ~10 dB too loud. Any compressor whose makeup should
 * mean what it says multiplies its output by `dbToGain(wanted − this)`.
 *
 * Pure: the same curve the engine computes, so it runs in a test and on every
 * engine that implements the spec.
 */
const db2lin = (db: number): number => 10 ** (db / 20);
const lin2db = (x: number): number => (x > 0 ? 20 * Math.log10(x) : -1000);

/** The engine's static curve, linear in → linear out, for one setting. */
function compressionCurve(thresholdDb: number, kneeDb: number, ratio: number): (x: number) => number {
  const linThreshold = db2lin(thresholdDb);
  const slope = 1 / Math.max(1, ratio);
  if (kneeDb <= 0.001) {
    return (x) => (x <= linThreshold ? x : db2lin(thresholdDb + (lin2db(x) - thresholdDb) * slope));
  }
  const knee = (x: number, k: number) => linThreshold + (1 - Math.exp(-k * (x - linThreshold))) / k;
  const slopeAt = (x: number, k: number) => {
    const x2 = x * 1.001;
    return (lin2db(knee(x2, k)) - lin2db(knee(x, k))) / (lin2db(x2) - lin2db(x));
  };
  // The knee's sharpness k is chosen so the knee meets the ratio's slope at its
  // end — the engine's own geometric bisection, same bounds, same steps.
  const kneeEnd = db2lin(thresholdDb + kneeDb);
  let lo = 0.1;
  let hi = 10000;
  let k = 5;
  for (let i = 0; i < 15; i++) {
    if (slopeAt(kneeEnd, k) < slope) hi = k;
    else lo = k;
    k = Math.sqrt(lo * hi);
  }
  const kneeEndOutDb = lin2db(knee(kneeEnd, k));
  return (x) => {
    if (x < linThreshold) return x;
    if (x < kneeEnd) return knee(x, k);
    return db2lin(kneeEndOutDb + (lin2db(x) - (thresholdDb + kneeDb)) * slope);
  };
}

/** The makeup gain, dB, a `DynamicsCompressorNode` applies on its own at these settings. */
export function webAudioAutoMakeupDb(thresholdDb: number, kneeDb: number, ratio: number): number {
  const fullRangeGain = compressionCurve(thresholdDb, Math.max(0, kneeDb), ratio)(1);
  return 0.6 * -lin2db(fullRangeGain);
}
