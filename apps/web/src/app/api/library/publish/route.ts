import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { NextResponse } from "next/server";
import {
  packSourceSchema,
  parsePublisherRoster,
  previewPathFor,
  publishRequestSchema,
  upsertPackSource,
  verifyPublisher,
  type PackSource,
} from "@solomotion/core";

/**
 * PUBLISH — writes into the CONTENT REPO on this machine. Not into R2.
 *
 * The editor produces what amounts to a commit: the bytes, plus the entry
 * folded into that pack's `pack.json`. A human then reviews the diff and runs
 * `pnpm library:publish`. Git stays the source of truth, which is the whole
 * reason the catalogue needs no database — and it means a bad publish is a
 * `git checkout`, never a live catalogue serving something we did not mean.
 *
 * There is therefore no deployed publishing. On a Worker there is no content
 * repo to write to and this returns 501, which is correct rather than
 * unfortunate: publishing is a developer action, and pretending otherwise would
 * mean handing an R2 credential to a browser.
 */

export const runtime = "nodejs";

/** Subdirectory a kind's files live in, inside a pack. */
const KIND_DIR: Record<string, string> = {
  sound: "audio",
  media: "media",
  component: "components",
  text: "presets",
  animation: "presets",
  transition: "presets",
  template: "projects",
};

const roster = () => parsePublisherRoster(process.env.LIBRARY_PUBLISHERS);

export async function POST(request: Request) {
  const contentDir = process.env.LIBRARY_CONTENT_DIR;
  if (!contentDir) {
    return NextResponse.json(
      {
        error:
          "No content repo here. Publishing runs on a developer machine: set LIBRARY_CONTENT_DIR to your library content checkout.",
      },
      { status: 501 },
    );
  }

  const parsed = publishRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Bad request" }, { status: 400 });
  }
  const body = parsed.data;

  const publisher = verifyPublisher(roster(), body.publisher);
  if (!publisher) {
    return NextResponse.json({ error: "Publisher id or secret not recognised" }, { status: 403 });
  }

  const root = resolve(contentDir);
  const packDir = join(root, "packs", body.pack.id);
  const relPath = `${KIND_DIR[body.pack.kind] ?? "files"}/${body.entry.fileName}`;
  const filePath = join(packDir, relPath);
  // The file name is the only user-controlled path segment; keep it inside the
  // pack, always. A publish that can write anywhere on disk is not a feature.
  if (!resolve(filePath).startsWith(`${packDir}/`)) {
    return NextResponse.json({ error: "Invalid file name" }, { status: 400 });
  }

  let existing: PackSource | null = null;
  try {
    existing = packSourceSchema.parse(JSON.parse(await readFile(join(packDir, "pack.json"), "utf8")));
  } catch {
    existing = null;
  }
  if (existing?.publisher && existing.publisher.id !== publisher.id) {
    return NextResponse.json({ error: `“${existing.title}” belongs to another publisher` }, { status: 403 });
  }

  const { pack, replaced } = upsertPackSource(
    existing,
    { ...body, entry: { ...body.entry, fileName: relPath } },
    publisher,
  );

  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, Buffer.from(body.fileBase64, "base64"));
  if (body.preview) {
    await writeFile(join(packDir, previewPathFor(relPath, body.preview.ext)), Buffer.from(body.preview.base64, "base64"));
  }
  await writeFile(join(packDir, "pack.json"), `${JSON.stringify(pack, null, 2)}\n`);

  return NextResponse.json({
    ok: true,
    packId: pack.id,
    entryId: body.entry.fileName.replace(/\.[^.]+$/, ""),
    path: `packs/${pack.id}/${relPath}`,
    replaced,
  });
}

/** Which packs this publisher owns — what the dialog offers to add to. */
export async function GET(request: Request) {
  const contentDir = process.env.LIBRARY_CONTENT_DIR;
  if (!contentDir) return NextResponse.json({ packs: [], available: false });

  const url = new URL(request.url);
  const publisher = verifyPublisher(roster(), {
    id: url.searchParams.get("id") ?? "",
    secret: url.searchParams.get("secret") ?? "",
  });
  if (!publisher) return NextResponse.json({ error: "Not recognised" }, { status: 403 });

  const { readdir } = await import("node:fs/promises");
  const root = resolve(contentDir);
  let dirs: string[] = [];
  try {
    dirs = await readdir(join(root, "packs"));
  } catch {
    dirs = [];
  }
  const packs = [];
  for (const dir of dirs) {
    try {
      const pack = packSourceSchema.parse(
        JSON.parse(await readFile(join(root, "packs", dir, "pack.json"), "utf8")),
      );
      if (pack.publisher?.id === publisher.id) {
        packs.push({ id: pack.id, title: pack.title, kind: pack.kind, count: pack.files.length });
      }
    } catch {
      /* a pack that will not parse is a build failure, not a publish failure */
    }
  }
  return NextResponse.json({ packs, available: true, publisher });
}
