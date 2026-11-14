"use client";

import { product } from "@/editor/product";
import * as React from "react";
import dynamic from "next/dynamic";
import { initPlatform } from "@solomotion/platform";
import { installSafety } from "@/editor/runtime/install-safety";
import { installOffline } from "@/editor/runtime/offline";
import { AppSplash } from "@/components/ui/app-splash";
import { NotificationHost } from "@/components/notifications";
import { UpdateChecker, UpdateDialog } from "@/editor/update";

// The editor is fully client-side (canvas, WebAudio, pointer gestures).
// `ssr: false` requires the `dynamic()` call itself to live in a Client
// Component — layout.tsx (a Server Component) renders this wrapper instead
// of calling `dynamic()` directly.
const Editor = dynamic(() => import("@/editor/Editor"), {
  ssr: false,
  loading: () => <AppSplash />,
});

export function ClientEditor() {
  // Boot the platform bridge once, as early as the client mounts: installs
  // console capture so the in-app Console window catches everything, in the
  // browser and the Electron desktop shell alike.
  React.useEffect(() => {
    initPlatform();
    // Immediately after the platform bridge, and before the editor chunk loads:
    // it claims uncaught errors from the log bus, so anything that goes wrong
    // during boot is already being funnelled rather than logged raw.
    const stopSafety = installSafety();
    // Every file this build ships, kept on disk by the offline worker — and a
    // chunk that still cannot load said out loud (ADR-offline).
    const stopOffline = installOffline();
    // Whatever the product starts with the app (a licence check, its analytics).
    const stopProduct = product.boot();
    return () => {
      stopProduct();
      stopOffline();
      stopSafety();
    };
  }, []);
  return (
    <>
      <Editor />
      {/* App-wide overlays: the reusable notification stack, the update
          orchestrator (headless), and its dialog. All no-ops until something
          actually happens, so they're cheap to always mount. */}
      <NotificationHost />
      <UpdateChecker />
      <UpdateDialog />
      <product.Overlays />
    </>
  );
}
