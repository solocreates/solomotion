import { assets } from "#product/assets";

/** The product's appleIcon (`products/<id>/web/assets.ts`), at the path it has always had. */
export const dynamic = "force-static";

export function GET() {
  return new Response(assets.appleIcon, { headers: { "content-type": "image/svg+xml" } });
}
