/**
 * @solomotion/lipsync — the headless SPEECH foundation.
 *
 * Root: the contracts and the cheap tables — visemes, ARPAbet phonemes,
 * alphabets (Rhubarb, Preston Blair, Disney 12, Oculus 15, ARKit weights), the
 * SpeechEngine registry, SpeechTrack + cache keys, cue post-processing, the
 * loudness envelope, the evaluation harness. Zero deps, zero DOM.
 *
 * Heavy parts are lazy subpaths that engines `load()`:
 *   @solomotion/lipsync/spectral  offline DSP analyzer
 *   @solomotion/lipsync/g2p       English letter-to-sound + dictionary
 *   @solomotion/lipsync/align     words/phonemes with times → cues (AI bridge)
 *   @solomotion/lipsync/voice     the Test Voice formant synthesizer
 */

import "./builtins";
import { phonemeEngine } from "./legacy";
import type { PhonemeEngine } from "./types";

export {
  VISEME_IDS,
  VISEMES,
  VISEME_ORDER,
  VISEME_FALLBACKS,
  resolveVisemeArt,
  type VisemeId,
  type VisemeInfo,
} from "./visemes";
export {
  ARPABET,
  PHONEMES,
  SILENCE,
  isPhoneme,
  isVowel,
  phonemeWeight,
  phonemeToViseme,
  parseArpabet,
  ipaToArpabet,
  type Phoneme,
  type PhonemeOrSilence,
  type PhonemeClass,
  type PhonemeInfo,
  type PhonemeToken,
  type TimedPhoneme,
  type Stress,
} from "./phonemes";
export {
  registerVisemeAlphabet,
  visemeAlphabet,
  listVisemeAlphabets,
  toAlphabet,
  fromAlphabet,
  canonicalViseme,
  normalizeShapeName,
  ARKIT_MOUTH_SHAPES,
  ARKIT_VISEME_WEIGHTS,
  arkitWeights,
  type AlphabetShape,
  type VisemeAlphabet,
  type ArkitShape,
  type ArkitWeights,
} from "./alphabets";
export {
  registerSpeechEngine,
  speechEngine,
  listSpeechEngines,
  loadSpeechEngine,
  runSpeechEngine,
  checkNeeds,
  settingsKey,
  speechCacheKey,
  numSetting,
  strSetting,
  boolSetting,
  SpeechError,
  type SpeechEngine,
  type SpeechEngineKind,
  type SpeechNeed,
  type SpeechTrack,
  type SpeechWord,
  type SpeechEnergy,
  type SpeechInput,
  type SpeechSettings,
  type SettingValue,
  type SynthesisResult,
  type RunOptions,
  type EngineImpl,
  type AnalyzeImpl,
  type AlignImpl,
  type SynthesizeImpl,
  type SpeechErrorCode,
} from "./engine";
export { registerLanguage, listLanguages, loadLanguage, type Language, type LanguageImpl, type G2PToken, type PauseMark } from "./language";
export {
  labelsToCues,
  modeFilter,
  normalizeCues,
  phonemesToCues,
  overlayCues,
  quantizeCues,
  cueIndexAt,
  planMouthSpans,
  visemeAt,
  type CueEdit,
  type MouthSpan,
  type PlanOptions,
} from "./cues";
export {
  registerRemoteSpeechEngine,
  remoteToInput,
  fromElevenLabsAlignment,
  fromSecondsWords,
  charactersToWords,
  type RemoteSpeechResult,
  type RemoteEngineSpec,
  type ElevenLabsAlignment,
} from "./remote";
export { shapeCues, FEEL_PROFILES, VISEME_PRIORITY, type MouthProfile, type FeelProfile, type FeelOptions } from "./shape";
export { evaluateCues, type CueScore, type EvaluateOptions } from "./evaluate";
export { energyEnvelope, energyFromCues, energyAt, VISEME_OPENNESS, type EnvelopeOptions } from "./energy";
export type { AudioInput, AnalyzeOptions, LipSyncAnalysis, PhonemeEngine, VisemeCue } from "./types";
export { registerPhonemeEngine, phonemeEngine, listPhonemeEngines, trackToAnalysis } from "./legacy";

/** @deprecated The spectral engine in the legacy shape (its analyze lazy-loads `/spectral`). */
export const spectralEngine: PhonemeEngine = phonemeEngine("spectral")!;
