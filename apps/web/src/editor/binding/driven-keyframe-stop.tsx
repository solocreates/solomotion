"use client";

import * as React from "react";
import { parseSource } from "@solomotion/core";
import { Diamond } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { SOURCE_META } from "./dynamic-field";

/**
 * The keyframe diamond on a driven row: present, disabled, and saying why.
 *
 * A source owns its property outright — the bake drops the property's keyframe
 * track, so a key set here could never be read. The cluster used to be replaced
 * by a chip, which answered a different question ("what drives this?") and left
 * the real one ("why can't I key this?") to be discovered by clicking a control
 * that did nothing.
 */
export function DrivenKeyframeStop({ token }: { token: string }) {
  const source = parseSource(token);
  if (source.kind === "literal") return null;
  const meta = SOURCE_META[source.kind];
  return (
    <div className="flex items-center justify-end">
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="flex size-5 cursor-help items-center justify-center opacity-60">
            <Diamond className="size-2.5" strokeWidth={2.5} style={{ color: meta.tint }} />
          </span>
        </TooltipTrigger>
        <TooltipContent side="left">
          {meta.word} owns this value — detach it to keyframe it
        </TooltipContent>
      </Tooltip>
    </div>
  );
}
