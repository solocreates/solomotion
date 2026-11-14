"use client";

import { useEffect, useState } from "react";
import { SURFACE_MATERIALS, createLayerEffect, resolveSurfaceParams, surfaceRecipe, type SurfaceEffect, type SurfaceMaterial } from "@solomotion/core";

/**
 * A MATERIAL, seen: a small flat sun (a star with a disc on it, on a cream
 * ground) rendered through the real Surface pass — the same code the stage
 * and the exporter run — so the swatch in the picker is the material, not a
 * picture of one. Rendered once per material per session, on first sight.
 *
 * The cut-out materials get a little lift (their body is their thickness),
 * and the ones whose sheet is a ground (neon's wall, chrome's studio) are
 * shown on it, so every swatch reads as its material at 20 px.
 */

const SIZE = 64;
const cache = new Map<string, string>();
const pending = new Map<string, Promise<string>>();

function scene(): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = c.height = SIZE;
  const g = c.getContext("2d")!;
  g.fillStyle = "#F2E8D5";
  g.fillRect(0, 0, SIZE, SIZE);
  g.fillStyle = "#F26A2E";
  g.beginPath();
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2 - Math.PI / 2;
    const r = i % 2 === 0 ? SIZE * 0.44 : SIZE * 0.22;
    g.lineTo(SIZE / 2 + Math.cos(a) * r, SIZE / 2 + Math.sin(a) * r);
  }
  g.closePath();
  g.fill();
  g.fillStyle = "#FAC43C";
  g.beginPath();
  g.arc(SIZE / 2, SIZE / 2, SIZE * 0.17, 0, Math.PI * 2);
  g.fill();
  return c;
}

async function render(material: SurfaceMaterial): Promise<string> {
  const { surface } = await import("../stage/render/passes/surface");
  const recipe = surfaceRecipe(material);
  const fx: SurfaceEffect = {
    ...(createLayerEffect("surface") as SurfaceEffect),
    material,
    lift: 10,
    edge: 0.3,
    colorMode: recipe.overlay === "ground" ? "under" : "lit",
  };
  const params = resolveSurfaceParams(fx, {}, 0.3, 0);
  const out = surface({ kind: "surface", params }, scene(), SIZE, SIZE, { backdrop: null });
  // The pass hands back a shared buffer; keep a copy of its pixels.
  const keep = document.createElement("canvas");
  keep.width = keep.height = SIZE;
  keep.getContext("2d")!.drawImage(out, 0, 0);
  return keep.toDataURL("image/png");
}

function swatch(material: SurfaceMaterial): Promise<string> {
  const hit = cache.get(material);
  if (hit) return Promise.resolve(hit);
  let p = pending.get(material);
  if (!p) {
    p = render(material).then((url) => {
      cache.set(material, url);
      pending.delete(material);
      return url;
    });
    pending.set(material, p);
  }
  return p;
}

export function MaterialSwatch({ material }: { material: string }) {
  const known = (SURFACE_MATERIALS as readonly string[]).includes(material);
  const [url, setUrl] = useState(() => (known ? (cache.get(material) ?? null) : null));
  useEffect(() => {
    if (!known || url) return;
    let live = true;
    void swatch(material as SurfaceMaterial).then((u) => live && setUrl(u));
    return () => {
      live = false;
    };
  }, [known, material, url]);
  if (!known) return <span aria-hidden className="size-4 shrink-0 rounded-sm border border-dashed border-border" />;
  return url ? (
    <img src={url} alt="" aria-hidden className="size-4 shrink-0 rounded-sm" />
  ) : (
    <span aria-hidden className="size-4 shrink-0 rounded-sm bg-muted" />
  );
}
