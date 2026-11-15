"use client";

import * as React from "react";
import { Check, Link2, Send, Star, Users } from "lucide-react";
import { FUND_COINS, FUND_DEFAULT, FUND_STOPS, type FundCadence, sponsorTabUrl } from "@solomotion/theme";
import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/ui/segmented";
import { cn } from "@/lib/utils";
import { product, type Product } from "../product";
import { BlueskyMark, GithubMark, LinkedinMark, XMark } from "./brand-icons";
import { githubUrl, githubVerb, shortCount, useGithubCount } from "./github-count";
import { WarmHeart } from "./WarmHeart";
import s from "./support.module.css";

type Support = NonNullable<Product["support"]>;

/**
 * SUPPORT, in the studio — the popover under the top bar's heart. Two halves,
 * ranked: FUND (tier 1, the reason it exists: pick a coin, one button to the
 * real page) and SPREAD (tier 2, free: a GitHub star or follow, share, tell a
 * friend). One line of copy per half; the amount, the heart and the coins say
 * the rest. Every link comes from `product.support`, never from here.
 */
export function SupportPanel({ support }: { support: Support }) {
  return (
    <div className={cn(s.root, "flex flex-col")}>
      <Fund support={support} />
      <Spread support={support} />
    </div>
  );
}

const COIN_COUNT = FUND_STOPS.length;
const levelOf = (i: number) => 0.28 + (0.72 * i) / (COIN_COUNT - 1);

