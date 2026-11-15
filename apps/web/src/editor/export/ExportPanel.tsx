"use client";

import { withOriginals } from "../render/render-in-place";
import { useAppShell } from "../state/app-shell";
import * as React from "react";
import {
  FREE_MAX_LONGEST_EDGE,
  frameDurationMs,
  frameFps,
  isWithinFreeTier,
  matchResolution,
  maxFreeScale,
  qualityBitrate,
  resolutionOptions,
  DEFAULT_VIDEO_QUALITY,
  VIDEO_QUALITY_TIERS,
  type VideoQualityId,
  targetCapabilities,
  targetFrameIds,
  frameTarget,
  planExportPages,
  countEveryFramePages,
  type PageSampling,
  type ExportMedium,
  type ExportTarget,
  type Frame,
  type LottieLayerReport,
  type MotionDocument,
  formatFps,
  creditsText,
  iconCredits,
  rendersWithin,
  withMixOverride,
} from "@solomotion/core";
import {
  ExportError,
  entityRef,
  reportError,
  supervise,
  type TaskSignal,
} from "@solomotion/core";
import {
  AudioLines,
  Box,
  Braces,
  ChevronDown,
  Copy,
  FileCode2,
  FileImage,
  FileText,
  Film,
  Images,
  Loader2,
  Lock,
  Settings2,
  Sparkles,
} from "lucide-react";
import { toast } from "@/lib/toast";
import { renderJobs, renderLineBusy } from "./render-queue";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { NumberInput } from "@/components/ui/number-input";
import { FpsControl } from "@/components/ui/fps-control";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import { Meter, Range } from "@/components/ui/range";
import { product } from "../product";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { Segmented } from "@/components/ui/segmented";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useDoc, useDocStore } from "../state/document-context";
import { useIconSets } from "../plugins/icons/use-icon-data";
import { useFeatureGate } from "../entitlements";
import { useSession, useParkedPlayhead } from "../state/session";
import { useWorkRange } from "../timeline/work-range";
import { drawFrameContent } from "../stage/render/draw-frame";
import { dryWetPaint } from "../drawing/wet-actions";
import {
  exportAudioOnly,
  exportGif,
  exportMp4,
  exportPng,
  exportLosslessMov,
  exportPngSequence,
  exportWebm,
  audioEncoderSummary,
  mp4Supported,
  realtimeContainer,
  type VideoExportOptions,
} from "./export-media";
import { undecodableAssetsFromLastBounce } from "./export-audio";
import { missingMedia } from "../assets/media-usage";
import { buildLottie, exportLottieFile, exportSvgFile } from "./export-vector";
import { boundsSampleTimes, measureTargetBounds, type ExportBounds } from "./target-bounds";
import { exportPdf, type PdfImageFormat, type PdfRender } from "./export-pdf";
import { collectSaves, safeFileName, saveExport, saveZip, type SaveSink } from "./save";
import { contextOf } from "../state/navigation";
import { NAMES } from "@/editor/names";

/**
 * The ONE export form. The export dialog, the sidebar Export section (every
 * layer, group, selection and frame) and the topbar menu all render this
 * panel — same fields, same smart defaults, same pipeline underneath.
 *
 * `targetCapabilities` decides everything contextual: which media tabs exist,
 * whether the panel opens on Image or Video (anything that moves defaults to
 * Video), whether SVG is true vector / outlined text / mixed, and whether a
 * sound toggle is worth showing. Layer targets render through the exact same
 * exporters as frames — scoped by `onlyClipIds` + a measured crop region.
 */

type ImageFormat = "png" | "svg";
type VideoFormat = "mp4" | "mov" | "webm" | "gif" | "png-seq" | "audio";

const SCALE_OPTIONS = [0.5, 1, 1.5, 2, 3, 4] as const;

const MEDIUM_LABEL: Record<ExportMedium, string> = { image: "Image", video: "Video", lottie: "Lottie", pdf: "PDF", model: "3D model" };

type ModelFormat = "glb" | "gltf" | "usdz" | "obj" | "stl" | "ply";
const MODEL_FORMATS: Array<{ value: ModelFormat; label: string; hint: string }> = [
  { value: "glb", label: "GLB", hint: "glTF binary — the standard. Blender, Unity, the web, AR" },
  { value: "usdz", label: "USDZ", hint: "Apple AR Quick Look on iPhone and iPad" },
  { value: "obj", label: "OBJ", hint: "Geometry for any 3D app" },
  { value: "stl", label: "STL", hint: "3D printing, in millimetres" },
  { value: "gltf", label: "glTF", hint: "glTF as JSON" },
  { value: "ply", label: "PLY", hint: "Points and polygons" },
];

function fmtDuration(ms: number): string {
  const s = ms / 1000;
  return s >= 60 ? `${Math.floor(s / 60)}m ${(s % 60).toFixed(1)}s` : `${s.toFixed(1)}s`;
}

/**
 * Siblings stripped: a doc whose target frame holds ONLY the target clips.
 * Nested source comps and other frames stay — this is how one exporter set
 * renders (and bounces audio for) a layer without a second pipeline.
 */
function scopedDoc(doc: MotionDocument, target: ExportTarget): MotionDocument {
  if (target.clipIds.length === 0) return doc;
  const keep = new Set(target.clipIds);
  return {
    ...doc,
    tracks: doc.tracks.map((t) => ({
      ...t,
      clips: t.clips.filter((c) => c.frameId !== target.frameId || keep.has(c.id)),
    })),
  };
}

