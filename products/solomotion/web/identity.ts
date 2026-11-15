import type { ProductIdentity } from "@/editor/product-types";

/**
 * Who SoloMotion is — its names and its looks. A leaf: nothing here imports
 * the editor, so any module may read it while the app is still loading.
 * The namespace is its users' data once anyone has used it: never rename it.
 */
export const identity: ProductIdentity = {
  name: "SoloMotion",
  ns: "solomotion",
  webOrigin: "https://open.solomotion.app",
  // One file format: a slice IS a .motion bundle, and the reader merges either.
  sliceExt: ".motion",
  siteUrl: "https://solomotion.app",
  defaultThemeId: "solomotion",
  // Home is a single column under one band, closer to the site than to a file manager.
  home: "studio",
  browsers: "studio",
  // The shared catalogue's examples are another product's work: no Explore, no example shelf.
  examples: false,
  // A freeform canvas asks nothing: New is a blank canvas, and you draw the frame.
  newProject: "canvas",
  // A second custom domain on the same library bucket: one library, no copies.
  // Nothing may depend on these resolving before the domain exists.
  hosts: {
    library: "https://library.solomotion.app/v1",
    models: "https://library.solomotion.app/models/v1",
    icons: "https://icons.solomotion.app",
    agentFeedback: null,
  },
  // @solomotion/mcp (packages/mcp/src/identity.json); 7317 is the app's, so both can run at once.
  mcpPort: 7318,
  // The engine's own four looks are SoloMotion's; @solomotion/theme registers them.
  registerThemes: () => {},
};
