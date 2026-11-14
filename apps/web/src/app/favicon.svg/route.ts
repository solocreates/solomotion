import { assets } from "#product/assets";

/** The product's icon (`products/<id>/web/assets.ts`), at the path it has always had. */
export const dynamic = "force-static";

export function GET() {
  return new Response(assets.icon, { headers: { "content-type": "image/svg+xml" } });
}
