import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, utimesSync, watchFile } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";
import { productPath, resolveProduct } from "./scripts/product.mjs";

// The product version is single-sourced from the ROOT package.json (bumped once
// per release) and embedded at build time as NEXT_PUBLIC_APP_VERSION, so the
// editor can display exactly which build is live — no runtime fetch needed.
const APP_VERSION = (
  JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string }
).version;

// A DEV SERVER MUST NOT OUTLIVE ITS VERSION. `next dev` reads this file once,
// so a server left running across a release kept embedding the version it
// started with: the linked editor told agents "4.23.0" while serving
// 4.24 code. Next restarts the dev server when this file changes, so when the
// root package.json's version moves, touch it — the restart re-reads the
// version (and anything else a release changed). Dev only; once per process.
const devWatch = globalThis as { __studioVersionWatch?: boolean };
if (process.env.NODE_ENV === "development" && !devWatch.__studioVersionWatch) {
  devWatch.__studioVersionWatch = true;
  const rootPackage = new URL("../../package.json", import.meta.url);
  const self = join(process.cwd(), "next.config.ts");
  watchFile(rootPackage, { interval: 2_000 }, () => {
    try {
      const now = (JSON.parse(readFileSync(rootPackage, "utf8")) as { version: string }).version;
      if (now !== APP_VERSION && existsSync(self)) {
        const t = new Date();
        utimesSync(self, t, t);
      }
    } catch {
      /* a half-written package.json: the next change answers */
    }
  });
}

// THE PRODUCT this build is: see scripts/product.mjs. The id lives only here:
// the bundle gets the product's modules through the `#product` aliases and
// never the id itself.
const PRODUCT = resolveProduct({ dev: process.env.NODE_ENV === "development" });
const PRODUCT_MODULE = productPath(PRODUCT, "web/index.tsx");
const IDENTITY_MODULE = productPath(PRODUCT, "web/identity.ts");
const ASSETS_MODULE = productPath(PRODUCT, "web/assets.ts");

// ONE id per build, known to the client: the offline worker is registered as
// `/sw.js?build=<id>` and precaches `/_next/static/<id>/offline-manifest.json`
// (scripts/offline-manifest.mjs, ADR-offline). Next re-reads this file in the
// workers a build spawns, so the id lives in the environment they inherit —
// a fresh random per evaluation would split one build into several ids.
process.env.STUDIO_BUILD_ID ??= `${APP_VERSION}-${randomBytes(4).toString("hex")}`;
const BUILD_ID = process.env.STUDIO_BUILD_ID;

/**
 * Two build targets from ONE codebase:
 *   • default              → `next build` — the standalone app served at
 *                            the product's web origin through its OWN OpenNext → Cloudflare
 *                            Worker (the product's own). A real server: it keeps the
 *                            /api/font proxy and renders /project/<id> URLs on
 *                            demand (shareable, refresh-safe), so the editor is
 *                            plainly URL-driven — no static/SPA workarounds.
 *   • BUILD_TARGET=desktop → static export to `out/`, loaded by the Electron
 *                            shell via the app:// scheme (no address bar, so it
 *                            stays store-driven — see use-url-sync.ts).
 *
 * Route handlers can't be statically exported, so `scripts/build-static.mjs`
 * stashes `src/app/api` for the desktop export and restores it after.
 */
const isDesktop = process.env.BUILD_TARGET === "desktop";

// The depth runtime is loaded by URL from the models origin, never bundled
// (tracking/depth-models.ts); its path is pinned to the installed version.
const ORT_VERSION = (
  JSON.parse(readFileSync(new URL("./node_modules/onnxruntime-web/package.json", import.meta.url), "utf8")) as { version: string }
).version;

const nextConfig: NextConfig = {
  transpilePackages: ["@solomotion/core", "@solomotion/platform", "@solomotion/plugin-sdk", "@solomotion/ui", "@solomotion/theme"],
  env: { NEXT_PUBLIC_APP_VERSION: APP_VERSION, NEXT_PUBLIC_BUILD_ID: BUILD_ID, NEXT_PUBLIC_ORT_VERSION: ORT_VERSION },
  generateBuildId: () => BUILD_ID,
  turbopack: { resolveAlias: { "#product": PRODUCT_MODULE, "#product/identity": IDENTITY_MODULE, "#product/assets": ASSETS_MODULE } },
  webpack: (config: { resolve: { alias: Record<string, string> } }) => {
    config.resolve.alias["#product$"] = fileURLToPath(new URL(PRODUCT_MODULE, import.meta.url));
    config.resolve.alias["#product/identity$"] = fileURLToPath(new URL(IDENTITY_MODULE, import.meta.url));
    config.resolve.alias["#product/assets$"] = fileURLToPath(new URL(ASSETS_MODULE, import.meta.url));
    return config;
  },
  // The React Compiler memoises every component and hook it can (ADR-framework,
  // "React Compiler"). It is only correct because no render reads state behind
  // React — `pnpm compiler:check` holds that line and `pnpm release` runs it.
  // The Rust port compiles inside Turbopack (+23% compile, not ×4 like Babel).
  // The memoisation default is pinned: the two implementations may differ.
  reactCompiler: { environment: { enablePreserveExistingMemoizationGuarantees: true } },
  experimental: { turbopackRustReactCompiler: true },
  ...(isDesktop
    ? {
        output: "export",
        // Static export can't run the image optimizer; the editor doesn't use
        // next/image anyway, so this is just belt-and-suspenders.
        images: { unoptimized: true },
      }
    : {}),
};

export default nextConfig;
