import { NextResponse } from "next/server";

/**
 * The freshest-deploy beacon. The running SPA bakes in its OWN version
 * (NEXT_PUBLIC_APP_VERSION) at build time; this route is served by whatever
 * deploy is currently live, so a stale tab can compare the two and detect drift
 * — no GitHub round-trip, no rate limits. Never cached, so it always reflects
 * the newest deploy the moment it ships.
 *
 * Only exists on the server build (the product's web origin). The desktop static export
 * stashes /api/*; the shell loads the remote app, so it hits this route there.
 */
export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json(
    { version: process.env.NEXT_PUBLIC_APP_VERSION ?? "dev" },
    { headers: { "Cache-Control": "no-store, max-age=0" } },
  );
}
