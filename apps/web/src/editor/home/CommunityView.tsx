"use client";

import * as React from "react";
import { isHeavyItem, type LibraryItem } from "@solomotion/core";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { useDocStore } from "../state/document-context";
import { displayName, useProjectIndex } from "../state/project-index";
import {
  cloneCommunityItem,
  continueCopy,
  dismissAsk,
  loadCommunity,
  openCommunityItem,
  originOf,
  useCommunity,
  useCommunityItems,
} from "../library/community";

/**
 * Home › Community — Figma Community's grid: a picture, a name, who made it.
 *
 * Each card is ONE published still, lazily decoded. Hover never reads the
 * document — some are heavy simulations, and rendering one to animate a card
 * is the cost that makes Home feel slow. An item published with a video loop
 * plays THAT while the pointer rests (not when it is Heavy). Opening one is
 * the moment the project is downloaded.
 */
export function CommunityView({ limit }: { limit?: number } = {}) {
  const store = useDocStore();
  const { status, items: all } = useCommunityItems();
  const items = limit ? all.slice(0, limit) : all;
  const opening = useCommunity((s) => s.opening);

  if (status === "loading") {
    return (
      <Grid>
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="flex flex-col gap-2">
            <div className="aspect-video animate-pulse rounded-xl bg-muted/50" />
            <div className="h-3 w-1/2 animate-pulse rounded bg-muted/50" />
          </div>
        ))}
      </Grid>
    );
  }

  if (status === "offline" || !items.length) {
    return (
      <div className="flex flex-col items-center gap-3 py-24 text-sm text-muted-foreground">
        {status === "offline" ? "Community is unavailable offline." : "Nothing here yet."}
        {status === "offline" && (
          <Button variant="secondary" size="sm" onClick={() => void loadCommunity(true)}>
            Try again
          </Button>
        )}
      </div>
    );
  }

  return (
    <Grid>
      {items.map((item) => (
        <CommunityCard
          key={item.id}
          item={item}
          busy={opening === item.id}
          onOpen={() => openCommunityItem(store, item)}
        />
      ))}
    </Grid>
  );
}

function Grid({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid gap-x-5 gap-y-7" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))" }}>
      {children}
    </div>
  );
}

/** Rest this long before a card's loop loads — a sweep across the grid plays nothing. */
const HOVER_INTENT_MS = 220;

function CommunityCard({ item, busy, onOpen }: { item: LibraryItem; busy: boolean; onOpen: () => void }) {
  const p = item.preview;
  // The still is the image, or the video's poster: a card at rest costs a picture.
  const still = p.type === "image" ? { url: p.url, width: p.width, height: p.height } : p.type === "video" && p.posterUrl ? { url: p.posterUrl, width: p.width, height: p.height } : null;
  // A published loop plays while the pointer rests — a <video>, never the
  // document, so it costs a decoder, not a render. Heavy items stay still,
  // as everywhere the Heavy tag shows.
  const loop = p.type === "video" && !isHeavyItem(item) ? p.url : null;
  const [playing, setPlaying] = React.useState(false);
  const intent = React.useRef<number | undefined>(undefined);
  const hoverStart = () => {
    if (!loop) return;
    window.clearTimeout(intent.current);
    intent.current = window.setTimeout(() => setPlaying(true), HOVER_INTENT_MS);
  };
  const hoverEnd = () => {
    window.clearTimeout(intent.current);
    setPlaying(false);
  };
  React.useEffect(() => () => window.clearTimeout(intent.current), []);
  // A small mark, not a badge: you have a copy of THIS version.
  const owned = useProjectIndex((s) => {
    const o = originOf(item);
    return !!o && Object.values(s.records).some((m) => m.origin?.itemId === o.itemId && m.origin.version === o.version);
  });

  return (
    <button
      type="button"
      data-no-marquee
      onClick={onOpen}
      onPointerEnter={hoverStart}
      onPointerLeave={hoverEnd}
      onFocus={hoverStart}
      onBlur={hoverEnd}
      disabled={busy}
      title={item.blurb ?? item.name}
      className="group flex flex-col gap-2.5 text-left outline-none"
    >
      <div className="relative aspect-video w-full overflow-hidden rounded-xl bg-stage/60 ring-1 ring-border/60 transition-[box-shadow,transform] duration-200 group-hover:shadow-elevation-2 group-hover:ring-border group-focus-visible:ring-2 group-focus-visible:ring-primary/70">
        {still && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={still.url}
            alt=""
            width={still.width}
            height={still.height}
            loading="lazy"
            decoding="async"
            draggable={false}
            className="size-full object-cover transition-transform duration-300 ease-out group-hover:scale-[1.03]"
          />
        )}
        {loop && playing && (
          <video
            src={loop}
            muted
            loop
            autoPlay
            playsInline
            preload="auto"
            aria-hidden
            className="absolute inset-0 size-full scale-[1.03] object-cover"
          />
        )}
        {busy && (
          <div className="absolute inset-0 flex items-center justify-center bg-background/55 backdrop-blur-[2px]">
            <Loader2 className="size-5 animate-spin" />
          </div>
        )}
      </div>
      <div className="flex min-w-0 items-baseline gap-2 px-0.5">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{item.name}</div>
          {item.publisher && <div className="truncate text-xs text-muted-foreground">{item.publisher.name}</div>}
        </div>
        {owned && <span className="shrink-0 text-xs text-muted-foreground">In your projects</span>}
      </div>
    </button>
  );
}

/**
 * "You already have this one." Mounted at app scope, because the Library panel
 * opens community projects too and the question is the same from anywhere.
 */
export function CommunityOpenDialog() {
  const store = useDocStore();
  const asking = useCommunity((s) => s.asking);
  const name = useProjectIndex((s) => (asking ? (s.residentId === asking.copy.id ? s.residentName : s.records[asking.copy.id]?.name) : null));

  return (
    <Dialog open={asking !== null} onOpenChange={(o) => !o && dismissAsk()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Continue your copy?</DialogTitle>
          <DialogDescription>
            {asking && asking.copies > 1
              ? `You have ${asking.copies} copies of “${asking.item.name}”. The latest is “${displayName(name)}”.`
              : `You already started “${displayName(name)}”. Pick it up, or start fresh from the original.`}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className={cn("gap-2")}>
          <Button variant="secondary" onClick={() => asking && void cloneCommunityItem(store, asking.item)}>
            New copy
          </Button>
          <Button autoFocus onClick={() => asking && continueCopy(asking.copy.id)}>
            Open my copy
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
