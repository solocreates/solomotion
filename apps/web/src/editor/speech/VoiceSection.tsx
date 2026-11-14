"use client";

import * as React from "react";
import {
  bakeMouth,
  clipForAsset,
  LIP_SYNC_FEELS,
  mouthOf,
  mediaAssetOf,
  placeClip,
  setMouthVoice,
  voiceClipNamed,
  voiceClipsIn,
  type AssetSpeech,
  type MotionDocument,
  type GroupClip,
  type LipSyncFeel,
} from "@solomotion/core";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Range } from "@/components/ui/range";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "@/lib/toast";
import { PanelSection, PropRow } from "../inspector/controls";
import { useDoc, useDocStore } from "../state/document-context";
import { useSession } from "../state/session";
import { importFileAsAsset } from "../assets/import";
import { useCharacterPick } from "../character/pick-state";
import { ensureSpeechTrack, installKnownTrack, speechEngineChoices, useSpeechStatus } from "./speech-host";
import { sayLine } from "./test-voice";
import { VoicePicker } from "./VoicePicker";

/**
 * VOICE — the Character tab's second section (ux.md §2.3, copy from §4.2).
 * One line field (the Test Voice), the voice the mouth follows, how it is
 * heard (Engine), how it is acted (Feel, Energy), and Bake to keys. No
 * paragraphs, no Regenerate: the mouth is live. The voice IS the mouth's Lip
 * sync behavior's `voice` (core `setMouthVoice`) — the card below edits the
 * same field. A character with no mouth gets one here: one click on the stage.
 */