export function ExportPanel({
  target,
  variant,
  initialMedium,
  onRenderingChange,
  onDone,
  cancelRef,
}: {
  target: ExportTarget;
  variant: "dialog" | "sidebar";
  /** Preselect a media tab (menu intent); null/undefined = smart default. */
  initialMedium?: ExportMedium | null;
  /** The dialog uses this to guard accidental closes mid-render. */
  onRenderingChange?: (rendering: boolean) => void;
  onDone?: () => void;
  /** Filled with this panel's own cancel — for a host that closes mid-render. */
  cancelRef?: React.MutableRefObject<(() => void) | null>;
}) {
  const doc = useDoc();
  const store = useDocStore();
  const frame = doc.frames.find((f) => f.id === target.frameId) ?? doc.frames[0]!;
  const caps = React.useMemo(() => targetCapabilities(doc, target), [doc, target]);
  const targetKey = `${target.frameId}:${target.clipIds.join(",")}:${target.frameIds?.join(",") ?? ""}`;
  const isLayer = target.clipIds.length > 0;
  /** Several frames at once — one PDF, or one file each (zipped). */
  const isBatch = target.kind === "frames";
  const frameIds = React.useMemo(() => targetFrameIds(target), [target]);
  const mp4Ok = React.useMemo(() => mp4Supported(), []);
  // What the realtime recorder would actually write here. WebKit's
  // MediaRecorder makes MP4, not WebM, so the option has to be named for what
  // this engine produces rather than for what the code used to hope for.
  const realtime = React.useMemo(() => realtimeContainer(true) ?? "webm", []);
  const realtimeLabel = realtime === "mp4" ? "MP4 (realtime)" : "WebM";
  /**
   * Offer the realtime recorder only when it is worth having.
   *
   * It exists as the compatibility path for browsers with no WebCodecs. Where
   * WebCodecs DOES exist and the recorder would write MP4 anyway — WebKit — it
   * is a slower, frame-dropping duplicate of the real MP4 export, and on iOS it
   * produced a file that would not play at all. A format that is strictly worse
   * and sometimes broken is not a choice; it is a trap with a label on it.
   */
  const showRealtime = !mp4Ok || realtime === "webm";
  const audioPath = React.useMemo(() => audioEncoderSummary(), []);
  // What the LAST export actually did about sound. A phone has no console, so
  // this is where "why is my export silent?" gets answered — on the device,
  // next to the button that made the file.
  const [audioReport, setAudioReport] = React.useState<string | null>(null);
  // The single money seam: raster resolution above 720p-class is Pro.
  const hiResGate = useFeatureGate("export.highres");

  // ── Form state (smart defaults per target) ─────────────────────────────────
  const [medium, setMedium] = React.useState<ExportMedium>(
    initialMedium && caps.media.includes(initialMedium) ? initialMedium : caps.defaultMedium,
  );
  const [imageFormat, setImageFormat] = React.useState<ImageFormat>(caps.svg === "vector" ? "svg" : "png");
  const [modelFormat, setModelFormat] = React.useState<ModelFormat>("glb");
  /** glTF: carry the comp's motion (objects and camera) in the file. */
  const [modelAnimate, setModelAnimate] = React.useState(true);
  const [videoFormat, setVideoFormat] = React.useState<VideoFormat>(mp4Ok ? "mp4" : "webm");
  /** PDF: a page per frame as it stands, or a page per frame of its animation. */
  const [pdfPages, setPdfPages] = React.useState<PageSampling>("current");
  /** PDF: vector where exact (falls back per page), or every page an exact image. */
  const [pdfRender, setPdfRender] = React.useState<PdfRender>(caps.svg === "mixed" ? "image" : "vector");
  const [pdfImage, setPdfImage] = React.useState<PdfImageFormat>("jpeg");
  const [scale, setScale] = React.useState(1);
  // A user pick pins the scale; until then we keep it on the free-safe default so
  // a free user never opens the panel already staring at a locked resolution.
  const scaleTouched = React.useRef(false);
  const pickScale = React.useCallback((s: number) => {
    scaleTouched.current = true;
    setScale(s);
  }, []);
  const [fpsOverride, setFpsOverride] = React.useState<number | null>(null);
  /**
   * The render-setting level of motion blur's three-level model. On by default:
   * an export is a render, not a playback, so this is the one moment the extra
   * samples are unambiguously worth paying for. It can only ever turn a comp's
   * shutters OFF — nothing here makes a layer blur that is not already blurring.
   */
  const [motionBlur, setMotionBlur] = React.useState(true);
  /** Layers rendered in place: export the renders (what you see), or put
   *  every original back for this export only. Offered when there are any. */
  const [rerenderOriginals, setRerenderOriginals] = React.useState(false);
  const hasRenders = React.useMemo(() => rendersWithin(doc, target.frameId, target.clipIds), [doc, target]);
  const [transparent, setTransparent] = React.useState(isLayer);
  const [includeBackground, setIncludeBackground] = React.useState(!isLayer);
  const [includeAudio, setIncludeAudio] = React.useState(true);
  /**
   * The leveler's render switch — motion blur's model: it STARTS as the comp
   * plays it (its own leveler on or off, at its own strength) and can be
   * flipped for this one file without touching the project.
   */
  const [leveler, setLeveler] = React.useState(frame.soundMix.leveler.enabled);
  const [levelStrength, setLevelStrength] = React.useState(frame.soundMix.leveler.strength);
  const [scope, setScope] = React.useState<"span" | "full">(isLayer ? "span" : "full");
  // Quality, not bitrate: a render names how good it should be and costs what
  // that costs. See VIDEO_QUALITY_TIERS for why a bitrate was the wrong ask.
  const [quality, setQuality] = React.useState<VideoQualityId>(DEFAULT_VIDEO_QUALITY);
  const [audioKbps, setAudioKbps] = React.useState(192);
  /**
   * Record the sound instead of encoding the offline mix. Off by default —
   * encoding is faster and sample-exact — but it is the one route that cannot
   * disagree with what you hear on play, so it is a switch rather than a
   * rescue nobody can reach.
   */
  const [recordAudio, setRecordAudio] = React.useState(false);
  const [advancedOpen, setAdvancedOpen] = React.useState(false);
  const [progress, setProgressState] = React.useState<number | null>(null);
  const abortRef = React.useRef<AbortController | null>(null);
  const signalRef = React.useRef<TaskSignal | null>(null);
  /** One writer for progress: the panel's bar AND the Activity row. */
  const setProgress = React.useCallback((v: number | null) => {
    setProgressState(v);
    if (v !== null) signalRef.current?.report({ progress: v });
  }, []);
  // Live render preview target — filled frame-by-frame during a video export.
  const previewRef = React.useRef<HTMLCanvasElement>(null);
  const blitFrame = React.useCallback((cv: HTMLCanvasElement) => {
    const pc = previewRef.current;
    const g = pc?.getContext("2d");
    if (!pc || !g) return;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.drawImage(cv, 0, 0, pc.width, pc.height);
  }, []);

  // A new subject resets the smart defaults (the panel is long-lived in the sidebar).
  const lastKey = React.useRef(targetKey);
  React.useEffect(() => {
    if (lastKey.current === targetKey) return;
    lastKey.current = targetKey;
    setMedium(initialMedium && caps.media.includes(initialMedium) ? initialMedium : caps.defaultMedium);
    setImageFormat(caps.svg === "vector" ? "svg" : "png");
    setPdfPages("current");
    setPdfRender(caps.svg === "mixed" ? "image" : "vector");
    setTransparent(isLayer);
    setIncludeBackground(!isLayer);
    setScope(isLayer ? "span" : "full");
    // The override belonged to the PREVIOUS comp's rate; a new subject exports
    // at its own rate until you say otherwise.
    setFpsOverride(null);
    setQuality(DEFAULT_VIDEO_QUALITY);
    scaleTouched.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetKey]);

  const rendering = progress !== null;
  React.useEffect(() => onRenderingChange?.(rendering), [rendering, onRenderingChange]);
  React.useEffect(() => {
    if (!cancelRef) return;
    cancelRef.current = () => abortRef.current?.abort();
    return () => {
      cancelRef.current = null;
    };
  }, [cancelRef]);

  // ── Derived timing / sizing ────────────────────────────────────────────────
  const workRange = useWorkRange(frame.id);
  const frameDur = frameDurationMs(doc, frame);
  // The comp's own rate, and what this render will actually use. Keeping them
  // as two named values is the point: the panel has to be able to say "you are
  // overriding 24 with 30" rather than silently showing one number.
  const compRateFps = frameFps(doc, frame);
  const fps = fpsOverride ?? compRateFps;

  // The time window a video/Lottie export renders.
  const span = React.useMemo(() => {
    if (isLayer) {
      return scope === "span" ? caps.spanMs : { start: 0, end: frameDur };
    }
    return scope === "span" && workRange
      ? { start: workRange.startMs, end: workRange.endMs }
      : { start: 0, end: frameDur };
  }, [isLayer, scope, caps.spanMs, frameDur, workRange]);

  // Display bounds (cheap single-sample measure at the playhead for the label
  // + preview; exports re-measure across the whole span).
  const playheadMs = useParkedPlayhead();
  const displayBounds = React.useMemo<ExportBounds | null>(() => {
    if (!isLayer) return { x: 0, y: 0, width: frame.width, height: frame.height };
    return measureTargetBounds(doc, frame, target.clipIds, [playheadMs]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, frame, targetKey, isLayer, playheadMs]);

  const everyCount = React.useMemo(
    () => (medium === "pdf" && caps.animated ? countEveryFramePages(doc, frameIds) : 0),
    [medium, caps.animated, doc, frameIds],
  );

  const outW = displayBounds ? Math.max(1, Math.round(displayBounds.width * scale)) : 0;
  const outH = displayBounds ? Math.max(1, Math.round(displayBounds.height * scale)) : 0;

  // Free users default to the largest scale that still clears the 720p cap (never
  // upscaling past native), so the panel opens on an exportable, unlocked size.
  React.useEffect(() => {
    if (scaleTouched.current || hiResGate.pro || !displayBounds) return;
    setScale(Math.min(1, maxFreeScale(displayBounds.width, displayBounds.height)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hiResGate.pro, displayBounds?.width, displayBounds?.height, targetKey]);

  // Does the current export even have a pixel resolution to gate? Vector (SVG /
  // Lottie), data and audio-only exports are always free — the paywall is on
  // raster pixels alone.
  const sizeMatters =
    (medium === "image" && imageFormat === "png") ||
    (medium === "video" && videoFormat !== "audio") ||
    (medium === "pdf" && pdfRender === "image");
  const sizeLocked = sizeMatters && hiResGate.locked && !isWithinFreeTier(outW, outH);

  /** Region for export calls: measured across the span for animated exports. */
  const exportRegion = (forSpan: { start: number; end: number } | null): ExportBounds | undefined => {
    if (!isLayer) return undefined;
    const times = forSpan
      ? boundsSampleTimes(forSpan.start, forSpan.end, fps)
      : [playheadMs];
    return measureTargetBounds(doc, frame, target.clipIds, times) ?? undefined;
  };

  // ── Export actions ─────────────────────────────────────────────────────────
  const finish = (ok: string | null) => {
    setProgress(null);
    if (ok) {
      toast.success(ok);
      onDone?.();
    }
  };
  /**
   * An export that fails has to say WHERE.
   *
   * This reported `err.message` alone, which for the errors that actually
   * happen in the wild is the least useful half. "Maximum call stack size
   * exceeded" on an iPad names no file, no function and no line — it is a
   * report you cannot act on, and it arrives from a pipeline (WebCodecs, a
   * muxer, the frame renderer, the audio mixdown) with a dozen candidate
   * sites, several of which are engine-specific and none of which reproduce on
   * a desktop.
   *
   * So the toast carries the error's TYPE as well as its message, and the full
   * object — stack included — goes to the console under a greppable tag. The
   * cost is one line; the difference is between a guess and a fix.
   */
  const fail = (err: unknown) => {
    setProgress(null);
    const e = err as Error;
    if (e?.name === "AbortError") {
      toast("Export cancelled");
      return;
    }
    // Into the error spine as well as the toast: the toast is gone in four
    // seconds, and the Console row is what a bug report is built from. The
    // panel's own message is better than a generic one, so this does not
    // announce a second time — see `EngineErrorInit.announce`.
    reportError(
      new ExportError({
        code: "export/failed",
        message: `${e?.name ?? "Error"}: ${e?.message ?? "export failed"}`,
        userMessage: "The export didn’t finish.",
        context: { format: medium === "video" ? videoFormat : medium, target: target.name },
        subject: entityRef("frame", frame.id, target.name),
        announce: false,
        cause: err,
      }),
    );
    const where = (e?.stack ?? "")
      .split("\n")
      .slice(1, 3)
      .map((l) => l.trim().replace(/^at\s+/, ""))
      .filter(Boolean)
      .join(" ← ");
    toast.error(`Export failed — ${e?.name ?? "Error"}`, {
      description: [e?.message, where].filter(Boolean).join("\n"),
    });
  };

  /**
   * Settle any wet paint before rendering a single frame of anything.
   *
   * A render must not depend on wall-clock simulation state: a wash is a
   * different picture one second later, so exporting mid-flow would give a
   * different file every time you pressed the button, and an image sequence
   * would show the wash creeping between frames of a still. Drying first makes
   * the export deterministic — and it is what the artist meant anyway, since
   * a finished piece is a dry one.
   *
   * Cheap and idempotent when nothing is wet, which is almost always.
   */
  const settleWetPaint = () => dryWetPaint(store, doc);

  /**
   * A file the engine could not decode drops out of the mix in silence, which
   * looks exactly like a file with no sound. Say which one it was — this is the
   * single likeliest reason a clip that plays on the timeline is missing from
   * the export, because the timeline plays the media element while the mix
   * decodes the bytes, and not every engine can pull audio out of every video
   * container. Returns the success message so the caller stays one line.
   */
  const warnUndecodable = (ok: string): string => {
    const names = undecodableAssetsFromLastBounce()
      .map((id) => doc.assets.find((a) => a.id === id)?.name)
      .filter((n): n is string => !!n);
    if (names.length > 0) {
      toast.error(`Couldn't decode audio from ${names.join(", ")}`, {
        description: "That clip is silent in the export. Try re-encoding it, or import its sound as a separate file.",
      });
    }
    return ok;
  };

  /**
   * WHAT ONE EXPORT RENDERS — a frame (or layer), the instant a still is taken
   * at, and the window a video covers. A single export is one subject; a batch
   * of frames is the same exporters run once per subject, so there is no
   * second "multi" pipeline to drift from the first.
   */
  type Subject = { target: ExportTarget; frame: Frame; timeMs: number; span: { start: number; end: number } };
  const single: Subject = { target, frame, timeMs: playheadMs, span };

  const runImage = async (sub: Subject, save?: SaveSink): Promise<string> => {
    if (imageFormat === "svg") {
      const { warnings } = await exportSvgFile(doc, sub.target, sub.timeMs, {
        region: exportRegion(null),
        includeBackground,
        fileName: sub.target.name,
        projectId: useAppShell.getState().currentProjectId,
        save,
      });
      for (const w of warnings) toast(w);
      return "SVG exported";
    }
    await exportPng(scopedDoc(doc, sub.target), sub.frame, sub.timeMs, {
      scale,
      region: exportRegion(null),
      onlyClipIds: sub.target.clipIds,
      transparent,
      fileName: sub.target.name,
      save,
    });
    return "PNG exported";
  };

  const startImage = async () => {
    settleWetPaint();
    setProgress(0);
    try {
      finish(await runImage(single));
    } catch (err) {
      fail(err);
    }
  };

  /** Returns the success message, or null when the export finished but has already said why it is incomplete. */
  const runVideo = async (sub: Subject, onProgress: (f: number) => void, save?: SaveSink): Promise<string | null> => {
    const sdoc = withMixOverride(
      scopedDoc(hasRenders && rerenderOriginals ? withOriginals(doc) : doc, sub.target),
      sub.frame.id,
      { leveler, strength: levelStrength },
    );
    const options: VideoExportOptions = {
      durationMs: sub.span.end - sub.span.start,
      startMs: sub.span.start,
      includeAudio: caps.hasAudio && includeAudio,
      scale,
      fps: fpsOverride ?? undefined,
      quality,
      audioBitrate: Math.round(audioKbps * 1000),
      audioCapture: recordAudio ? "live" : "auto",
      onlyClipIds: sub.target.clipIds,
      region: exportRegion(sub.span),
      transparent:
        (videoFormat === "gif" || videoFormat === "png-seq" || videoFormat === "mov") && transparent,
      motionBlur,
      fileName: isLayer || isBatch ? sub.target.name : undefined,
      onProgress,
      onFrame: blitFrame,
      signal: abortRef.current?.signal,
      save,
    };
    if (videoFormat === "mp4") {
      const { audioIncluded, audioCodec, audioReport: report } = await exportMp4(sdoc, sub.frame, options);
      setAudioReport(report);
      if (options.includeAudio && !audioIncluded) {
        // The reason, not a guess at one. It stays in the panel afterwards,
        // because a toast is gone by the time you go looking for it.
        toast("MP4 exported without audio", { description: report });
        return null;
      }
      if (audioCodec === "opus") return "MP4 exported — audio is Opus (QuickTime may play it silent)";
      return warnUndecodable("MP4 exported");
    }
    if (videoFormat === "mov") {
      const { audioIncluded } = await exportLosslessMov(sdoc, sub.frame, options);
      // No encoder ran, so there is nothing to hedge about: every frame in
      // this file is the PNG we drew, and the sound is the mix itself.
      // QuickTime does not decode `png ` in a MOV — verified against
      // AVFoundation, which reports ffmpeg's own PNG-in-MOV unplayable too.
      // Resolve, Premiere, After Effects and ffmpeg all read it, so the
      // format is useful today; saying where it opens beats a file that
      // silently refuses to.
      return options.includeAudio && !audioIncluded
        ? "Master exported — the audio mix failed, picture is intact"
        : "Master exported — lossless with PCM sound (opens in Resolve/Premiere/AE, not QuickTime)";
    }
    if (videoFormat === "webm") {
      const container = await exportWebm(sdoc, sub.frame, options);
      return container === "mp4" ? "MP4 exported" : "WebM exported";
    }
    if (videoFormat === "gif") {
      await exportGif(sdoc, sub.frame, options);
      return "GIF exported";
    }
    if (videoFormat === "audio") {
      const { report } = await exportAudioOnly(sdoc, sub.frame, options);
      setAudioReport(report);
      return warnUndecodable("Audio exported");
    }
    await exportPngSequence(sdoc, sub.frame, options);
    return "PNG sequence exported";
  };

  const startVideo = async () => {
    settleWetPaint();
    setProgress(0);
    useSession.getState().setPlaying(false);
    abortRef.current = new AbortController();
    try {
      const ok = await runVideo(single, setProgress);
      finish(ok);
      if (!ok) onDone?.();
    } catch (err) {
      fail(err);
    }
  };

  const runLottie = async (sub: Subject, save?: SaveSink): Promise<string> => {
    const result = await exportLottieFile(doc, sub.target, {
      startMs: sub.span.start,
      endMs: sub.span.end,
      region: exportRegion(sub.span),
      includeBackground,
      fileName: sub.target.name,
      save,
    });
    const skipped = result.report.filter((r) => r.status === "skipped");
    return skipped.length ? `Lottie exported — ${skipped.length} layer${skipped.length > 1 ? "s" : ""} skipped` : "Lottie exported";
  };

  const startLottie = async () => {
    settleWetPaint();
    setProgress(0);
    try {
      finish(await runLottie(single));
    } catch (err) {
      fail(err);
    }
  };

  // ── Several frames, and PDF ────────────────────────────────────────────────

  /** The instant each frame is showing right now — where you stand, or where it was left. */
  const currentTimeOf = (frameId: string): number => {
    const session = useSession.getState();
    const ctx = contextOf(doc, session.nav, session.playheadMs);
    return ctx?.frameTimes.get(frameId) ?? doc.frames.find((f) => f.id === frameId)?.playheadMs ?? 0;
  };

  /**
   * A batch: every picked frame through the SAME single exporter, in the order
   * picked, collected and handed back as one zip.
   */
  const startBatch = async () => {
    settleWetPaint();
    setProgress(0);
    useSession.getState().setPlaying(false);
    abortRef.current = new AbortController();
    try {
      const n = frameIds.length;
      const files = await collectSaves(async (save) => {
        for (let i = 0; i < n; i++) {
          if (abortRef.current?.signal.aborted) throw new DOMException("Export cancelled", "AbortError");
          const f = doc.frames.find((x) => x.id === frameIds[i]);
          if (!f) continue;
          const sub: Subject = {
            target: { ...frameTarget(doc, f.id), name: `${String(i + 1).padStart(String(n).length, "0")}-${f.name}` },
            frame: f,
            timeMs: currentTimeOf(f.id),
            span: { start: 0, end: frameDurationMs(doc, f) },
          };
          if (medium === "image") await runImage(sub, save);
          else if (medium === "lottie") await runLottie(sub, save);
          else await runVideo(sub, (p) => setProgress((i + p) / n), save);
          setProgress((i + 1) / n);
        }
      });
      await saveZip(files, `${safeFileName(doc.name || NAMES.files.fallbackName)}-frames.zip`);
      finish(`${files.length} file${files.length === 1 ? "" : "s"} exported`);
    } catch (err) {
      fail(err);
    }
  };

  const startPdf = async () => {
    settleWetPaint();
    setProgress(0);
    useSession.getState().setPlaying(false);
    abortRef.current = new AbortController();
    try {
      const plan = planExportPages(doc, frameIds, { sampling: pdfPages, currentTimeOf });
      if (plan.truncated) toast(`Only the first ${plan.pages.length} pages were exported`);
      const result = await exportPdf(doc, plan.pages, {
        render: pdfRender,
        scale,
        imageFormat: pdfImage,
        fileName: isBatch ? doc.name || target.name : target.name,
        onProgress: setProgress,
        signal: abortRef.current.signal,
      }, { projectId: useAppShell.getState().currentProjectId });
      const pages = result.vectorPages + result.imagePages;
      finish(
        pdfRender === "vector" && result.imagePages > 0 && result.vectorPages > 0
          ? `PDF exported — ${pages} pages, ${result.imagePages} kept as images for their effects or media`
          : `PDF exported — ${pages} page${pages === 1 ? "" : "s"}${result.links ? `, ${result.links} link${result.links === 1 ? "" : "s"}` : ""}`,
      );
    } catch (err) {
      fail(err);
    }
  };

  const startModel = async () => {
    settleWetPaint();
    setProgress(0);
    try {
      const { loadWorldEngine } = await import("../world/loader");
      const engine = await loadWorldEngine();
      const animate = modelAnimate && (modelFormat === "glb" || modelFormat === "gltf");
      const blob = await engine.exportModel(doc, frame, currentTimeOf(frame.id), modelFormat, { animate });
      saveExport(blob, `${safeFileName(target.name)}.${modelFormat}`);
      finish(`${modelFormat.toUpperCase()} exported`);
    } catch (err) {
      fail(err);
    }
  };

  const base =
    medium === "model"
      ? startModel
      : medium === "pdf"
      ? startPdf
      : isBatch
        ? startBatch
        : medium === "image"
          ? startImage
          : medium === "video"
            ? startVideo
            : startLottie;

  /**
   * Every export runs as a supervised task. That is what puts it in Activity
   * with live progress and a Stop button — and the Stop button drives the
   * SAME `AbortController` the panel's own Cancel does, so there is one way to
   * stop an export rather than two that can disagree.
   *
   * Deliberately unlimited by default (see the `export` task kind): a long
   * export is long, not stuck, and a timer that cannot tell the difference
   * would shoot real work. What it gets instead is chunking and visibility.
   */
  const start = async () => {
    // The media check every export runs (see `missingMedia`): a file whose
    // bytes are gone from this device is named now, before a render that would
    // ship it as a silent track or a blank layer.
    const withSound = medium === "video" && includeAudio && ["mp4", "webm", "mov", "audio"].includes(videoFormat);
    const subjects = isBatch ? frameIds : [frame.id];
    const missing = new Map<string, string>();
    for (const id of subjects) {
      for (const a of await missingMedia(doc, id)) if (withSound || a.kind !== "audio") missing.set(a.id, a.name);
    }
    if (missing.size) {
      const names = [...missing.values()];
      toast.error(`${names.length === 1 ? "A file is" : `${names.length} files are`} missing from this device`, {
        description: `${names.join(", ")}. Import ${names.length === 1 ? "it" : "them"} again (it goes back where it was) or relink in Media, then export.`,
      });
      return;
    }
    // One render at a time, app-wide: an agent's export ahead of this one finishes first.
    if (renderLineBusy()) toast("Export queued", { description: "It starts when the export in progress is done." });
    return renderJobs.run({ label: `Export “${target.name}”`, owner: "panel" }, () => supervise(
      {
        kind: "export",
        label: `Export “${target.name}”`,
        detail: medium === "video" ? videoFormat.toUpperCase() : medium.toUpperCase(),
        subject: entityRef("frame", frame.id, target.name),
      },
      async (signal) => {
        signalRef.current = signal;
        const offAbort = signal.onAbort(() => abortRef.current?.abort());
        try {
          await base();
        } finally {
          offAbort();
          signalRef.current = null;
        }
      },
    )).catch(() => {
      // Already reported by `fail`, or it was a deliberate stop. Either way the
      // panel has said its piece; an unhandled rejection here would say it again.
    });
  };

  // ── Render ─────────────────────────────────────────────────────────────────
  const compact = variant === "sidebar";
  const showAudioToggle =
    medium === "video" &&
    caps.hasAudio &&
    (videoFormat === "mp4" || videoFormat === "webm" || videoFormat === "mov");
  // The sound diagnostic belongs anywhere sound is being written, including the
  // WAV bounce — which is the one export with no encoder in it at all, and so
  // the fastest way to tell a broken renderer from a broken encoder.
  const showAudioReport = medium === "video" && caps.hasAudio &&
    ((showAudioToggle && includeAudio) || videoFormat === "audio");

  // ── Formats: one list, the comp's natural medium first ─────────────────────
  const formats = formatCards({
    media: [caps.defaultMedium, ...caps.media.filter((m) => m !== caps.defaultMedium)],
    svg: caps.svg,
    mp4Ok,
    showRealtime,
    realtimeLabel,
    hasAudio: caps.hasAudio,
    world: !!frame.world,
  });
  const currentFormat: FormatId = medium === "video" ? videoFormat : medium === "image" ? imageFormat : medium;
  const pickFormat = (f: FormatCardDef) => {
    setMedium(f.medium);
    if (f.medium === "video") setVideoFormat(f.id as VideoFormat);
    if (f.medium === "image") setImageFormat(f.id as ImageFormat);
  };

  const settings = (
    <>
      {medium === "pdf" && (
        <>
          {caps.animated && (
            <Field label="Pages" compact={compact}>
              <Segmented
                value={pdfPages}
                onChange={(v) => setPdfPages(v as PageSampling)}
                disabled={rendering}
                options={[
                  { value: "current", label: "As shown" },
                  { value: "every", label: `Every frame · ${everyCount}` },
                ]}
              />
            </Field>
          )}
          <Field label="Render" compact={compact}>
            <Segmented
              value={pdfRender}
              onChange={(v) => setPdfRender(v as PdfRender)}
              disabled={rendering}
              options={[
                { value: "vector", label: "Vector", hint: "Sharp at any zoom — pages with effects or media stay exact images" },
                { value: "image", label: "Image", hint: "Every page exactly as it looks on the canvas" },
              ]}
            />
          </Field>
          {(pdfRender === "image" || caps.svg === "mixed") && (
            <>
              <Field label="Resolution" compact={compact}>
                <SizeQualityControl
                  srcW={displayBounds?.width ?? 0}
                  srcH={displayBounds?.height ?? 0}
                  scale={scale}
                  onScale={pickScale}
                  pro={hiResGate.pro}
                  disabled={rendering}
                />
              </Field>
              <Field label="Images" compact={compact}>
                <Segmented
                  value={pdfImage}
                  onChange={(v) => setPdfImage(v as PdfImageFormat)}
                  disabled={rendering}
                  options={[
                    { value: "jpeg", label: "Smaller" },
                    { value: "png", label: "Lossless" },
                  ]}
                />
              </Field>
            </>
          )}
        </>
      )}


      {medium === "model" && (
        <>
          <Field label="Format" compact={compact}>
            <Segmented
              value={modelFormat}
              onChange={(v) => setModelFormat(v as ModelFormat)}
              disabled={rendering}
              options={MODEL_FORMATS}
            />
          </Field>
          {(modelFormat === "glb" || modelFormat === "gltf") && (
            <Field label="Animation" compact={compact}>
              <div className="flex items-center gap-2">
                <Switch checked={modelAnimate} onCheckedChange={setModelAnimate} disabled={rendering} />
                <span className="text-xs text-muted-foreground">{modelAnimate ? "Objects and camera move as in the comp" : "The scene at the playhead"}</span>
              </div>
            </Field>
          )}
        </>
      )}

      {medium === "image" && (
        <>
          {imageFormat === "png" && (
            <>
              <Field label="Size" compact={compact}>
                <SizeQualityControl
                  srcW={displayBounds?.width ?? 0}
                  srcH={displayBounds?.height ?? 0}
                  scale={scale}
                  onScale={pickScale}
                  pro={hiResGate.pro}
                  disabled={rendering}
                />
              </Field>
              <Field label="Transparent" compact={compact}>
                <Switch checked={transparent} onCheckedChange={setTransparent} disabled={rendering} />
              </Field>
            </>
          )}
          {imageFormat === "svg" && (
            <>
              <Field label="Background" compact={compact}>
                <Switch checked={includeBackground} onCheckedChange={setIncludeBackground} disabled={rendering} />
              </Field>
              <p className="text-[10px] leading-snug text-muted-foreground">
                {caps.svg === "vector"
                  ? "True vector — every layer exports as real paths."
                  : caps.svg === "outline"
                    ? "Text converts to outlines at export — everything stays vector."
                    : "Vector layers stay paths; media/effect layers embed as images."}
              </p>
            </>
          )}
        </>
      )}

      {medium === "video" && (
        <>

          {(isLayer || workRange) && !isBatch && (
            <Field label="Range" compact={compact}>
              <Segmented
                value={scope}
                onChange={(v) => setScope(v as "span" | "full")}
                disabled={rendering}
                options={
                  isLayer
                    ? [
                        { value: "span", label: "Layer span" },
                        { value: "full", label: "Whole comp" },
                      ]
                    : [
                        { value: "full", label: "Full" },
                        { value: "span", label: "Working range" },
                      ]
                }
              />
            </Field>
          )}

          {videoFormat !== "audio" && (
            <>
              <Field label="Size" compact={compact}>
                <SizeQualityControl
                  srcW={displayBounds?.width ?? 0}
                  srcH={displayBounds?.height ?? 0}
                  scale={scale}
                  onScale={pickScale}
                  pro={hiResGate.pro}
                  disabled={rendering}
                />
              </Field>
              {/* The comp's OWN rate is what this exports at by default, and
                  it is named here so you can see which comp you're rendering
                  before you change anything. An edit is an EXPORT-ONLY
                  override — it is passed to the renderer and never written to
                  the document — so the escape hatch back to the comp's rate has
                  to be visible, not implied by clearing the field. */}
              <Field label="Frame rate" compact={compact}>
                <FpsControl
                  value={fps}
                  size="compact"
                  menuTitle="Export rate"
                  className="w-32"
                  disabled={rendering}
                  onChange={(v) => setFpsOverride(v)}
                  hint={
                    fpsOverride === null ? (
                      <>This comp runs at {formatFps(compRateFps)}.</>
                    ) : (
                      <span className="flex items-center gap-1">
                        <span className="text-warning/90">
                          Override — comp runs at {formatFps(compRateFps)}.
                        </span>
                        <button
                          type="button"
                          onClick={() => setFpsOverride(null)}
                          className="underline decoration-dotted underline-offset-2 hover:text-foreground"
                        >
                          Reset
                        </button>
                      </span>
                    )
                  }
                />
              </Field>
            </>
          )}

          {showAudioToggle && (
            <Field label="Include sound" compact={compact}>
              <Switch checked={includeAudio} onCheckedChange={setIncludeAudio} disabled={rendering} />
            </Field>
          )}
          {showAudioToggle && includeAudio && (
            <Field label="Level sound" compact={compact}>
              <span className="flex min-w-0 flex-1 items-center justify-end gap-2">
                {leveler && (
                  <Range
                    value={Math.round(levelStrength * 100)}
                    min={0}
                    max={100}
                    step={5}
                    precision={0}
                    unit="%"
                    defaultValue={Math.round(frame.soundMix.leveler.strength * 100)}
                    className="w-28"
                    disabled={rendering}
                    onChange={(v) => setLevelStrength(v / 100)}
                  />
                )}
                <Switch checked={leveler} onCheckedChange={setLeveler} disabled={rendering} />
              </span>
            </Field>
          )}
          {showAudioReport && (
            <p className="-mt-1 text-[11px] leading-snug text-muted-foreground">
              {audioReport ?? `Encoder: ${audioPath}`}
            </p>
          )}
          {(videoFormat === "gif" || videoFormat === "png-seq" || videoFormat === "mov") && (
            <Field label="Transparent" compact={compact}>
              <Switch checked={transparent} onCheckedChange={setTransparent} disabled={rendering} />
            </Field>
          )}
          {/* Renders at full quality regardless of what the stage was previewing
              at — the preview tier is a fact about this machine, not the file. */}
          <Field label="Motion blur" compact={compact}>
            <Switch checked={motionBlur} onCheckedChange={setMotionBlur} disabled={rendering} />
          </Field>
          {hasRenders && (
            <Field label="Rendered layers" compact={compact}>
              <Select value={rerenderOriginals ? "originals" : "renders"} onValueChange={(v) => setRerenderOriginals(v === "originals")} disabled={rendering}>
                <SelectTrigger className="h-8 w-fit gap-1.5 text-xs" aria-label="Rendered layers">
                  <span className="font-medium">{rerenderOriginals ? "Re-render" : "Use renders"}</span>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="renders">Use renders</SelectItem>
                  <SelectItem value="originals">Re-render from originals</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          )}

          {(videoFormat === "mp4" || videoFormat === "webm") && (
            <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen} title="Advanced" icon={<Settings2 className="size-3.5" />}>
              <Field label="Quality" compact>
                <Select value={quality} onValueChange={(v) => setQuality(v as VideoQualityId)} disabled={rendering}>
                  <SelectTrigger className="h-8 w-fit gap-1.5 text-xs" aria-label="Quality">
                    <span className="font-medium">{VIDEO_QUALITY_TIERS.find((t) => t.id === quality)?.label}</span>
                  </SelectTrigger>
                  <SelectContent>
                    {VIDEO_QUALITY_TIERS.map((t) => (
                      <SelectItem key={t.id} value={t.id}>
                        <span className="flex items-center gap-2">
                          <span className="w-14 font-medium">{t.label}</span>
                          <span className="font-mono text-[10px] text-muted-foreground">
                            ~{Math.round(qualityBitrate(t.id, outW, outH, fps) / 1_000_000)} Mbps
                          </span>
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              {showAudioToggle && includeAudio && (
                <>
                  <Field label="Audio bitrate" compact>
                    <NumberInput value={audioKbps} min={64} max={320} precision={0} unit="kbps" className="w-24" onChange={(v) => setAudioKbps(Math.round(v))} />
                  </Field>
                  <Field
                    label="Record sound"
                    compact
                    hint="Runs in real time. The surest route when an export comes back silent."
                  >
                    <Switch checked={recordAudio} onCheckedChange={setRecordAudio} disabled={rendering} />
                  </Field>
                </>
              )}
            </Collapsible>
          )}

          <p className="font-mono text-[10px] text-muted-foreground">
            {videoFormat === "audio" ? "" : `${outW}×${outH} · ${formatFps(fps)} fps · `}
            {fmtDuration(span.end - span.start)}
          </p>
        </>
      )}

      {medium === "lottie" && (
        <>
          <Field label="Background" compact={compact}>
            <Switch checked={includeBackground} onCheckedChange={setIncludeBackground} disabled={rendering} />
          </Field>
          {(isLayer || workRange) && !isBatch && (
            <Field label="Range" compact={compact}>
              <Segmented
                value={scope}
                onChange={(v) => setScope(v as "span" | "full")}
                disabled={rendering}
                options={
                  isLayer
                    ? [
                        { value: "span", label: "Layer span" },
                        { value: "full", label: "Whole comp" },
                      ]
                    : [
                        { value: "full", label: "Full" },
                        { value: "span", label: "Working range" },
                      ]
                }
              />
            </Field>
          )}
          <LottieReportPreview target={target} span={span} region={exportRegion} includeBackground={includeBackground} />
          <p className="font-mono text-[10px] text-muted-foreground">
            {outW}×{outH} · {formatFps(fps)} fps · {fmtDuration(span.end - span.start)}
          </p>
        </>
      )}

    </>
  );

  return (
    <div className={cn("space-y-3", compact ? "" : "space-y-4")}>
      {variant === "dialog" && (
        <ExportPreview
          doc={doc}
          frame={frame}
          target={target}
          bounds={displayBounds}
          canvasRef={previewRef}
          live={rendering && medium === "video"}
        />
      )}
      {/* One column of formats. The chosen one opens to show its settings. */}
      <div role="radiogroup" aria-label="Format" className="flex flex-col gap-1.5">
        {formats.map((f) => (
          <FormatCard key={f.id} format={f} selected={f.id === currentFormat} compact={compact} disabled={rendering} onPick={() => pickFormat(f)}>
            {settings}
          </FormatCard>
        ))}
      </div>

      <CreditsField doc={scopedDoc(doc, target)} compact={compact} />

      {/* Progress, or the one action. In the dialog it stays in reach at the
          foot however long the chosen format's settings run. */}
      <div className={cn(variant === "dialog" && "sticky -bottom-4 z-10 -mx-5 -mb-4 border-t border-line bg-popover px-5 py-3")}>
      {rendering && (medium === "video" || medium === "pdf" || isBatch) ? (
        <div className="flex items-center gap-2">
          <product.Loader size={compact ? 18 : 22} className="shrink-0" />
          <Meter value={progress ?? 0} label={medium === "video" ? "Rendering" : "Exporting"} className="flex-1" />
          <Button variant="secondary" size={compact ? "sm" : "default"} onClick={() => abortRef.current?.abort()}>
            Cancel
          </Button>
        </div>
      ) : sizeLocked ? (
        <Button onClick={() => hiResGate.promptUpgrade()} size={compact ? "sm" : "default"} className="w-full">
          <Sparkles />
          Export in {outH >= 2000 ? "4K" : "HD"} with Pro
        </Button>
      ) : (
        <Button onClick={() => void start()} disabled={rendering} size={compact ? "sm" : "default"} className="w-full">
          {rendering ? <product.Loader size={16} /> : <FormatIcon id={currentFormat} />}
          {medium === "video" && videoFormat !== "audio" ? "Render" : "Export"} {target.kind === "frame" || isBatch ? target.name : `“${target.name}”`}
        </Button>
      )}
      </div>
    </div>
  );
}

// ── Live preview (dialog) ────────────────────────────────────────────────────

/**
 * Checkerboard-backed live render of exactly what will export. At rest it draws
 * the playhead frame; DURING a video render (`live`) it stops drawing and the
 * exporter blits each encoded frame straight in (via `onFrame` → the shared
 * `canvasRef`), so you watch the actual render progress instead of a still.
 */
function ExportPreview({
  doc,
  frame,
  target,
  bounds,
  canvasRef,
  live,
}: {
  doc: MotionDocument;
  frame: Frame;
  target: ExportTarget;
  bounds: ExportBounds | null;
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  live: boolean;
}) {
  const playheadMs = useParkedPlayhead();
  const isLayer = target.clipIds.length > 0;

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !bounds) return;
    const maxW = 448;
    const maxH = 180;
    const s = Math.min(maxW / bounds.width, maxH / bounds.height, 1);
    canvas.width = Math.max(2, Math.round(bounds.width * s * 2));
    canvas.height = Math.max(2, Math.round(bounds.height * s * 2));
    canvas.style.width = `${Math.round(bounds.width * s)}px`;
    canvas.style.height = `${Math.round(bounds.height * s)}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    // While rendering, frames arrive from the exporter (onFrame) — don't fight it.
    if (live) return;
    ctx.scale(canvas.width / bounds.width, canvas.height / bounds.height);
    ctx.translate(-bounds.x, -bounds.y);
    if (!isLayer) {
      drawFrameContent(ctx, doc, frame, playheadMs);
    } else {
      drawFrameContent(ctx, doc, frame, playheadMs, {
        only: new Set(target.clipIds),
        transparent: true,
      });
    }
  }, [doc, frame, target, bounds, playheadMs, isLayer, live, canvasRef]);

  if (!bounds) {
    return (
      <div className="flex h-24 items-center justify-center rounded-lg border text-[11px] text-muted-foreground">
        Nothing visible at the playhead.
      </div>
    );
  }
  return (
    <div
      className={cn(
        "relative flex justify-center rounded-lg border bg-[length:16px_16px] p-3 [background-image:repeating-conic-gradient(var(--border)_0%_25%,transparent_0%_50%)]",
        live && "ring-1 ring-primary/60",
      )}
    >
      <canvas ref={canvasRef} className="max-w-full rounded-sm shadow-sm" />
      {live && (
        <span className="absolute left-2 top-2 flex items-center gap-1 rounded bg-black/60 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-white">
          <span className="size-1.5 animate-pulse rounded-full bg-destructive" /> Rendering
        </span>
      )}
    </div>
  );
}

// ── Lottie compatibility report ──────────────────────────────────────────────

const STATUS_STYLE: Record<LottieLayerReport["status"], string> = {
  mapped: "bg-success/15 text-success",
  baked: "bg-primary/15 text-primary",
  partial: "bg-warning/15 text-warning",
  skipped: "bg-destructive/15 text-destructive",
};

/** Runs the translator (dry) and lists what maps, bakes, or drops per layer. */
function LottieReportPreview({
  target,
  span,
  region,
  includeBackground,
}: {
  target: ExportTarget;
  span: { start: number; end: number };
  region: (s: { start: number; end: number } | null) => ExportBounds | undefined;
  includeBackground: boolean;
}) {
  const doc = useDoc();
  const [report, setReport] = React.useState<LottieLayerReport[] | null>(null);
  const [busy, setBusy] = React.useState(false);
  const key = `${target.frameId}:${target.clipIds.join(",")}:${span.start}:${span.end}`;

  React.useEffect(() => {
    let alive = true;
    setBusy(true);
    setReport(null);
    const t = setTimeout(() => {
      void buildLottie(doc, target, {
        startMs: span.start,
        endMs: span.end,
        region: region(span),
        includeBackground,
      })
        .then((r) => {
          if (alive) setReport(r.report);
        })
        .catch(() => {
          if (alive) setReport([]);
        })
        .finally(() => {
          if (alive) setBusy(false);
        });
    }, 250);
    return () => {
      alive = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, key]);

  if (busy) {
    return (
      <div className="flex items-center gap-2 rounded-lg border px-3 py-2 text-[11px] text-muted-foreground">
        <Loader2 className="size-3 animate-spin" /> Checking Lottie compatibility…
      </div>
    );
  }
  if (!report || report.length === 0) return null;
  return (
    <ScrollArea className="max-h-36 rounded-lg border" viewportClassName="p-2" contentClassName="space-y-1">
      {report.map((r, i) => (
        <div key={i} className="flex items-start gap-2 text-[11px]">
          <span className={cn("mt-px shrink-0 rounded px-1.5 py-px text-[9px] font-semibold uppercase", STATUS_STYLE[r.status])}>
            {r.status}
          </span>
          <div className="min-w-0">
            <span className="font-medium">{r.name}</span>
            {r.notes.length > 0 && (
              <span className="text-muted-foreground"> — {r.notes.join(" ")}</span>
            )}
          </div>
        </div>
      ))}
    </ScrollArea>
  );
}

// ── Small building blocks (shared with the dialog shell) ────────────────────

type FormatId = VideoFormat | ImageFormat | "lottie" | "pdf" | "model";
interface FormatCardDef {
  id: FormatId;
  medium: ExportMedium;
  name: string;
  /** One line: what this format is FOR. */
  spec: string;
}

function FormatIcon({ id }: { id: FormatId }) {
  if (id === "gif" || id === "png-seq") return <Images />;
  if (id === "audio") return <AudioLines />;
  if (id === "png") return <FileImage />;
  if (id === "svg") return <FileCode2 />;
  if (id === "lottie") return <Braces />;
  if (id === "pdf") return <FileText />;
  if (id === "model") return <Box />;
  return <Film />;
}

/** Every format this subject can become, as preset cards, grouped by medium. */
function formatCards(o: {
  media: ExportMedium[];
  svg: "vector" | "outline" | "mixed";
  mp4Ok: boolean;
  showRealtime: boolean;
  realtimeLabel: string;
  hasAudio: boolean;
  world: boolean;
}): FormatCardDef[] {
  const out: FormatCardDef[] = [];
  for (const m of o.media) {
    if (m === "video") {
      if (o.mp4Ok) out.push({ id: "mp4", medium: m, name: "MP4", spec: "H.264, plays everywhere" });
      out.push({ id: "mov", medium: m, name: "Master MOV", spec: "Lossless, keeps transparency" });
      if (o.showRealtime) out.push({ id: "webm", medium: m, name: o.realtimeLabel, spec: "Recorded as it plays" });
      out.push({ id: "gif", medium: m, name: "GIF", spec: "Loops anywhere, 256 colours" });
      out.push({ id: "png-seq", medium: m, name: "PNG sequence", spec: "A file per frame, for compositing" });
      if (o.hasAudio) out.push({ id: "audio", medium: m, name: "WAV", spec: "The sound on its own" });
    } else if (m === "image") {
      out.push({ id: "png", medium: m, name: "PNG", spec: "The frame at the playhead" });
      if (!o.world)
        out.push({ id: "svg", medium: m, name: "SVG", spec: o.svg === "vector" ? "True vector, every layer as paths" : o.svg === "outline" ? "Vector, text as outlines" : "Vector, media embedded as images" });
    } else if (m === "lottie") out.push({ id: "lottie", medium: m, name: "Lottie", spec: "Vector motion for web and apps" });
    else if (m === "pdf") out.push({ id: "pdf", medium: m, name: "PDF", spec: "A page per frame" });
    else if (m === "model") out.push({ id: "model", medium: m, name: "3D model", spec: "glTF, USDZ, OBJ, STL or PLY" });
  }
  return out;
}

/**
 * A format as a preset card: icon, name, one line. The chosen card is the
 * raised plane and holds that format's settings, so what you picked and what
 * it asks are always in one place.
 */
function FormatCard({ format, selected, compact, disabled, onPick, children }: { format: FormatCardDef; selected: boolean; compact: boolean; disabled: boolean; onPick: () => void; children: React.ReactNode }) {
  return (
    <div
      className={cn(
        "rounded-(--r-md) border transition-colors",
        selected ? "border-line bg-raised shadow-(--elevation-1)" : "border-transparent hover:bg-hover",
      )}
    >
      <button
        type="button"
        role="radio"
        aria-checked={selected}
        disabled={disabled && !selected}
        onClick={onPick}
        className={cn("flex w-full min-w-0 items-center gap-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-(--ring) rounded-(--r-md) disabled:opacity-40", compact ? "px-2 py-1.5" : "px-3 py-2.5")}
      >
        <span className={cn("grid shrink-0 place-items-center rounded-(--r-sm) [&_svg]:size-4", compact ? "size-7" : "size-8", selected ? "text-primary" : "bg-hover text-fg-muted")}>
          <FormatIcon id={format.id} />
        </span>
        <span className="min-w-0 flex-1">
          <span className={cn("block truncate font-medium", compact ? "text-xs" : "text-body", selected ? "text-fg" : "text-fg-muted")}>{format.name}</span>
          <span className="block truncate text-meta text-fg-faint">{format.spec}</span>
        </span>
        <span aria-hidden className={cn("grid size-4 shrink-0 place-items-center rounded-full border", selected ? "border-primary" : "border-line")}>
          {selected && <span className="size-2 rounded-full bg-primary" />}
        </span>
      </button>
      {selected && <div className={cn("space-y-3 border-t border-line", compact ? "px-2 py-2.5" : "px-3 py-3")}>{children}</div>}
    </div>
  );
}

/**
 * The unified Size & quality picker: two LINKED selectors over one `scale` value
 * — famous resolution presets (720p / 1080p / 4K …, only when the source size
 * makes them sensible) and precise scale steps (0.5×–4×). Picking either drives
 * the same scale, so they always agree. Sizes above the free 720p-class cap wear
 * a lock for free users; the parent's export button turns into the upgrade CTA.
 */
function SizeQualityControl({
  srcW,
  srcH,
  scale,
  onScale,
  pro,
  disabled,
}: {
  srcW: number;
  srcH: number;
  scale: number;
  onScale: (s: number) => void;
  pro: boolean;
  disabled?: boolean;
}) {
  const resOptions = React.useMemo(() => resolutionOptions(srcW, srcH), [srcW, srcH]);
  const outW = Math.max(1, Math.round(srcW * scale));
  const outH = Math.max(1, Math.round(srcH * scale));
  const currentRes = matchResolution(resOptions, scale);
  const locked = !pro && !isWithinFreeTier(outW, outH);
  const scaleLabel = Number(scale.toFixed(2));

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex flex-wrap items-center justify-end gap-1.5">
        {resOptions.length >= 2 && (
          <Select
            value={currentRes?.id ?? "custom"}
            onValueChange={(id) => {
              const o = resOptions.find((r) => r.id === id);
              if (o) onScale(o.scale);
            }}
            disabled={disabled}
          >
            <SelectTrigger className="h-8 w-fit gap-1.5 text-xs" aria-label="Resolution preset">
              {currentRes ? (
                <div className="flex items-center gap-1 font-medium [&_svg]:shrink-0">
                  {locked && <Lock className="size-3 text-warning" />}
                  {currentRes.label}
                  <span className="text-[10px] font-normal text-muted-foreground">{currentRes.name}</span>
                </div>
              ) : (
                <span className="text-muted-foreground">Custom</span>
              )}
            </SelectTrigger>
            <SelectContent>
              {resOptions.map((o) => (
                <SelectItem key={o.id} value={o.id}>
                  <span className="flex items-center gap-2">
                    <span className="w-11 font-medium">{o.label}</span>
                    <span className="font-mono text-[10px] text-muted-foreground">
                      {o.width}×{o.height}
                    </span>
                    {o.pro && !pro && <Lock className="size-3 text-warning" />}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <Select value={String(scale)} onValueChange={(v) => onScale(Number(v))} disabled={disabled}>
          <SelectTrigger className="h-8 w-fit gap-1.5 text-xs" aria-label="Scale">
            <span className="font-medium">{scaleLabel}×</span>
            <span className="font-mono text-[10px] text-muted-foreground">
              {outW}×{outH}
            </span>
          </SelectTrigger>
          <SelectContent>
            {SCALE_OPTIONS.map((s) => {
              const w = Math.max(1, Math.round(srcW * s));
              const h = Math.max(1, Math.round(srcH * s));
              const optLocked = !pro && !isWithinFreeTier(w, h);
              return (
                <SelectItem key={s} value={String(s)}>
                  <span className="flex items-center gap-2">
                    <span className="w-7 font-medium">{s}×</span>
                    <span className="font-mono text-[10px] text-muted-foreground">
                      {w}×{h}
                    </span>
                    {optLocked && <Lock className="size-3 text-warning" />}
                  </span>
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>
      </div>
      {locked && (
        <span className="text-[10px] text-warning">
          {FREE_MAX_LONGEST_EDGE >= 1280 ? "720p" : `${FREE_MAX_LONGEST_EDGE}px`} max on the free plan — Pro unlocks Full HD &amp; 4K
        </span>
      )}
    </div>
  );
}

/**
 * WHAT THIS EXPORT OWES. Derived from the provenance on the layers inside the
 * export's scope (`iconCredits`); shown only when there is something to say.
 * A CC-BY set makes the line a condition of shipping the file, so it is named
 * as one; otherwise it is a courtesy you can copy in one click. The export
 * dialog is where this belongs because it is the moment the artwork leaves.
 */
function CreditsField({ doc, compact }: { doc: MotionDocument; compact?: boolean }) {
  const credits = React.useMemo(() => iconCredits(doc), [doc]);
  const { sets } = useIconSets();
  if (credits.length === 0) return null;
  const required = credits.some((c) => c.required);
  const names = new Map((sets ?? []).map((s) => [s.prefix, s.name]));
  const copy = () => {
    void navigator.clipboard.writeText(creditsText(credits, names)).then(() => toast.success("Credits copied"));
  };
  const listed = credits.map((c) => names.get(c.prefix) ?? c.prefix).join(", ");
  return (
    <Field label={required ? "Credits required" : "Credits"} hint={listed} compact={compact}>
      <Button variant="outline" size="sm" onClick={copy} className="h-7 text-xs">
        <Copy className="size-3" /> Copy
      </Button>
    </Field>
  );
}

export function Field({
  label,
  hint,
  compact,
  children,
}: {
  label: string;
  hint?: string;
  compact?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <Label className={cn(compact ? "text-[11px]" : "text-xs")}>{label}</Label>
        {hint && <div className="text-[10px] leading-snug text-muted-foreground">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

export function Collapsible({
  open,
  onOpenChange,
  title,
  icon,
  children,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border">
      <button
        type="button"
        onClick={() => onOpenChange(!open)}
        className="flex w-full items-center justify-between px-3 py-2 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        <span className="flex items-center gap-1.5">
          {icon}
          {title}
        </span>
        <ChevronDown className={cn("size-4 transition-transform", open && "rotate-180")} />
      </button>
      {open && <div className="space-y-3 border-t px-3 py-3">{children}</div>}
    </div>
  );
}

// Icons referenced by the dialog shell too.
export { FileCode2 as SvgIcon };
