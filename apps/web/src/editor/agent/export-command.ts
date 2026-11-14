"use client";

import { identity } from "@/editor/identity";
import { product } from "@/editor/product";
import { z } from "zod";
import {
  ApiError,
  DEFAULT_VIDEO_QUALITY,
  defineCommand,
  entityRef,
  frameDurationMs,
  frameFps,
  isJobFinished,
  maxFreeScale,
  silentSounds,
  supervise,
  type AnyCommand,
  type JobView,
} from "@solomotion/core";
import { BROWSER_DOWNLOAD, bytesMissing, frameAt, requireDelivery, SAVE_TO_DESCRIPTION } from "./media-io";
import { missingMedia } from "../assets/media-usage";
import { dryWetPaint } from "../drawing/wet-actions";
import { collectSaves, saveExport } from "../export/save";
import {
  exportAudioOnly,
  exportGif,
  exportLosslessMov,
  exportMp4,
  exportPng,
  exportPngSequence,
  exportWebm,
  mp4Supported,
  type VideoExportOptions,
} from "../export/export-media";
import type { MixLoudness } from "../export/export-audio";
import { renderJobs } from "../export/render-queue";
import { fontReadinessNote } from "../stage/render/system-fonts";

/**
 * THE AGENT'S EXPORT — the Export panel's own exporters, run from a verb.
 *
 * Nothing here renders: every format is the function the panel calls, so a
 * file an agent makes is byte-for-byte the file the button makes. The file
 * lands where the panel's does (the browser's downloads) — or, with `saveTo`,
 * on the agent's own machine through its bridge (`CommandContext.deliver`),
 * because a download from an embedded browser pane may never reach a folder
 * anyone can open. The result says its name, size and — for anything with
 * sound — the loudness of the mix it carries, measured by the exporter on the
 * buffer it encoded (`measureMix`), so "is this at −14 LUFS?" is answered
 * without opening the file or rendering the mix a second time.
 *
 * It checks the media first: a file whose bytes are not on this device is
 * named and the export refused, rather than rendered as a silent soundtrack.
 * It runs under the caller's signal, so a caller that gives up stops the
 * render instead of leaving it to run on in the page.
 *
 * The resolution gate is the panel's: a free licence caps the longest edge,
 * and the verb says so rather than quietly shrinking the file.
 *
 * AN EXPORT IS A JOB (`renderJobs`): it waits in the app's one render line,
 * the call answers with the file if it is ready within `waitMs`, and with its
 * job id otherwise — `export.wait` collects it. Six exports sent at once used
 * to render at once and all time out in the agent app; now they queue, and no
 * call is held open for a whole render. A job outlives its call: a dropped
 * call or a bridge handover loses nothing, and its file is still delivered to
 * the session that asked.
 */

const WAIT_MS = 10_000;
/**
 * The longest ONE call may block. A call travels through MCP clients that drop
 * a request after 60 s unless they asked for progress (the MCP SDK's default
 * request timeout), so a 50 s `export.wait` timed out in the agent's client
 * while the schema allowed 120. A longer wait is another call: the job is
 * the app's and keeps rendering.
 */
const WAIT_MAX_MS = 45_000;

const FORMATS = ["mp4", "webm", "gif", "mov", "png-sequence", "png", "audio"] as const;

