"use client";

import * as React from "react";
import { useGenerate } from "./generate-bus";
import { useExternalAgentResume } from "./mcp-boot";
import { lazyComponent } from "@/editor/lazy-component";

const GenerateDialog = lazyComponent("GenerateDialog", () => import("./ui/GenerateDialog"));

/** Mounted by the editor; costs nothing until someone asks to generate (or switched an external agent's link on). */
export function GenerateHost() {
  useExternalAgentResume();
  const kind = useGenerate((s) => s.kind);
  const [wanted, setWanted] = React.useState(false);
  React.useEffect(() => {
    if (kind) setWanted(true);
  }, [kind]);
  if (!wanted) return null;
  return (
    <React.Suspense fallback={null}>
      <GenerateDialog />
    </React.Suspense>
  );
}
