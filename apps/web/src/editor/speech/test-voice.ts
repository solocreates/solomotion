"use client";

import type { AssetOrigin } from "@solomotion/core";
import { runSpeechEngine, type SynthesisResult } from "@solomotion/lipsync";
import { TEST_VOICE_MODEL, TEST_VOICE_PROVIDER } from "./speech-host";

/**
 * THE TEST VOICE, as a file — type a line, get audio + its EXACT mouth,
 * offline. The formant synth is the package's (lazy chunk); this only turns
 * its PCM into a WAV the media library can hold and stamps the provenance
 * Auto later recognises (so a reload re-synthesises the same exact cues from
 * the asset's own prompt instead of listening to it).
 */

export const TEST_VOICE_PRESETS = ["warm", "bright", "robo"] as const;

/** `"test"`, `"test:bright"` → the preset; anything else is a real provider's voice. */
export function testVoicePreset(voice: string | undefined): string | null {
  if (!voice) return null;
  const m = /^test(?::(\w+))?$/i.exec(voice.trim());
  if (!m) return null;
  const preset = (m[1] ?? "warm").toLowerCase();
  return (TEST_VOICE_PRESETS as readonly string[]).includes(preset) ? preset : "warm";
}

export async function sayLine(text: string, preset = "warm"): Promise<{ file: File; result: SynthesisResult; origin: AssetOrigin }> {
  const result = (await runSpeechEngine("test-voice", { text }, { preset })) as SynthesisResult;
  const { toWav } = await import("@solomotion/lipsync/voice");
  const name = `${text.trim().replace(/\s+/g, " ").slice(0, 40) || "Line"}.wav`;
  const file = new File([toWav(result.pcm, result.sampleRate) as BlobPart], name, { type: "audio/wav" });
  const origin: AssetOrigin = {
    kind: "generated",
    capability: "speech",
    provider: TEST_VOICE_PROVIDER,
    model: preset === "warm" ? TEST_VOICE_MODEL : `${TEST_VOICE_MODEL}:${preset}`,
    prompt: text,
    at: Date.now(),
    parentAssetId: null,
  };
  return { file, result, origin };
}