const exportRender = defineCommand({
  id: "export.render",
  summary: "Export a comp to a file — MP4, WebM, GIF, lossless MOV, PNG sequence, a PNG still or the sound alone — exactly as the Export panel does.",
  details:
    `Exports run one at a time, in line. The call answers with the file when it is ready within \`waitMs\` (default 10 s); otherwise it answers with a \`jobId\` — then call export.wait {jobIds} until its state is done (each wait blocks up to 25 s and reports progress). For several exports, send them all with waitMs 0, then one export.wait. Through the ${identity.name} bridge the file is written on the machine your MCP client runs on — to \`saveTo\`, or your Downloads folder — and the result gives its real path. Without a bridge that writes files it is handed to the browser as a download, which cannot be confirmed. Default: the whole comp at its own size and frame rate, High quality, with sound. \`startMs\`/\`endMs\` export a stretch (comp time); \`atMs\` picks the instant for a png. The result reports the loudness of the mix in the file (integrated LUFS, peak dBFS; \`{silent: true}\` when it is silent) for mp4, mov and audio — measured on the very mix the export encoded. WebM records its sound live and is not measured. Media missing from this device is named and the export refused.`,
  effect: "read",
  input: z.object({
    frameId: z.string().optional(),
    format: z.enum(FORMATS).default("mp4"),
    startMs: z.number().min(0).optional(),
    endMs: z.number().min(0).optional(),
    atMs: z.number().min(0).optional().describe("png only: the instant; default the playhead."),
    scale: z.number().min(0.1).max(4).default(1).describe("Output size × the comp's (2 = twice the pixels each way)."),
    fps: z.number().min(1).max(120).optional().describe("Default: the comp's frame rate."),
    quality: z.enum(["draft", "high", "master"]).default(DEFAULT_VIDEO_QUALITY),
    includeAudio: z.boolean().default(true),
    transparent: z.boolean().default(false).describe("gif, mov, png-sequence, png: no background."),
    name: z.string().optional().describe("File name without extension; default project-comp."),
    saveTo: z.string().optional().describe(SAVE_TO_DESCRIPTION),
    waitMs: z.number().min(0).max(WAIT_MAX_MS).default(WAIT_MS).describe("How long this call waits for the file before answering with its jobId (0 = at once)."),
  }),
  async run(input, rt) {
    const doc = rt.doc();
    const frame = frameAt(rt, input.frameId);
    const full = frameDurationMs(doc, frame);
    const start = Math.min(input.startMs ?? 0, full);
    const end = Math.min(input.endMs ?? full, full);
    if (end <= start && input.format !== "png") throw new ApiError(`Nothing to export between ${start} and ${end} ms.`, `The comp is ${full} ms long.`);

    // THE MONEY SEAM, as the panel draws it: past the free edge is Pro.
    if (!product.entitlements.has("export.highres") && input.format !== "audio" && input.scale > maxFreeScale(frame.width, frame.height) + 1e-6) {
      const cap = maxFreeScale(frame.width, frame.height);
      throw new ApiError(
        product.entitlements.refusal("export.highres", `Exporting ${Math.round(frame.width * input.scale)}×${Math.round(frame.height * input.scale)}`),
        `Free exports go up to scale ${cap.toFixed(2)} for this comp (${Math.round(frame.width * cap)}×${Math.round(frame.height * cap)}). Tell the user, or export at that scale.`,
      );
    }
    if (input.format === "mp4" && !mp4Supported()) throw new ApiError("This browser has no MP4 encoder.", 'Export format "webm" instead.');
    const deliver = input.saveTo !== undefined ? requireDelivery(rt) : null;

    // Every file the render reads must be here. Sound is checked only when
    // this export carries it — a GIF of a comp whose voice-over was lost is fine.
    const silent = !input.includeAudio || input.format === "gif" || input.format === "png" || input.format === "png-sequence";
    const missing = (await missingMedia(doc, frame.id)).filter((a) => !(silent && a.kind === "audio"));
    if (missing.length) throw bytesMissing(missing);

    // Paint still drying is part of the picture — the panel settles it first too.
    dryWetPaint(rt.store, doc);
    const label = `${input.name ?? frame.name} · ${input.format}`;
    let jobId = "";
    const job = renderJobs.enqueue({ label, owner: rt.caller }, (signal, progress) =>
      supervise(
        { kind: "export", label: `Export “${frame.name}”`, detail: input.format.toUpperCase(), subject: entityRef("frame", frame.id, frame.name) },
        async (task) => {
          // Activity's Stop is the job's cancel: one way to stop it.
          const off = task.onAbort(() => renderJobs.cancel(jobId));
          try {
            return await render(signal, (text, fraction) => {
              progress(text);
              if (fraction !== undefined) task.report({ progress: fraction });
            });
          } finally {
            off();
          }
        },
      ),
    );
    jobId = job.id;

    const [j] = await renderJobs.wait([job.id], input.waitMs, { signal: rt.signal, onProgress: rt.progress });
    // A caller that gives up while waiting stops the render, as before; after it has its job id, the job is its own.
    if (rt.signal?.aborted) {
      renderJobs.cancel(job.id);
      throw new ApiError("Cancelled; the export stopped.");
    }
    const answer = jobAnswer(j ?? job);
    if (j?.state === "failed") throw new ApiError(j.error ?? "The export failed.", j.hint);
    return answer;

    async function render(signal: AbortSignal, report: (text: string, fraction?: number) => void) {
      const options: VideoExportOptions = {
        startMs: start,
        durationMs: end - start,
        includeAudio: input.includeAudio,
        scale: input.scale,
        fps: input.fps,
        quality: input.quality,
        transparent: input.transparent,
        fileName: input.name,
        signal,
        onProgress: progressReporter(report),
        onReadiness: (r) => (fontsPending = r.fontsPending),
      };
      let fontsPending: string[] = [];

      let audio: { included: boolean; report?: string } | undefined;
      // The loudness of the mix the file carries, measured by the exporter on
      // the buffer it encoded — not a second render of the mix after the fact.
      let loudness: MixLoudness | null = null;
      const files = await collectSaves(async (save) => {
        options.save = save;
        switch (input.format) {
          case "mp4": {
            const r = await exportMp4(doc, frame, options);
            audio = { included: r.audioIncluded, report: r.audioReport };
            loudness = r.loudness;
            return;
          }
          case "webm":
            await exportWebm(doc, frame, options);
            return;
          case "gif":
            await exportGif(doc, frame, options);
            return;
          case "mov": {
            const r = await exportLosslessMov(doc, frame, options);
            audio = { included: r.audioIncluded };
            loudness = r.loudness;
            return;
          }
          case "png-sequence":
            await exportPngSequence(doc, frame, options);
            return;
          case "png":
            await exportPng(doc, frame, input.atMs ?? rt.session.playheadMs(), options);
            return;
          case "audio": {
            const r = await exportAudioOnly(doc, frame, options);
            audio = { included: true, report: r.report };
            loudness = r.loudness;
            return;
          }
        }
      });
      const landed: string[] = [];
      let undelivered: string | undefined;
      for (const f of files) {
        if (deliver && input.saveTo !== undefined && !undelivered) {
          report(`Saving ${f.name}`);
          try {
            landed.push(await deliver({ name: f.name, bytes: new Uint8Array(await f.blob.arrayBuffer()), path: input.saveTo }));
            continue;
          } catch (err) {
            // The render is not wasted because the agent's bridge went away: the user still gets the file.
            undelivered = err instanceof Error ? err.message : String(err);
          }
        }
        saveExport(f.blob, f.name);
      }

      const withSound = input.includeAudio && (input.format === "mp4" || input.format === "webm" || input.format === "mov" || input.format === "audio");

      // Sounds in this comp that ride nothing never reached the mix; name them.
      const silent = withSound ? silentSounds(doc.tracks.flatMap((t) => t.clips).filter((c) => c.frameId === frame.id)) : [];

      return {
        // "saved" and a path only when the bridge wrote the file; a browser download cannot be confirmed.
        [landed.length && !undelivered ? "saved" : "rendered"]: files.map((f) => ({ name: f.name, bytes: f.blob.size })),
        where: landed.length && !undelivered ? landed.join(", ") : BROWSER_DOWNLOAD,
        ...(undelivered ? { notDelivered: `${undelivered} It was handed to the browser as a download instead.` } : {}),
        size: [Math.round(frame.width * input.scale), Math.round(frame.height * input.scale)],
        durationMs: input.format === "png" ? 0 : end - start,
        fps: input.fps ?? frameFps(doc, frame),
        ...(audio ? { audio } : {}),
        ...(loudness ? { loudness } : {}),
        ...(silent.length ? { silentSounds: silent } : {}),
        ...fontReadinessNote(fontsPending, "file"),
      };
    }
  },
});

