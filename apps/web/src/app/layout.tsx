import type { Metadata, Viewport } from "next";
import { NAMES } from "@/editor/names";
import { identity } from "@/editor/identity";
import { assets } from "#product/assets";
import { Doto, Geist, Geist_Mono, IBM_Plex_Mono, Inter, JetBrains_Mono, Martian_Mono, Space_Grotesk } from "next/font/google";
import { cursorVariables } from "@solomotion/ui/cursors";
import { ClientEditor } from "./ClientEditor";
import { firstPaint } from "@/editor/theme/first-paint";

const PAINT = firstPaint();
import "./globals.css";

// Inter is the UI face. A dense tool chrome lives at 11-13px, where a display
// family (Space Grotesk) reads as a mockup rather than an instrument — Inter's
// tall x-height and tuned small-size hinting are the reason every serious
// editor uses it or its cousins. Space Grotesk stays available as a theme
// option (and remains the marketing site's voice).
const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  axes: ["opsz"],
});

const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-space-grotesk",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains-mono",
});

// The families a theme may name (`@solomotion/theme` FONTS). Declared here so
// they are self-hosted and work offline, but NOT preloaded: a browser fetches
// a face only when the active theme actually renders with it, so a look
// nobody picked costs nothing.
const geist = Geist({ subsets: ["latin"], variable: "--font-geist", preload: false });
const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono", preload: false });
const doto = Doto({ subsets: ["latin"], variable: "--font-doto", weight: ["600", "700", "800"], preload: false });
const martianMono = Martian_Mono({ subsets: ["latin"], variable: "--font-martian-mono", preload: false });
const plexMono = IBM_Plex_Mono({ subsets: ["latin"], variable: "--font-ibm-plex-mono", weight: ["400", "500", "600"], preload: false });
// On <html>, not <body>: the theme's font stacks (`--font-ui: var(--font-geist), …`)
// are set on the root, and a var() inside a custom property resolves where it
// is declared — on <body> the families would be undefined at the root.
const FONT_VARS = [inter, spaceGrotesk, jetbrainsMono, geist, geistMono, doto, martianMono, plexMono].map((f) => f.variable).join(" ");

// The web app (the product's web origin) is an installable PWA that works offline: the
// editor registers its own worker (public/sw.js?build=…, ADR-offline). The
// desktop build (loaded from disk via app://) has no use for a web manifest,
// so it's skipped there.
const IS_DESKTOP = process.env.BUILD_TARGET === "desktop";

// Runs before any chunk, so a FOREIGN worker (another project once served on
// this origin) is gone before it can serve this page mismatched chunks. Ours
// is `/sw.js?build=…` and is left alone in production; in development every
// worker goes, ours included — dev chunks are not content-hashed, and a
// production worker left on localhost must not outlive `next start`. The
// `<ns>-keep:` caches (lazy engines, versioned by their own URLs) survive
// both: they are never a build's, so no build may take them.
const KEEP_OURS = process.env.NODE_ENV === "production";
const WORKER_CLEANUP = `if('serviceWorker' in navigator){navigator.serviceWorker.getRegistrations().then(function(rs){rs.forEach(function(r){var w=r.active||r.waiting||r.installing;if(!${KEEP_OURS}||!w||!/\\/sw\\.js\\?build=/.test(w.scriptURL))r.unregister()})}).catch(function(){})}if(self.caches){caches.keys().then(function(ks){ks.forEach(function(k){if(k.indexOf('${NAMES.caches.keepPrefix}')!==0&&(!${KEEP_OURS}||k.indexOf('${NAMES.caches.prefix}')!==0))caches.delete(k)})}).catch(function(){})}`;

// Leads with what the app IS rather than the brand — this is the page a search
// result or a shared link lands on, and the product's name means nothing to someone who
// has not met it yet. Kept deliberately close to the marketing site's wording
// so the two read as one product.
export const metadata: Metadata = {
  title: identity.name,
  description: assets.description,
  applicationName: identity.name,
  appleWebApp: { capable: true, title: identity.name, statusBarStyle: "black-translucent" },
  // The product's own (`products/<id>/web/assets.ts`), served from app routes.
  icons: { icon: [{ url: "/favicon.svg", type: "image/svg+xml" }], apple: "/apple-touch-icon.svg" },
};

export const viewport: Viewport = {
  themeColor: PAINT.themeColor,
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`dark ${FONT_VARS}`} {...PAINT.attrs} suppressHydrationWarning>
      <head>
        {/* The product's look before anything loads, then the look this person last saw. */}
        <style dangerouslySetInnerHTML={{ __html: PAINT.css }} />
        <script dangerouslySetInnerHTML={{ __html: PAINT.script }} />
        {/*
          A stale worker from another project on this origin can serve
          mismatched chunks and crash the app ("originalFactory is undefined").
          This unregisters any worker that is not ours, and its caches.
        */}
        <script dangerouslySetInnerHTML={{ __html: WORKER_CLEANUP }} />
        <style dangerouslySetInnerHTML={{ __html: cursorVariables() }} />
        {!IS_DESKTOP && (
          <>
            <link rel="manifest" href="/manifest.webmanifest" />
            {/* The apple-mobile-web-app-* pair now comes from `appleWebApp` in
                the metadata above; only the non-Apple twin is still hand-written. */}
            <meta name="mobile-web-app-capable" content="yes" />
          </>
        )}
      </head>
      <body className="font-sans">
        {/* Mounted here, ABOVE the routed {children}, on purpose: it owns the
            one long-lived document store for the app's lifetime (undo
            history, loaded media, playback). `/` <-> `/project/[id]` are
            just URL reflections of which project that store currently holds
            (see editor/state/use-url-sync.ts) — the editor must never
            remount when that URL changes. */}
        <ClientEditor />
        {children}
        {/* Messages route to the bottom bar (editor/panels/BottomRail),
            not floating toasts — see @/lib/toast + editor/state/status-bar. */}
        {/* Cloudflare Web Analytics — cookieless page views only (no events,
            nothing about documents), when the product has a site token; the
            zone's auto-injection doesn't reach a Worker-served page. */}
        {assets.webAnalyticsToken && (
          <script
            defer
            src="https://static.cloudflareinsights.com/beacon.min.js"
            data-cf-beacon={JSON.stringify({ token: assets.webAnalyticsToken })}
          />
        )}
      </body>
    </html>
  );
}
