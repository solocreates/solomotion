"use client";

import * as React from "react";
import { clipProvenance, licenseNeedsAttribution, parseIconId, type Clip } from "@solomotion/core";
import { useIconSets } from "../plugins/icons/use-icon-data";
import { useDoc } from "../state/document-context";
import { AccordionMeta, PanelSection, PropRow } from "./controls";

/**
 * WHERE THIS ARTWORK CAME FROM — the read-back of `clip.origin`. A tail
 * section: it exists so a licence question about a layer is answered in the
 * layer, months later, without the panel that placed it. The set's name and
 * links come from the catalogue when it is reachable; the record on the clip
 * (id, licence, credit) is what stands even when it is not.
 */
export function SourceSection({ clip }: { clip: Clip }) {
  const doc = useDoc();
  const origin = clipProvenance(doc, clip);
  const { sets } = useIconSets();
  if (!origin) return null;
  const ref = parseIconId(origin.id);
  const set = ref ? (sets?.find((s) => s.prefix === ref.prefix) ?? null) : null;
  const setName = set?.name ?? ref?.prefix ?? origin.id;
  const licence = origin.license ?? "Not recorded";
  return (
    <PanelSection id="source" title="Source" defaultOpen={false} summary={<AccordionMeta>{`${setName} · ${licence}`}</AccordionMeta>}>
      <PropRow label="Icon">
        <Value href={null}>{ref?.name ?? origin.id}</Value>
      </PropRow>
      <PropRow label="Set">
        <Value href={set?.author.url ?? null}>{setName}</Value>
      </PropRow>
      <PropRow label="Licence">
        <Value href={set?.license.url ?? null}>{licence}</Value>
      </PropRow>
      {licenseNeedsAttribution(origin.license) && (
        <PropRow label="Credit" hint="This licence asks for a credit line. Export offers the whole project's, ready to copy.">
          <Value href={null}>{origin.author}</Value>
        </PropRow>
      )}
    </PanelSection>
  );
}

function Value({ href, children }: { href: string | null; children: React.ReactNode }) {
  const cls = "truncate text-xs text-muted-foreground";
  return href ? (
    <a href={href} target="_blank" rel="noreferrer" className={`${cls} underline-offset-2 hover:text-foreground hover:underline`}>
      {children}
    </a>
  ) : (
    <span className={cls}>{children}</span>
  );
}
