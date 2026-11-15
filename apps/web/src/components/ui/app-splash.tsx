"use client";

import * as React from "react";
import { product } from "@/editor/product";

/**
 * The boot splash: the product's own (`products/<id>/web`), painted by the
 * server and kept until the editor has mounted.
 *
 * It is NOT the `loading` of the editor's `dynamic(ssr:false)` boundary. That
 * boundary bails out to the client, and React client-renders a bailed-out
 * Suspense boundary from scratch: the server's splash was thrown away and a
 * new one mounted mid-animation — the "quick double reload" on every boot.
 * As a sibling it is HYDRATED instead, so the one painted on first byte is the
 * one that turns until the editor is there, then fades.
 */
export function AppSplash({ done }: { done: boolean }) {
  const Splash = product.Splash;
  const [gone, setGone] = React.useState(false);
  if (gone) return null;
  return (
    <div
      aria-hidden={done || undefined}
      data-boot-splash=""
      onTransitionEnd={() => done && setGone(true)}
      className={`fixed inset-0 z-[1000] transition-opacity duration-200 ease-out ${done ? "pointer-events-none opacity-0" : "opacity-100"}`}
    >
      <Splash />
    </div>
  );
}
