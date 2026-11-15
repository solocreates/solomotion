import type * as React from "react";
import type { LucideIcon } from "lucide-react";
import type { StoredTheme } from "./theme/theme-tokens";

export type { StoredTheme };

/** Reads a theme record an older build of THIS product stored (one that predates the theme file). */
export type ThemeMigration = (
  stored: Record<string, unknown>,
  ctx: { base: StoredTheme; isLight(hex: string): boolean },
) => StoredTheme;

/** The capabilities a product may gate. The editor names them; the product decides. */
export type FeatureId = "export.video" | "export.transparent" | "export.highres" | "effect.premium" | "template.premium" | "agents";

/**
 * WHAT THIS PERSON MAY DO. The editor asks; it never knows why the answer is
 * no (a licence, a plan) or what the way to yes looks like. An open product
 * answers yes to everything.
 */
export interface Entitlements {
  /** Unlocked right now? Never prompts. No feature: anything at all. */
  has(feature?: FeatureId): boolean;
  /** The same, for React: re-renders when access changes. */
  useHas(feature?: FeatureId): boolean;
  /** Guard an action: true = go; false = the product already showed the way to yes. */
  require(feature?: FeatureId, source?: string): boolean;
  /** Show the way to yes without an action behind it. */
  prompt(feature?: FeatureId, source?: string): void;
  /** What a caller that cannot see the product (an agent) is told: `doing` is what was tried ("Exporting 3840×2160"). */
  refusal(feature: FeatureId, doing: string): string;
}

/** A Home composition a product may open in (see `ProductIdentity.home`). */
export type HomeLayoutId = "browser" | "studio";

/** How the Library and Media panels compose (see `ProductIdentity.browsers`). */
export type BrowserLayoutId = "plates" | "studio";

export type FeedbackTopic ="bug" | "feedback" | "contact";

/** How people tell the product something broke or could be better. */
export interface ProductFeedback {
  /** Open the product's way to send it. `note` is context the person did not type (what crashed). */
  open(topic?: FeedbackTopic, opts?: { rating?: number; note?: string }): void;
  /** An inline form for the crash screen; null — the crash screen offers `open` instead. */
  Form: React.ComponentType<{ topic: FeedbackTopic; note?: string; autoFocus?: boolean; onDone?: () => void; className?: string }> | null;
}

/** A page the product adds to Settings (before About). */
export interface ProductSettingsPage {
  id: string;
  label: string;
  icon: LucideIcon;
  Page: React.ComponentType;
}

/**
 * WHO the product is — its names and its looks — what every module may read
 * while the app is still loading. It lives in a LEAF module
 * (`products/<id>/web/identity.ts`) that imports nothing of the editor,
 * because the product's behaviour does, and an editor module that read the
 * product while it loaded would read nothing.
 */
export interface ProductIdentity {
  /** As it is written in a sentence and in the window title. */
  name: string;
  /**
   * The data namespace (lowercase letters and digits). Every name the app
   * leaves behind derives from it (`editor/names.ts`) — storage keys,
   * databases, caches, file and format ids — so it is the product's users'
   * data and never changes. Never compared: no code asks which product it is.
   */
  ns: string;
  /** Where the web app lives: the origin a copied link and a PDF's fallback use. */
  webOrigin: string;
  /** The extension a project slice (a few comps, with their media) is saved as. */
  sliceExt: string;
  /** The product's website: docs, changelog, terms (`<siteUrl>/docs`). */
  siteUrl: string;
  /** The look a fresh install opens in (a registered preset id). */
  defaultThemeId: string;
  /**
   * How Home is laid out (`editor/home/layouts`): `browser` is a file manager
   * (a sidebar of places, the New row as tiles); `studio` is a single column
   * under one top band (places as tabs, the New row as a shelf of frames drawn
   * at their true shape, on the theme's backdrop). Same data, same filer
   * engine, same actions; only the composition differs.
   */
  home: HomeLayoutId;
  /**
   * How the Library and Media panels compose. `plates`: shelves as icon tabs
   * on glass plates, cards as plates, Media's actions in a footer bar.
   * `studio`: shelves as a typographic index with the scope in the search
   * field, previews as hairline frames on the theme's backdrop with mono
   * metadata, Import in Media's head and selection actions in a float. Same
   * data, controllers and gestures; only the composition differs.
   */
  browsers: BrowserLayoutId;
  /**
   * Home offers the library's community examples: the Explore place, and the
   * examples a first run starts from. False: neither exists, and an empty
   * Home is the New row alone.
   */
  examples: boolean;
  /**
   * What New does with no size picked. `ask`: the New project dialog (name,
   * size, mode). `canvas`: no questions, a blank canvas with no frame, which
   * opens on the Frame tool (a document with no frame always does), so the
   * first gesture draws the board.
   */
  newProject: "ask" | "canvas";
  /** Where the app fetches what it never bundles. Env overrides (NEXT_PUBLIC_*) still win. */
  hosts: {
    /** The library catalogue root (templates, sounds, art styles), no trailing slash. */
    library: string;
    /** The lazy engines (models, runtimes), versioned by path. */
    models: string;
    /** The icon search proxy; null: the public API only. */
    icons: string | null;
    /** Where agent reports are collected from a build with no server of its own; null: they stay local. */
    agentFeedback: string | null;
  };
  /** The port the product's MCP bridge holds (packages/mcp identity.mjs derives the rest from `ns`). */
  mcpPort: number;
  /** Registers the product's own looks with the theme engine. Called once, before any theme is read. */
  registerThemes(): void;
  /** A theme an older build of this product stored, before the theme file. Absent: there is none. */
  migrateTheme?: ThemeMigration;
}

