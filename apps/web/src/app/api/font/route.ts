import { NextRequest, NextResponse } from "next/server";

/**
 * Font binary proxy for text outlining (SVG / Lottie export, text→path).
 *
 * Browsers only get woff2 from Google Fonts (UA-negotiated), and woff2 needs a
 * brotli decoder opentype.js doesn't bundle. Requesting the v1 CSS API with a
 * legacy user agent yields the older sfnt-based formats instead — historically
 * TTF, but Google now hands this UA plain WOFF. Both TTF and WOFF (woff1) parse
 * natively in opentype.js 2.x, so we accept EITHER (never woff2) and stream the
 * binary back long-cached. Preferring TTF when both appear keeps parsing cheap.
 */

const LEGACY_UA = "Mozilla/5.0 (Windows NT 6.1; rv:20.0) Gecko/20100101 Firefox/20.0";

/**
 * EVERY SCRIPT THE FAMILY HAS. Asked without `subset`, this API serves the
 * legacy agent a LATIN-only cut — Vazirmatn came back with 354 glyphs and no
 * Arabic at all, so Persian and Arabic text could not be outlined anywhere
 * (SVG and Lottie export, Convert to path, 3D extrude). Subsets a family does
 * not have are ignored, so one list serves every family.
 */
const SUBSETS = [
  "latin", "latin-ext", "arabic", "hebrew", "cyrillic", "cyrillic-ext", "greek", "greek-ext", "vietnamese",
  "devanagari", "bengali", "gujarati", "gurmukhi", "kannada", "malayalam", "tamil", "telugu", "sinhala",
  "thai", "khmer", "armenian", "georgian", "ethiopic", "korean", "japanese", "chinese-simplified",
].join(",");

/** First parseable font URL in the CSS: TTF wins, else WOFF; woff2 is skipped. */
function pickFontUrl(css: string): { url: string; type: string } | null {
  const urls = [...css.matchAll(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/g)].map((m) => m[1]!);
  const ttf = urls.find((u) => u.endsWith(".ttf") || u.endsWith(".otf"));
  if (ttf) return { url: ttf, type: ttf.endsWith(".otf") ? "font/otf" : "font/ttf" };
  const woff = urls.find((u) => u.endsWith(".woff"));
  if (woff) return { url: woff, type: "font/woff" };
  return null;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const family = req.nextUrl.searchParams.get("family");
  const weight = req.nextUrl.searchParams.get("weight") ?? "400";
  const italic = req.nextUrl.searchParams.get("italic") === "1";
  if (!family) return NextResponse.json({ error: "family required" }, { status: 400 });

  const spec = `${family.trim().replace(/\s+/g, "+")}:${italic ? "italic" : ""}${weight}`;
  const cssRes = await fetch(`https://fonts.googleapis.com/css?family=${spec}&subset=${SUBSETS}`, {
    headers: { "User-Agent": LEGACY_UA },
    // Fonts are immutable per URL — let the platform cache the CSS lookup.
    next: { revalidate: 60 * 60 * 24 },
  });
  if (!cssRes.ok) return NextResponse.json({ error: "font css unavailable" }, { status: 502 });
  const css = await cssRes.text();
  const picked = pickFontUrl(css);
  if (!picked) return NextResponse.json({ error: "no parseable font variant" }, { status: 404 });

  const fontRes = await fetch(picked.url, { next: { revalidate: 60 * 60 * 24 * 30 } });
  if (!fontRes.ok) return NextResponse.json({ error: "font fetch failed" }, { status: 502 });
  const bytes = await fontRes.arrayBuffer();
  return new NextResponse(bytes, {
    headers: {
      "Content-Type": picked.type,
      "Cache-Control": "public, max-age=2592000, immutable",
    },
  });
}
