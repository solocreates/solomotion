import { NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { z } from "zod";
import { foldIntoCluster, priority, redactForUpload, type FeedbackCluster, type FeedbackEvent } from "@solomotion/agent";

/**
 * THE FEEDBACK COLLECTOR — where agent reports, ratings and signals from every
 * install arrive, and where they stop being a pile and become a backlog.
 *
 * Storage is the CLUSTER, not the event: each upload is folded into its
 * fingerprint's record (counts, tallies, the newest samples), so KV holds one
 * key per distinct problem however many people hit it. Distinct installs are
 * counted with a marker key per (fingerprint, install) that expires after 90
 * days, so a user who stops hitting a problem stops counting.
 *
 *   POST   { events: FeedbackEvent[] }            from the editor, anonymous
 *   GET    ?limit=50  (Authorization: Bearer …)   ranked clusters, for triage
 *
 * Bind a KV namespace as AGENT_FEEDBACK (wrangler.jsonc) to switch it on;
 * without one the route accepts and discards, so clients never error. Set
 * AGENT_FEEDBACK_TOKEN to allow reads.
 */

export const dynamic = "force-dynamic";

interface Kv {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  list(options: { prefix: string; cursor?: string; limit?: number }): Promise<{ keys: Array<{ name: string }>; list_complete: boolean; cursor?: string }>;
}

function binding(): { kv: Kv | null; token: string | null } {
  try {
    const env = getCloudflareContext().env as unknown as Record<string, unknown>;
    return { kv: (env.AGENT_FEEDBACK as Kv | undefined) ?? null, token: (env.AGENT_FEEDBACK_TOKEN as string | undefined) ?? null };
  } catch {
    return { kv: null, token: process.env.AGENT_FEEDBACK_TOKEN ?? null };
  }
}

const context = z.object({
  appVersion: z.string().max(40),
  apiVersion: z.number(),
  skillVersion: z.string().max(40),
  provider: z.string().max(40),
  model: z.string().max(120),
  installId: z.string().max(80),
});

// Validated loosely on purpose: the client owns the shape (`@solomotion/agent`
// feedback.ts); the server checks what it indexes on and caps everything else.
const event = z
  .object({
    id: z.string().max(80),
    at: z.number(),
    kind: z.enum(["report", "rating", "implicit"]),
    fingerprint: z.string().min(3).max(120),
    context,
  })
  .passthrough();

const body = z.object({ events: z.array(event).min(1).max(50) });

const INSTALL_TTL = 60 * 60 * 24 * 90;

export async function POST(request: Request) {
  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Bad feedback payload" }, { status: 400 });
  const { kv } = binding();
  if (!kv) return NextResponse.json({ accepted: parsed.data.events.length, stored: false }, { status: 202 });
  for (const raw of parsed.data.events) {
    const e = redactForUpload(raw as unknown as FeedbackEvent);
    const key = `c:${e.fingerprint}`;
    const marker = `i:${e.fingerprint}:${e.context.installId}`;
    const [current, seen] = await Promise.all([kv.get(key), kv.get(marker)]);
    const cluster = foldIntoCluster(current ? (JSON.parse(current) as FeedbackCluster) : null, e, seen !== null);
    await Promise.all([kv.put(key, JSON.stringify(cluster)), seen ? Promise.resolve() : kv.put(marker, "1", { expirationTtl: INSTALL_TTL })]);
  }
  return NextResponse.json({ accepted: parsed.data.events.length, stored: true }, { status: 202 });
}

export async function GET(request: Request) {
  const { kv, token } = binding();
  if (!token || request.headers.get("authorization") !== `Bearer ${token}`) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!kv) return NextResponse.json({ clusters: [] });
  const limit = Math.min(500, Number(new URL(request.url).searchParams.get("limit") ?? 50));
  const clusters: FeedbackCluster[] = [];
  let cursor: string | undefined;
  do {
    const page = await kv.list({ prefix: "c:", cursor, limit: 1000 });
    const values = await Promise.all(page.keys.map((k) => kv.get(k.name)));
    for (const v of values) if (v) clusters.push(JSON.parse(v) as FeedbackCluster);
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  // Re-rank at read time: recency decays, so stored priorities go stale.
  const now = Date.now();
  for (const c of clusters) c.priority = priority(c, now);
  clusters.sort((a, b) => b.priority - a.priority);
  return NextResponse.json({ clusters: clusters.slice(0, limit) }, { headers: { "Cache-Control": "no-store" } });
}
