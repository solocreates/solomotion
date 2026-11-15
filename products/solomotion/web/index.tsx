import { DialLoader, DialMark, DialWordmark } from "@solomotion/theme/react";
import type { Product } from "@/editor/product-types";
import { identity } from "./identity";
import { MenuEntry, entitlements, feedback } from "./parts";

/** Boot splash: the wordmark is the loader — its four o's click round
 *  together. No second spinner beside it; the name is already four dials. */
function SoloMotionSplash() {
  return (
    <div className="flex h-dvh items-center justify-center bg-background text-foreground">
      <DialWordmark turning beat={360} className="text-[2.5rem]" />
    </div>
  );
}

export const product: Product = {
  ...identity,
  Mark: ({ className, size = 24 }) => <DialMark className={className} size={size} title="SoloMotion" />,
  Loader: ({ className, size = 24 }) => <DialLoader className={className} size={size} />,
  // The four o's ARE the mark, so no dial beside them; busy, they turn.
  Lockup: ({ className, busy }) => <DialWordmark turning={busy} beat={360} className={className} />,
  support: {
    githubSponsors: "https://github.com/sponsors/novincode",
    buyMeACoffee: "https://buymeacoffee.com/codeideal",
    shareText:
      "SoloMotion is an open-source motion studio that runs in the browser: animation, editing, 3D and sound. No account, no subscription.",
    // A star on the public repo is the free way to back it. If the repo moves
    // to an organisation, this slug is the one line to change.
    github: { kind: "repo", slug: "solocreates/solomotion" },
  },
  Splash: SoloMotionSplash,
  entry: "support",
  entitlements,
  feedback,
  boot: () => () => {},
  Overlays: () => null,
  HomeBanner: null,
  MenuEntry,
  settingsPages: [],
};
