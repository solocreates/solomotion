"use client";

import { givesWordTimings, modelsFor, pickModel, transcribe, type Connection, type MediaCapability } from "@solomotion/agent";
import { charactersToWords, registerRemoteSpeechEngine, type RemoteSpeechResult, type SpeechInput, type SpeechWord } from "@solomotion/lipsync";
import { getAssetBlob } from "../assets/asset-store";

/**
 * THE AI BRIDGE FOR SPEECH — connections in, timed words out; the package's
 * align engine does the rest (G2P, timing, cues, energy).
 *
 *  - TRANSCRIPTION: a connection that gives word timings turns a recording
 *    into words → align. Auto uses it when one is routed (paid once per
 *    asset; the words persist).
 *  - TTS ALIGNMENT: a speech provider that returns its own timing (ElevenLabs
 *    `with-timestamps`) hands it over at generation; the host installs it as
 *    the asset's words (`ttsWords`).
 *  - REMOTE PHONEMES: any connection that returns phonemes/visemes/words
 *    with times registers as an engine (`registerConnectionSpeechEngine`)
 *    and appears in the Engine picker.
 *
 * Routing comes from the same `connectionFor` the media verbs use, set once
 * by the host verbs (`setSpeechRoutes`).
 */

export interface SpeechRoutes {
  connectionFor(capability: MediaCapability): Connection | null;
}

let routes: SpeechRoutes | null = null;

export function setSpeechRoutes(r: SpeechRoutes | null): void {
  routes = r;
}

function transcriber(): { connection: Connection; model: string } | null {
  const connection = routes?.connectionFor("transcription") ?? null;
  if (!connection) return null;
  const timed = modelsFor(connection, "transcription").find((m) => givesWordTimings(connection, m.id));
  const model = timed?.id ?? pickModel(connection, "transcription", "audio")?.id;
  return model && givesWordTimings(connection, model) ? { connection, model } : null;
}

/** Is a word-timed transcription connection routed? */
export function canTranscribe(): boolean {
  return transcriber() !== null;
}

/** OpenAI-style endpoints take 25 MB a request; past that, Auto listens instead. */
const MAX_BYTES = 24 * 1024 * 1024;

/** Timed words of an asset, in its own (source) time. Empty when there is no route or no speech. */
export async function transcribeAsset(assetId: string): Promise<SpeechWord[]> {
  const t = transcriber();
  if (!t) return [];
  const blob = await getAssetBlob(assetId);
  if (!blob || blob.size > MAX_BYTES) return [];
  const result = await transcribe({ ...t, audio: blob });
  return result.words.map((w) => ({ text: w.text.trim(), startMs: w.startMs, endMs: w.endMs })).filter((w) => w.text);
}

/** A TTS provider's own character timing → words for the asset it voiced. */
export function ttsWords(alignment: { characters: string[]; startMs: number[]; endMs: number[] }): SpeechWord[] {
  return charactersToWords(alignment.characters, alignment.startMs, alignment.endMs);
}

/**
 * Register a connection that returns phonemes (or words/visemes) with times
 * as a speech engine — the "remote phonemes" slot. `request` does the network
 * call; everything after is the package's.
 */
export function registerConnectionSpeechEngine(spec: {
  id: string;
  label: string;
  version?: number;
  request: (input: SpeechInput, signal?: { readonly aborted: boolean }) => Promise<RemoteSpeechResult>;
}): void {
  registerRemoteSpeechEngine({ id: spec.id, version: spec.version ?? 1, label: spec.label, request: spec.request });
}