function Fund({ support }: { support: Support }) {
  // The chosen COIN, not dollars: the amount is derived from the cadence's
  // row, so switching cadence keeps your place and the heart's fill.
  const [index, setIndex] = React.useState<number>(() => Math.max(0, FUND_STOPS.indexOf(FUND_DEFAULT as (typeof FUND_STOPS)[number])));
  const [cadence, setCadence] = React.useState<FundCadence>("monthly");
  const stops = FUND_COINS[cadence];
  const amount = stops[index] ?? FUND_DEFAULT;
  const level = levelOf(index);
  const coins = React.useRef<(HTMLButtonElement | null)[]>([]);

  /** The coin `i` steps from here, clamped to the row. */
  const pick = (i: number) => {
    const at = Math.min(COIN_COUNT - 1, Math.max(0, i));
    setIndex(at);
    return at;
  };

  return (
    <section className={cn(s.fund, "flex flex-col gap-4 p-4")} style={{ "--level": level } as React.CSSProperties}>
      <header className="flex flex-col gap-0.5">
        <h2 className="font-heading text-heading text-fg">Fund {product.name}</h2>
        <p className="text-body text-fg-muted">No ads, no investors. Just the people who use it.</p>
      </header>

      <div className="flex items-center gap-3">
        <WarmHeart level={level} className="size-11 shrink-0 text-fg-faint" />
        <div className="flex min-w-0 flex-col gap-1">
          <span className={cn(s.amount, "text-fg")} aria-live="polite">
            <span className="text-fg-faint">$</span>
            <span key={amount} className={s.tick}>
              {amount}
            </span>
          </span>
          <span className="text-meta text-fg-muted">{cadence === "monthly" ? "a month" : "once"}</span>
        </div>
        <Segmented
          className="ml-auto"
          aria-label="How often"
          value={cadence}
          onChange={setCadence}
          options={[
            { value: "once", label: "Once" },
            { value: "monthly", label: "Monthly" },
          ]}
        />
      </div>

      <div role="radiogroup" aria-label="Amount" className="grid grid-cols-5 gap-2.5 px-1 pt-3">
        {stops.map((v, i) => (
          <button
            key={i}
            ref={(el) => {
              coins.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={v === amount}
            tabIndex={v === amount ? 0 : -1}
            data-on={v === amount || undefined}
            className={cn(s.coin, "text-label")}
            onClick={() => setIndex(i)}
            onKeyDown={(e) => {
              const d = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
              if (!d) return;
              e.preventDefault();
              coins.current[pick(i + d)]?.focus();
            }}
          >
            <span>
              <span className={s.coinDollar}>$</span>
              {v}
            </span>
          </button>
        ))}
      </div>

      <div className="flex flex-col items-center gap-2 pt-1">
        <Button asChild className="w-full">
          <a href={sponsorTabUrl(support.githubSponsors, cadence === "monthly")} target="_blank" rel="noopener">
            Sponsor ${amount} {cadence === "monthly" ? "a month" : "once"}
          </a>
        </Button>
        {support.buyMeACoffee && (
          <a
            href={support.buyMeACoffee}
            target="_blank"
            rel="noopener"
            className="rounded-sm px-1 text-meta text-fg-muted underline-offset-4 hover:text-fg hover:underline"
          >
            or buy a coffee
          </a>
        )}
      </div>
    </section>
  );
}

function Spread({ support }: { support: Support }) {
  const gh = support.github;
  const count = useGithubCount(gh);
  const url = product.siteUrl;
  const text = support.shareText;
  const [copied, setCopied] = React.useState(false);
  React.useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1400);
    return () => clearTimeout(t);
  }, [copied]);

  const enc = encodeURIComponent;
  const shares = [
    { label: "Post on X", Mark: XMark, href: `https://x.com/intent/post?text=${enc(text)}&url=${enc(url)}` },
    { label: "Post on Bluesky", Mark: BlueskyMark, href: `https://bsky.app/intent/compose?text=${enc(`${text} ${url}`)}` },
    { label: "Share on LinkedIn", Mark: LinkedinMark, href: `https://www.linkedin.com/sharing/share-offsite/?url=${enc(url)}` },
  ];

  const tell = () => {
    if (typeof navigator.share === "function") {
      void navigator.share({ title: product.name, text, url }).catch(() => {});
      return;
    }
    window.location.href = `mailto:?subject=${enc(product.name)}&body=${enc(`${text}\n\n${url}`)}`;
  };

  const CountIcon = gh.kind === "repo" ? Star : Users;
  const tile = "group flex h-(--control-h-lg) min-w-0 items-center gap-2.5 rounded-md bg-input px-3 text-body text-fg transition-colors hover:bg-hover active:bg-pressed";
  return (
    <section className="flex flex-col gap-3 border-t border-line p-4">
      <header className="flex items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h2 className="text-label text-fg">Spread the word</h2>
          <p className="text-body text-fg-muted">Costs nothing. Counts for a lot.</p>
        </div>
        <div className="-mr-1.5 -mt-1 flex shrink-0 items-center">
          {shares.map(({ label, Mark, href }) => (
            <Button key={label} asChild variant="ghost" size="icon" aria-label={label} title={label}>
              <a href={href} target="_blank" rel="noopener">
                <Mark className="size-3.5" />
              </a>
            </Button>
          ))}
        </div>
      </header>

      <a href={githubUrl(gh)} target="_blank" rel="noopener" className={tile}>
        <GithubMark className="size-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{githubVerb(gh)}</span>
        {count !== null && (
          <span className="flex items-center gap-1 text-meta tabular-nums text-fg-muted group-hover:text-fg">
            <CountIcon className="size-3" />
            {shortCount(count)}
          </span>
        )}
      </a>

      <div className="grid grid-cols-2 gap-2">
        <button type="button" className={tile} onClick={() => void navigator.clipboard?.writeText(url).then(() => setCopied(true))}>
          {copied ? <Check className="size-3.5 shrink-0 text-success" /> : <Link2 className="size-3.5 shrink-0" />}
          <span className="truncate">{copied ? "Copied" : "Copy link"}</span>
        </button>
        <button type="button" className={tile} onClick={tell}>
          <Send className="size-3.5 shrink-0" />
          <span className="truncate">Tell a friend</span>
        </button>
      </div>
    </section>
  );
}
