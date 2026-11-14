import { DialLoader, DialMark, DialWordmark } from "@solomotion/theme/react";
import type { Product } from "@/editor/product-types";
import { identity } from "./identity";
import { MenuEntry, entitlements, feedback } from "./parts";

/** Boot splash: the wordmark, and the one dial turning a quarter per beat.
 *  Nothing else; the green does the talking. */
function SoloMotionSplash() {
  return (
    <div className="flex h-dvh flex-col items-center justify-center gap-7 bg-background text-foreground">
      <DialWordmark className="text-[2.5rem]" />
      <DialLoader size={22} beat={360} />
    </div>
  );
}

export const product: Product = {
  ...identity,
  Mark: ({ className, size = 24 }) => <DialMark className={className} size={size} title="SoloMotion" />,
  Loader: ({ className, size = 24 }) => <DialLoader className={className} size={size} />,
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
