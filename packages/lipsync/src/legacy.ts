import { listSpeechEngines, loadSpeechEngine, registerSpeechEngine, speechEngine, type SpeechEngine, type SpeechTrack } from "./engine";
import type { AnalyzeOptions, AudioInput, LipSyncAnalysis, PhonemeEngine } from "./types";

/**
 * @deprecated The pre-2.0 `PhonemeEngine` API as a VIEW of the one
 * `SpeechEngine` registry — so the LipSync plugin keeps working while the
 * Character tab replaces it. There is no second registry: these functions
 * read and write the same map.
 */

const views = new WeakMap<SpeechEngine, PhonemeEngine>();

function asPhonemeEngine(e: SpeechEngine): PhonemeEngine {
  let v = views.get(e);
  if (!v) {
    v = {
      id: e.id,
      version: e.version,
      name: e.label,
      description: e.description ?? "",
      emits: e.emits,
      async analyze(input: AudioInput, opts: AnalyzeOptions = {}): Promise<LipSyncAnalysis> {
        const impl = await loadSpeechEngine(e);
        if (impl.kind !== "analyze") throw new Error(`${e.label} is not an analyze engine`);
        const { onProgress, ...settings } = opts;
        const track = await impl.analyze({ pcm: input }, settings, { onProgress });
        return trackToAnalysis(track, input.sampleRate);
      },
    };
    views.set(e, v);
  }
  return v;
}

const isPcmAnalyzer = (e: SpeechEngine) => e.kind === "analyze" && e.needs.every((n) => n === "pcm");

/** A SpeechTrack in the legacy analysis shape. */
export function trackToAnalysis(track: SpeechTrack, sampleRate: number): LipSyncAnalysis {
  return {
    engineId: track.engine,
    engineVersion: track.version,
    sampleRate,
    durationMs: track.durationMs,
    cues: track.cues,
    energy: track.energy,
  };
}

/** @deprecated Use `registerSpeechEngine`. */
export function registerPhonemeEngine(engine: PhonemeEngine): void {
  registerSpeechEngine({
    id: engine.id,
    version: engine.version,
    label: engine.name,
    description: engine.description,
    kind: "analyze",
    needs: ["pcm"],
    emits: engine.emits,
    load: async () => ({
      kind: "analyze",
      async analyze(input, settings = {}, run = {}) {
        const num = (k: string) => (typeof settings[k] === "number" ? (settings[k] as number) : undefined);
        const a = await engine.analyze(input.pcm, {
          minCueMs: num("minCueMs"),
          smoothing: num("smoothing"),
          sensitivity: num("sensitivity"),
          onProgress: run.onProgress,
        });
        return { engine: a.engineId, version: a.engineVersion, settingsKey: "", durationMs: a.durationMs, cues: a.cues, energy: a.energy };
      },
    }),
  });
}

/** @deprecated Use `speechEngine`. */
export function phonemeEngine(id: string): PhonemeEngine | undefined {
  const e = speechEngine(id);
  return e && isPcmAnalyzer(e) ? asPhonemeEngine(e) : undefined;
}

/** @deprecated Use `listSpeechEngines("analyze")`. */
export function listPhonemeEngines(): PhonemeEngine[] {
  return listSpeechEngines("analyze").filter(isPcmAnalyzer).map(asPhonemeEngine);
}
