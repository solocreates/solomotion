import { assets } from "#product/assets";
import { identity } from "#product/identity";

/** The install manifest, from the product: its name, colours and icons. */
export const dynamic = "force-static";

export function GET() {
  const manifest = {
    name: identity.name,
    short_name: identity.name,
    description: assets.manifest.description,
    id: "/",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "any",
    background_color: assets.manifest.background_color,
    theme_color: assets.manifest.theme_color,
    categories: ["graphics", "productivity", "photo", "video"],
    icons: [
      { src: "/favicon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
      { src: "/icon-maskable.svg", sizes: "any", type: "image/svg+xml", purpose: "maskable" },
    ],
  };
  return new Response(JSON.stringify(manifest, null, 2), { headers: { "content-type": "application/manifest+json" } });
}
