import type { BrandAssets } from "@/editor/product-types";

/** SoloMotion's icons (the Dial at a quarter turn) and install manifest. */
const ICON = "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 64 64\"><rect width=\"64\" height=\"64\" rx=\"14\" fill=\"#0a0b0a\"/><circle cx=\"32\" cy=\"32\" r=\"22\" fill=\"#164d36\"/><path d=\"M32 32L16.44 16.44A22 22 0 0 1 47.56 16.44Z\" fill=\"#3df2a8\"/></svg>";

export const assets: BrandAssets = {
  icon: ICON,
  appleIcon: ICON,
  // Full bleed: the platform draws its own mask.
  maskable: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 64 64\"><rect width=\"64\" height=\"64\" fill=\"#0a0b0a\"/><circle cx=\"32\" cy=\"32\" r=\"22\" fill=\"#164d36\"/><path d=\"M32 32L16.44 16.44A22 22 0 0 1 47.56 16.44Z\" fill=\"#3df2a8\"/></svg>",
  description:
    "SoloMotion, the open-source studio for motion: an infinite canvas married to a timeline. Vector pen and brushes, keyframe any property, effects, colour grading, motion tracking and frame-by-frame animation — exporting MP4, WebM, GIF, SVG and Lottie. Runs in the browser, no account needed.",
  // Open source and unmeasured.
  webAnalyticsToken: null,
  manifest: {
    description: "An open-source studio for motion: design, animate and edit on a canvas married to a timeline.",
    background_color: "#0a0b0a",
    theme_color: "#0a0b0a",
  },
};