const FEEL_LABEL: Record<LipSyncFeel, string> = { natural: "Natural", snappy: "Snappy", relaxed: "Relaxed", mumble: "Mumble", shout: "Shout" };
export function VoiceSection({ character }: { character: GroupClip }) {
  const doc = useDoc();
  const store = useDocStore();
  const mouth = mouthOf(doc, character);
  // Every voice ("") has no one recording; its settings are the line over the character.
  const voice = mouth?.voice
    ? voiceClipNamed(doc, character.frameId, mouth.voice)
    : mouth?.voice === ""
      ? (voiceClipsIn(doc, character.frameId).find((c) => c.startMs < character.startMs + character.durationMs && c.startMs + c.durationMs > character.startMs) ?? null)
      : null;
  const assetId = voice ? mediaAssetOf(voice) : null;
  const asset = assetId ? doc.assets.find((a) => a.id === assetId) : undefined;
  const status = useSpeechStatus(assetId);
  const [line, setLine] = React.useState("");
  const [saying, setSaying] = React.useState(false);

  if (!mouth)
    return (
      <PanelSection id="voice" title="Voice">
        <PropRow wide>
          <Button variant="outline" size="sm" className="h-7 w-full text-xs" title="Click on the stage where it goes" onClick={() => useCharacterPick.getState().start(character.id, "mouth")}>
            <Plus /> Add mouth
          </Button>
        </PropRow>
      </PanelSection>
    );

  const setVoice = (name: string | null) => store.update(name === null ? "Stop lip sync" : "Lip sync", (d) => void setMouthVoice(d, mouth, name));

  const setSpeech = (label: string, patch: Partial<AssetSpeech>) =>
    assetId &&
    store.update(label, (d) => {
      const a = d.assets.find((x) => x.id === assetId);
      if (a) a.speech = { engine: "auto", ...a.speech, ...patch };
    });

  const say = async () => {
    const text = line.trim();
    if (!text || saying) return;
    setSaying(true);
    try {
      const said = await sayLine(text);
      const imported = await importFileAsAsset(store, said.file);
      if (!imported) return;
      const at = useSession.getState().playheadMs;
      let name = "";
      store.update("Say line", (d) => {
        const a = d.assets.find((x) => x.id === imported.id);
        if (a) a.origin = said.origin;
        const frame = d.frames.find((f) => f.id === character.frameId);
        if (!a || !frame) return;
        const clip = clipForAsset(a, { frameId: frame.id, startMs: at }, frame);
        clip.name = uniqueName(d, character.frameId, text);
        placeClip(d, clip, { landing: "settle" });
        name = clip.name;
        // A mouth that hears every voice hears this one already.
        if (mouth.voice !== "") setMouthVoice(d, mouth, name);
      });
      await installKnownTrack(imported.id, said.result, said.result.words);
      setLine("");
      useSession.getState().setPlayhead(at);
      useSession.getState().setPlaying(true);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't say that");
    } finally {
      setSaying(false);
    }
  };

  const bake = async () => {
    if (!voice || !assetId) return;
    const track = await ensureSpeechTrack(assetId);
    if (!track) return;
    store.update("Bake to keys", (d) => {
      const at = mouth.setId ? { groupId: mouth.groupId, setId: mouth.setId } : setMouthVoice(d, mouth, voice.name);
      if (at) bakeMouth(d, at.groupId, at.setId, voice.id);
    });
    toast("Mouth baked to keys — moving the voice won't re-sync now.");
  };

  const engines = speechEngineChoices();
  const fixes = asset?.speech?.edits?.length ?? 0;
  const feel = (LIP_SYNC_FEELS as readonly string[]).includes(asset?.speech?.feel ?? "") ? (asset!.speech!.feel as LipSyncFeel) : "natural";
  const energy = asset?.speech?.energy ?? 1;

  return (
    <PanelSection id="voice" title="Voice">
      <PropRow wide>
        <Input
          value={line}
          disabled={saying}
          placeholder={saying ? "Saying it…" : "Type a line — Enter to hear it"}
          className="h-7 text-xs"
          onChange={(e) => setLine(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void say();
            if (e.key === "Escape") e.currentTarget.blur();
          }}
        />
      </PropRow>
      <PropRow label="Voice" hint="The sound this mouth follows">
        <VoicePicker frameId={character.frameId} value={mouth.voice} onChange={setVoice} onNone={() => setVoice(null)} />
      </PropRow>
      {asset && (
        <>
          <PropRow label="Engine" hint="Auto picks Words when a transcript exists">
            <Select value={asset.speech?.engine ?? "auto"} onValueChange={(engine) => setSpeech("Voice engine", { engine })}>
              <SelectTrigger className="h-7 min-w-0 flex-1 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">Auto</SelectItem>
                {engines.map((e) => (
                  <SelectItem key={e.id} value={e.id} disabled={!e.available} title={e.description}>
                    {e.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </PropRow>
          <PropRow label="Feel">
            <Select value={feel} onValueChange={(f) => setSpeech("Voice feel", { feel: f })}>
              <SelectTrigger className="h-7 min-w-0 flex-1 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LIP_SYNC_FEELS.map((f) => (
                  <SelectItem key={f} value={f}>
                    {FEEL_LABEL[f]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </PropRow>
          <PropRow label="Energy" hint="How wide it opens. Whisper low, shout high">
            <Range
              value={energy}
              min={0}
              max={2}
              step={0.05}
              defaultValue={1}
              ticks={[1]}
              aria-label="Energy"
              format={(v) => `${Math.round(v * 100)}%`}
              onChange={(v) => setSpeech("Voice energy", { energy: v })}
            />
          </PropRow>
          <SpeechStatusRow status={status} onRetry={() => assetId && void ensureSpeechTrack(assetId, undefined, { force: true })} />
          {fixes > 0 && (
            <PropRow label=" ">
              <span className="flex min-w-0 flex-1 items-center justify-between text-[11px] text-muted-foreground">
                {fixes} hand {fixes === 1 ? "fix" : "fixes"}
                <Button variant="ghost" size="sm" className="h-6 px-2 text-[11px]" onClick={() => setSpeech("Clear hand fixes", { edits: undefined })}>
                  Clear hand fixes
                </Button>
              </span>
            </PropRow>
          )}
          <PropRow wide>
            <Button variant="outline" size="sm" className="h-7 w-full text-xs" title="Turn the mouth into keys you edit" onClick={() => void bake()}>
              Bake to keys
            </Button>
          </PropRow>
        </>
      )}
    </PanelSection>
  );
}

function SpeechStatusRow({ status, onRetry }: { status: ReturnType<typeof useSpeechStatus>; onRetry: () => void }) {
  if (!status) return null;
  if (status.state === "listening")
    return (
      <PropRow label=" ">
        <span className="text-[11px] text-muted-foreground">Listening… {Math.round(status.progress * 100)}%</span>
      </PropRow>
    );
  if (status.state === "failed")
    return (
      <PropRow label=" ">
        <span className="flex min-w-0 flex-1 items-center justify-between text-[11px] text-amber-500">
          Couldn&apos;t hear a voice in this clip
          <Button variant="ghost" size="sm" className="h-6 px-2 text-[11px]" onClick={onRetry}>
            Try again
          </Button>
        </span>
      </PropRow>
    );
  return status.note ? (
    <PropRow label=" ">
      <span className="text-[11px] text-muted-foreground">{status.note}</span>
    </PropRow>
  ) : null;
}

/** A clip name for a line — the line itself, trimmed, unique in the comp. */
function uniqueName(doc: MotionDocument, frameId: string, text: string): string {
  const base = text.replace(/\s+/g, " ").trim().slice(0, 32) || "Line";
  const taken = new Set(doc.tracks.flatMap((t) => t.clips).filter((c) => c.frameId === frameId).map((c) => c.name.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base} ${i}`.toLowerCase())) return `${base} ${i}`;
}