/** A job as an agent reads it: the export's own result once done, where it stands until then. */
function jobAnswer(j: JobView): Record<string, unknown> {
  if (j.state === "done") return { jobId: j.id, state: "done", ...(j.result as Record<string, unknown>) };
  if (isJobFinished(j)) return { jobId: j.id, state: j.state, ...(j.error ? { error: j.error } : {}), ...(j.hint ? { hint: j.hint } : {}) };
  return {
    jobId: j.id,
    state: j.state,
    ...(j.state === "queued" ? { ahead: j.ahead } : {}),
    ...(j.progress ? { progress: j.progress } : {}),
    next: `export.wait {jobIds: ["${j.id}"]}`,
  };
}

const exportWait = defineCommand({
  id: "export.wait",
  summary: "Wait for export jobs and get their files — or where each one is in line.",
  details:
    "Blocks until every listed job is done, or `waitMs` passes (default 25 s), and reports progress while it waits. Call it again until no job is queued or running. Without jobIds: this session's unfinished exports (or its recent ones when none is). A done job carries export.render's full result; a failed one its error.",
  effect: "read",
  input: z.object({
    jobIds: z.array(z.string()).optional(),
    waitMs: z.number().min(0).max(WAIT_MAX_MS).default(25_000),
  }),
  async run(input, rt) {
    const mine = renderJobs.list(rt.caller);
    const ids = input.jobIds ?? (mine.some((j) => !isJobFinished(j)) ? mine.filter((j) => !isJobFinished(j)) : mine.slice(-10)).map((j) => j.id);
    const unknown = ids.filter((id) => !renderJobs.get(id));
    if (input.jobIds && unknown.length === ids.length) throw new ApiError(`No export job ${unknown.join(", ")}.`, "Job ids come from export.render; the app keeps the last 50 jobs until it reloads.");
    const jobs = await renderJobs.wait(ids, input.waitMs, { signal: rt.signal, onProgress: rt.progress });
    const pending = jobs.filter((j) => !isJobFinished(j)).length;
    return {
      jobs: jobs.map(jobAnswer),
      pending,
      ...(unknown.length ? { unknown } : {}),
      ...(pending ? { next: "export.wait again with the same jobIds." } : {}),
    };
  },
});

const exportCancel = defineCommand({
  id: "export.cancel",
  summary: "Stop export jobs: a queued one leaves the line, a running one stops rendering.",
  effect: "read",
  input: z.object({ jobIds: z.array(z.string()).min(1) }),
  run(input) {
    return { cancelled: input.jobIds.filter((id) => renderJobs.cancel(id)) };
  },
});

/** "Exporting · 40%" at most once per percent — the bridge reads it as "still alive". */
function progressReporter(report: (text: string, fraction: number) => void): (fraction: number) => void {
  let last = -1;
  return (fraction) => {
    const pct = Math.floor(Math.max(0, Math.min(1, fraction)) * 100);
    if (pct === last) return;
    last = pct;
    report(`Exporting · ${pct}%`, fraction);
  };
}

export const exportCommands: AnyCommand[] = [exportRender, exportWait, exportCancel];