/**
 * The product's icons and install manifest, served by the editor
 * (`/favicon.svg`, `/icon-maskable.svg`, `/apple-touch-icon.svg`,
 * `/manifest.webmanifest`). Its own module (`#product/assets`), so the
 * markup never rides in the client bundle.
 */
export interface BrandAssets {
  /** The tab icon, SVG markup. */
  icon: string;
  appleIcon: string;
  /** Full-bleed for platforms that draw their own mask. */
  maskable: string;
  manifest: { description: string; background_color: string; theme_color: string };
  /** The product's Cloudflare Web Analytics site token (cookieless page views); null: no beacon. */
  webAnalyticsToken: string | null;
  /** The page's meta description: what a search result or a shared link shows. */
  description?: string;
}

/**
 * A PRODUCT is who the editor is, not how it looks: its name, its mark, its
 * loader and splash, the look it opens in, and what the top bar offers (a
 * licence for a paid product, Support for an open one).
 *
 * A theme never renames the app (picking the SoloMotion look in another product does
 * not put another product's logo on it), so identity is this separate seam,
 * chosen at BUILD time: `#product` resolves to `products/<PRODUCT>/web` (see
 * `next.config.ts`). Every surface that names or draws the product reads
 * `product` from `@/editor/product`, never a product module directly, and no
 * editor code asks WHICH product it is: there is no id to compare, only the
 * values a product brings.
 */
export interface Product extends ProductIdentity {
  /** The small mark: rails, menus, favicons. */
  Mark: React.ComponentType<{ className?: string; size?: number }>;
  /**
   * The logo as the top bar and Home draw it at full width — the product's
   * real lockup, never its name in UI type. `busy`: the app is working (an
   * agent, an export), and the lockup says so in its own motion. Narrow
   * widths draw `Mark` (or `Loader`) alone.
   */
  Lockup: React.ComponentType<{ className?: string; busy?: boolean }>;
  /** Where Support sends money and what the share text says (an open product); null: none. */
  support: {
    githubSponsors: string;
    buyMeACoffee: string | null;
    shareText: string;
    /** The GitHub thing a person can back for free: the public repo (a star)
     *  once there is one, until then the maintainer (a follow). */
    github: { kind: "repo" | "user"; slug: string };
  } | null;
  /** Waiting: loading, rendering, exporting. */
  Loader: React.ComponentType<{ className?: string; size?: number }>;
  /** The full-screen boot splash. */
  Splash: React.ComponentType;
  /** What the top bar offers: the paid licence, or the open project's Support. */
  entry: "licence" | "support";
  entitlements: Entitlements;
  feedback: ProductFeedback;
  /** Everything the product starts with the app (licence check, analytics…). Returns the teardown. */
  boot(): () => void;
  /** App-wide overlays the product owns (its upgrade or feedback dialogs). */
  Overlays: React.ComponentType;
  /** A strip above Home's projects, or nothing. */
  HomeBanner: React.ComponentType | null;
  /** The product's own row in the app menu's footer (the way to Pro; Support). */
  MenuEntry: React.ComponentType<{ className: string }> | null;
  /** Pages the product adds to Settings. */
  settingsPages: readonly ProductSettingsPage[];
}
