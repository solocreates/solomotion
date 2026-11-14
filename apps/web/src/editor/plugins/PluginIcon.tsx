"use client";

import { cn } from "@/lib/utils";
import type { PluginIcon } from "./plugin-model";

/**
 * A plugin's MARK — one object, whatever art the plugin ships.
 *
 * A plugin's icon arrives in three shapes: a Lucide glyph (built-ins), the
 * plugin's own raster or SVG file (installed), or nothing at all (generated
 * initials). This used to render each of them literally, so an image and an
 * initial got a rounded tile and a glyph got no container at all — a bare 32px
 * stroke drawing floating beside two solid squares. In one list that reads as
 * three different kinds of thing, which is most of why the panel looked
 * unfinished: the eye can't find a column edge that isn't there.
 *
 * So the TILE is the mark and the art is its content. Same footprint, same
 * radius, same optical weight, whether a plugin ships a photo, a logo, an SVG
 * or nothing. Third-party art is cropped to fill and clipped by the tile, so no
 * plugin can break the row's rhythm with a wide banner or a transparent sliver.
 */
export function PluginMark({
  icon,
  size = "md",
  className,
}: {
  icon: PluginIcon;
  /** `sm` for menu rows, `md` for the panel's list. */
  size?: "sm" | "md";
  className?: string;
}) {
  const sm = size === "sm";
  return (
    <span
      aria-hidden
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center overflow-hidden",
        // The app's discrete-neutral object, same as a keycap or a badge —
        // so a plugin's mark belongs to the same family as everything else.
        "material-chip",
        sm ? "size-5 rounded-[5px]" : "size-7 rounded-md",
        className,
      )}
    >
      <Art icon={icon} sm={sm} />
    </span>
  );
}

function Art({ icon, sm }: { icon: PluginIcon; sm: boolean }) {
  if (icon.kind === "lucide") {
    const Icon = icon.icon;
    // Inset from the tile, like an app icon inside its squircle. At full size
    // the glyph touches the corners and the tile stops reading as a tile.
    return <Icon className={cn("text-foreground/85", sm ? "size-3" : "size-4")} />;
  }
  if (icon.kind === "image") {
    // eslint-disable-next-line @next/next/no-img-element -- data URL from the bundle, not a remote asset
    return <img src={icon.src} alt="" className="absolute inset-0 size-full object-cover" draggable={false} />;
  }
  return (
    <span
      className={cn(
        "absolute inset-0 flex items-center justify-center font-semibold leading-none text-white",
        sm ? "text-[8px]" : "text-[10px]",
      )}
      style={{ background: `hsl(${icon.hue} 48% 44%)` }}
    >
      {icon.text}
    </span>
  );
}
