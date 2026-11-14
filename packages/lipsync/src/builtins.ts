import { registerSpeechEngine } from "./engine";
import { registerLanguage } from "./language";
import { ALIGN, SPECTRAL, TEST_VOICE } from "./engines/meta";

/**
 * The built-in registrations — metadata only. Every `load()` is a dynamic
 * import, so none of the DSP, dictionary or synthesizer is in the root graph
 * (a test walks the static import graph to keep it that way).
 */

registerSpeechEngine({
  id: SPECTRAL.id,
  version: SPECTRAL.version,
  label: "Listen (offline)",
  description: "Hears the audio itself. Fast and offline; can't see the tongue (no L).",
  kind: "analyze",
  needs: ["pcm"],
  emits: ["X", "MBP", "AI", "E", "O", "U", "FV", "S"],
  defaults: SPECTRAL.defaults,
  load: () => import("./spectral").then((m) => m.impl),
});

registerSpeechEngine({
  id: ALIGN.id,
  version: ALIGN.version,
  label: "Words (transcript)",
  description: "Times every sound from the words — from a transcript, an AI model or a voice's own timing.",
  kind: "align",
  // text OR timed words OR timed phonemes; pcm optional (energy, rough timing for bare text)
  needs: ["words"],
  emits: ["X", "MBP", "S", "E", "AI", "O", "U", "FV", "L"],
  defaults: ALIGN.defaults,
  load: () => import("./align/index").then((m) => m.impl),
});

registerSpeechEngine({
  id: TEST_VOICE.id,
  version: TEST_VOICE.version,
  label: "Test Voice",
  description: "A built-in offline voice. Type a line; the mouth is exact.",
  kind: "synthesize",
  needs: ["text"],
  emits: ["X", "MBP", "S", "E", "AI", "O", "U", "FV", "L"],
  defaults: TEST_VOICE.defaults,
  load: () => import("./voice/index").then((m) => m.impl),
});

registerLanguage({ id: "en", label: "English", load: () => import("./g2p/index").then((m) => m.impl) });
