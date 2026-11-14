import { engineIdentity, type EngineIdentity } from "@solomotion/core";
import { identity } from "./identity";

/**
 * EVERY NAME THE APP LEAVES BEHIND — local storage keys, databases, caches,
 * ids it persists inside settings, file names, clipboard and drag tags, the
 * desktop shell's handshake — derived from ONE product value, its namespace.
 *
 * One table, one place: no call site spells a name. A product's names are its
 * users' data (a renamed database is an empty library), so each is
 * `ns + suffix` with the suffix carrying the separator it has always had, and
 * a product's own test freezes its resolved table (products/<id>). Adding a
 * name is adding a row here; renaming a row is a migration, never an edit.
 */
export function namesFor(ns: string) {
  return {
    /** localStorage / sessionStorage / zustand-persist keys. */
    storage: {
      windowSizes: (scope: string) => `${ns}.window-sizes.${scope}`,
      mcpAutoLink: `${ns}-mcp-auto`,
      mcpToken: `${ns}-mcp-token`,
      tabId: `${ns}-tab-id`,
      installId: `${ns}-install-id`,
      appSounds: `${ns}.app-sounds`,
      homeLayout: `${ns}.home.layout`,
      effectPreview: `${ns}.effect-preview`,
      lookFavourites: `${ns}.looks.favourites`,
      auditionPrefs: `${ns}-audition-prefs`,
      /** Read once to carry old SFX prefs into `auditionPrefs`. */
      legacySfxPrefs: `${ns}-sfx-prefs`,
      libraryBaseUrl: `${ns}.libraryBaseUrl`,
      heavyNoticeSeen: `${ns}.heavyNoticeSeen`,
      publisher: `${ns}.publisher`,
      libraryView: `${ns}.library-view`,
      locations: `${ns}.locations.v1`,
      propertyTransfer: `${ns}.propertyTransfer.v1`,
      patternImages: `${ns}.pattern-images`,
      pagesPane: `${ns}.pages-pane`,
      iconsPrefs: `${ns}-icons-prefs`,
      offlineReady: `${ns}.offline-ready`,
      scriptsBrief: `${ns}.scripts.brief`,
      capabilities: `${ns}.capabilities`,
      openTabs: `${ns}:open-tabs:v2`,
      legacyOpenTabs: `${ns}:open-tabs:v1`,
      legacyLastFont: `${ns}:last-font`,
      fontPrefs: `${ns}-font-prefs`,
      inspectorSections: `${ns}.inspector.sections`,
      marks: `${ns}-marks`,
      presets: `${ns}.presets.v1`,
      legacySavedEffects: `${ns}.savedEffects.v1`,
      theme: `${ns}.theme.v4`,
      /** The last compiled theme, painted before any script loads (layout.tsx). */
      themePaint: `${ns}.theme.paint`,
      legacyTheme: `${ns}.theme.v3`,
      analysisOnMain: `${ns}.analysis`,
      depthTemporal: `${ns}.depth.temporal`,
    },
    /** IndexedDB databases. */
    databases: {
      projects: `${ns}-projects`,
      assets: `${ns}-assets`,
      sound: `${ns}-sound`,
      fonts: `${ns}-fonts`,
      saveTargets: `${ns}-save-targets`,
      plugins: `${ns}-plugins`,
      agent: `${ns}-agent`,
      speech: `${ns}-speech`,
      depth: `${ns}-depth`,
      fsHandles: `${ns}-fs-handles`,
    },
    /** Cache Storage (the offline worker's own are named in `public/sw.js` from the same `ns`). */
    caches: {
      /** Everything this app's worker owns starts with this. */
      prefix: `${ns}-`,
      /** Caches that outlive app updates (the worker never sweeps them). */
      keepPrefix: `${ns}-keep:`,
      engines: `${ns}-keep:engines`,
      legacyModels: `${ns}-models-v1`,
      icons: `${ns}-icons-v1`,
      iconsKeyOrigin: `https://icons.${ns}.local/`,
    },
    /** Ids the app persists inside settings and documents. */
    ids: {
      defaultKeymap: ns,
      worldShortcuts: ns,
      builtinSkill: `builtin:${ns}`,
      builtinDesign: `builtin:${ns}-design`,
      samplePlugin: `studio.${ns}.sample-title-card`,
      testVoiceProvider: ns,
    },
    /** Names of files the app writes. */
    files: {
      fallbackName: ns,
      jsonExport: `.${ns}.json`,
      brief: `${ns}-brief.md`,
      theme: `${ns}-theme.json`,
      pluginManifest: `${ns}.plugin.json`,
    },
    /** Tags on the clipboard, in drags and between windows and workers. */
    wire: {
      clipboard: (kind: "clips" | "frame" | "properties" | "contours" | "animation") => `${ns}/${kind}`,
      clipboardPrefix: `${ns}/`,
      modulators: `${ns}/modulators@1`,
      variablesDrag: `application/x-${ns}-variables`,
      offline: `${ns}:offline`,
      offlineQuery: `${ns}:offline?`,
      plugin: (kind: "ready" | "req" | "res" | "evt") => `${ns}:${kind}` as const,
      /** The plugin API's global inside a plugin's frame (`window.<ns>`). */
      pluginGlobal: ns,
      documentStore: `${ns}.documentStore`,
      worker: (role: string) => `${ns}-${role}`,
      renderLock: `${ns}-render-`,
      osWindow: (key: string) => `${ns}-${key}`,
      /** The desktop shell's preload global — installed shells set it, so it is a handshake, not a name. */
      desktopGlobal: `__${ns.toUpperCase()}_DESKTOP__`,
      /** Dev and test hooks on `window` (e2e scripts drive the app through them). */
      debug: (role: "" | "Agent" | "Preview" | "Viewport") => `__${ns}${role}`,
    },
  };
}

export type Names = ReturnType<typeof namesFor>;

/** This build's names. */
export const NAMES: Names = namesFor(identity.ns);

/** Who this build is, as the engine needs to know (core `identity.ts`). */
export const ENGINE: EngineIdentity = engineIdentity(identity);
