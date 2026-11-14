"use client";

import { Heart } from "lucide-react";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import type { Entitlements, ProductFeedback } from "@/editor/product-types";
import { identity } from "./identity";

/**
 * SoloMotion's half of the product seam. Open source: everything is unlocked,
 * nothing is measured, feedback is a public issue, and the menu's own row is
 * Support — quiet, never a nag.
 */

const REPO_URL = "https://github.com/novincode/solomotion";

export const entitlements: Entitlements = {
  has: () => true,
  useHas: () => true,
  require: () => true,
  prompt: () => {},
  refusal: (_feature, doing) => `${doing} is not available here.`,
};

const ISSUE_LABEL = { bug: "bug", feedback: "idea", contact: "question" } as const;

export const feedback: ProductFeedback = {
  open: (topic = "bug", opts) => {
    const body = opts?.note ? `\n\n---\n${opts.note}` : "";
    const url = `${REPO_URL}/issues/new?labels=${ISSUE_LABEL[topic]}&body=${encodeURIComponent(body)}`;
    window.open(url, "_blank", "noopener,noreferrer");
  },
  Form: null,
};

export function MenuEntry({ className }: { className: string }) {
  return (
    <DropdownMenuItem className={className} onClick={() => window.open(`${identity.siteUrl}/support`, "_blank", "noopener,noreferrer")}>
      <Heart /> Support
    </DropdownMenuItem>
  );
}
