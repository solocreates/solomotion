"use client";

import * as React from "react";
import { Check, Copy, ExternalLink, Heart } from "lucide-react";
import {
  FUND_DEFAULT,
  FUND_STOPS,
  fundFraction,
  fundFromFraction,
  fundLine,
  settleFund,
  sponsorTabUrl,
  stepFund,
} from "@solomotion/theme";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { useRootDialect } from "@/components/ui/use-root-dialect";
import { product } from "../product";
import { useSupport } from "./support-store";

/**
 * SUPPORT, in the studio. The same two halves as the website's /support:
 * Fund it (the same amount bar, stops and words, from `@solomotion/theme`)
 * and Spread it. It opens only from the top bar's Support, never by itself,
 * never with a timer, and never interrupts work. A product with no Support
 * (`product.support` null) never mounts it.
 */
export function SupportDialog() {
  const open = useSupport((s) => s.open);
  const support = product.support;
  if (!support) return null;
  return (
    <Dialog open={open} onOpenChange={(v) => useSupport.getState().setOpen(v)}>
      <DialogContent className="w-[min(36rem,calc(100vw-2rem))] max-w-none gap-0 p-0">
        <div className="flex flex-col gap-1 px-6 pb-4 pt-6">
          <DialogTitle className="font-heading text-heading">Support {product.name}</DialogTitle>
          <p className="text-body text-fg-muted">It is open source and has no marketing budget. Both of these keep it going.</p>
        </div>
        <Fund sponsors={support.githubSponsors} coffee={support.buyMeACoffee} />
        <Spread text={support.shareText} url={product.siteUrl} />
      </DialogContent>
    </Dialog>
  );
}

function Fund({ sponsors, coffee }: { sponsors: string; coffee: string | null }) {
  const [amount, setAmount] = React.useState(FUND_DEFAULT);
  const [monthly, setMonthly] = React.useState(true);
  const [dragging, setDragging] = React.useState(false);
  const bar = React.useRef<HTMLDivElement>(null);
  const dialect = useRootDialect("range") ?? "meter";
  const f = fundFraction(amount);

  const fromX = (x: number, free: boolean) => {
    const r = bar.current!.getBoundingClientRect();
    return settleFund(fundFromFraction((x - r.left) / r.width), free);
  };
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const el = bar.current!;
    el.setPointerCapture(e.pointerId);
    setDragging(true);
    setAmount(fromX(e.clientX, e.shiftKey));
    const move = (ev: PointerEvent) => setAmount(fromX(ev.clientX, ev.shiftKey));
    const end = () => {
      setDragging(false);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", end);
      el.removeEventListener("pointercancel", end);
      el.removeEventListener("lostpointercapture", end);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
    el.addEventListener("lostpointercapture", end);
  };

  return (
    <section className="flex flex-col gap-4 border-t border-line px-6 py-5">
      <div className="flex items-baseline justify-between">
        <h3 className="text-label text-fg">Fund it</h3>
        <label className="flex items-center gap-2 text-body text-fg-muted">
          <span className={monthly ? "" : "text-fg"}>Once</span>
          <Switch checked={monthly} onCheckedChange={setMonthly} aria-label="Monthly" />
          <span className={monthly ? "text-fg" : ""}>Monthly</span>
        </label>
      </div>
      <div className="flex items-end gap-3">
        <span data-num="" className="text-[3.25rem] leading-none text-fg">
          <span className="text-fg-faint">$</span>
          {amount}
        </span>
        <span className="pb-1.5 text-body text-fg-muted">{monthly ? "every month" : "once"}</span>
      </div>
      <div
        ref={bar}
        role="slider"
        tabIndex={0}
        aria-label="Amount"
        aria-valuemin={1}
        aria-valuemax={500}
        aria-valuenow={amount}
        aria-valuetext={`$${amount}`}
        data-part="range"
        data-kind="amount"
        data-dialect={dialect}
        data-dragging={dragging || undefined}
        onPointerDown={onPointerDown}
        onKeyDown={(e) => {
          const dir = e.key === "ArrowRight" || e.key === "ArrowUp" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowDown" ? -1 : 0;
          if (!dir) return;
          e.preventDefault();
          setAmount((a) => (e.shiftKey ? settleFund(a + dir, true) : stepFund(a, dir)));
        }}
        className="relative flex h-10 cursor-ew-resize touch-none select-none items-center outline-none"
        style={{ "--f": f, "--lo": 0, "--hi": f } as React.CSSProperties}
      >
        <span aria-hidden data-el="fill" />
        <span aria-hidden data-el="ghost" />
        <span aria-hidden data-el="ghost" />
        <span aria-hidden data-el="ghost" />
        <span aria-hidden data-el="edge" />
        {FUND_STOPS.map((s) => (
          <span key={s} aria-hidden className="pointer-events-none absolute bottom-1 -translate-x-1/2 font-mono text-[0.625rem] text-fg-faint" style={{ left: `${fundFraction(s) * 100}%` }}>
            ${s}
          </span>
        ))}
      </div>
      <p aria-live="polite" className="font-heading text-title text-fg">
        {fundLine(amount)}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button asChild size="sm">
          <a href={sponsorTabUrl(sponsors, monthly)} target="_blank" rel="noopener">
            <Heart className="size-3.5" /> Sponsor ${amount} {monthly ? "monthly" : "once"}
          </a>
        </Button>
        {coffee && (
          <Button asChild size="sm" variant="secondary">
            <a href={coffee} target="_blank" rel="noopener">
              Buy a coffee
            </a>
          </Button>
        )}
        <span className="text-meta text-fg-faint">GitHub opens on the {monthly ? "monthly" : "one-time"} tab; enter ${amount} there.</span>
      </div>
    </section>
  );
}

function Spread({ text, url }: { text: string; url: string }) {
  const [done, setDone] = React.useState<string | null>(null);
  const copy = (key: string, value: string) =>
    void navigator.clipboard?.writeText(value).then(() => {
      setDone(key);
      setTimeout(() => setDone(null), 1400);
    });
  const enc = encodeURIComponent;
  const links = [
    { label: "Post on X", href: `https://x.com/intent/post?text=${enc(text)}&url=${enc(url)}` },
    { label: "Bluesky", href: `https://bsky.app/intent/compose?text=${enc(`${text} ${url}`)}` },
    { label: "LinkedIn", href: `https://www.linkedin.com/sharing/share-offsite/?url=${enc(url)}` },
  ];
  return (
    <section className="flex flex-col gap-3 border-t border-line px-6 pb-6 pt-5">
      <h3 className="text-label text-fg">Spread it</h3>
      <p className="text-body text-fg-muted">No budget means you are how people find out. One tap.</p>
      <div className="flex flex-wrap gap-1.5">
        {links.map((l) => (
          <Button key={l.label} asChild size="sm" variant="secondary">
            <a href={l.href} target="_blank" rel="noopener">
              {l.label} <ExternalLink className="size-3" />
            </a>
          </Button>
        ))}
        <Button size="sm" variant="ghost" onClick={() => copy("link", url)}>
          {done === "link" ? <Check className="size-3.5" /> : <Copy className="size-3.5" />} Copy the link
        </Button>
        <Button size="sm" variant="ghost" onClick={() => copy("about", `${text} ${url}`)}>
          {done === "about" ? <Check className="size-3.5" /> : <Copy className="size-3.5" />} Copy a description
        </Button>
      </div>
    </section>
  );
}
