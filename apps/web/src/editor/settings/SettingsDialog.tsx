"use client";

import { product } from "@/editor/product";
import * as React from "react";
import { Bot, ChevronLeft, ChevronRight, Gauge, Info, Keyboard, MousePointer2, Palette, Search, Clapperboard, X } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { useSession } from "../state/session";
import { useTypeToFocus } from "../input/use-type-to-focus";
import { SettingsNavContext, type SettingsNav } from "./kit";
import { AboutPage, AgentsPage, AppearancePage, CanvasPage, InputPage, PerformancePage, TimelinePage } from "./pages";

/**
 * SETTINGS — rebuilt, not restyled (v5 redesign, D14).
 *
 * Why people open it, by frequency: make the app bigger or smaller · switch
 * theme · change a shortcut · (rarely) touch, limits, account. So Appearance
 * is the first page and Interface size its first row; the rest are pages in
 * a vertical nav, each leading with what is used and demoting the rest
 * behind a "▸" disclosure. Search filters rows across every page. On a narrow
 * dialog the nav is a list and a page is a drill-in with a back button. The
 * version lives on About and nowhere else.
 */

const PAGES = [
  { id: "appearance", label: "Appearance", icon: Palette, Page: AppearancePage },
  { id: "canvas", label: "Canvas", icon: MousePointer2, Page: CanvasPage },
  { id: "timeline", label: "Timeline & playback", icon: Clapperboard, Page: TimelinePage },
  { id: "input", label: "Input", icon: Keyboard, Page: InputPage },
  { id: "agents", label: "Agents & AI", icon: Bot, Page: AgentsPage },
  { id: "performance", label: "Performance", icon: Gauge, Page: PerformancePage },
  // The product's own pages (a paid product: Account & plan).
  ...product.settingsPages,
  { id: "about", label: "About", icon: Info, Page: AboutPage },
];
type PageId = string;

/** Old tab ids (callers still use them) → the page that holds those rows now. */
const LEGACY: Record<string, PageId> = {
  general: "canvas",
  editing: "canvas",
  touch: "input",
  shortcuts: "input",
  safety: "performance",
};

export function SettingsDialog() {
  const open = useSession((s) => s.settingsDialogOpen);
  const requested = useSession((s) => s.settingsTab);
  const [page, setPage] = React.useState<PageId>("appearance");
  // Compact only: null = the page list is showing.
  const [drilled, setDrilled] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [highlight, setHighlight] = React.useState<string | null>(null);
  const searchRef = React.useRef<HTMLInputElement>(null);

  // A requested page wins once, on open, and is then forgotten.
  React.useEffect(() => {
    if (open && requested) {
      const id = (LEGACY[requested] ?? requested) as PageId;
      if (PAGES.some((p) => p.id === id)) {
        setPage(id);
        setDrilled(true);
      }
      useSession.setState({ settingsTab: null });
    }
    if (!open) setQuery("");
  }, [open, requested]);

  React.useEffect(() => {
    if (!highlight) return;
    const t = window.setTimeout(() => setHighlight(null), 1400);
    return () => window.clearTimeout(t);
  }, [highlight]);

  const nav: SettingsNav = {
    query,
    page: "",
    highlight,
    jump: (to, label) => {
      setQuery("");
      setPage(to as PageId);
      setDrilled(true);
      setHighlight(`${to}/${label}`);
    },
  };
  const searching = query.trim() !== "";
  const current = PAGES.find((p) => p.id === page) ?? PAGES[0]!;

  return (
    <Dialog open={open} onOpenChange={(v) => useSession.getState().setSettingsDialogOpen(v)}>
      <DialogContent
        // `@container`: the dialog, not the viewport, decides when it is
        // compact — it is the dialog that gets narrow.
        className="@container flex h-[min(42rem,88dvh)] w-[min(56rem,calc(100vw-2rem))] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none"
        showCloseButton={false}
      >
        <DialogTitle className="sr-only">Settings</DialogTitle>
        <DialogDescription className="sr-only">App preferences</DialogDescription>
        <SettingsNavContext.Provider value={nav}>
          <div className="flex min-h-0 flex-1">
            {/* NAV — always on wide; on compact, only until a page is opened. */}
            <aside
              className={cn(
                "flex min-h-0 w-full flex-col gap-1 border-line bg-panel p-3 @[40rem]:w-56 @[40rem]:shrink-0 @[40rem]:border-r",
                drilled && !searching && "hidden @[40rem]:flex",
              )}
            >
              <div className="flex h-(--control-h-lg) items-center justify-between px-1 pb-1">
                <h2 className="text-heading text-fg">Settings</h2>
                <CloseButton className="@[40rem]:hidden" />
              </div>
              <SearchField inputRef={searchRef} query={query} setQuery={setQuery} />
              <nav className="mt-2 flex flex-col gap-0.5">
                {PAGES.map((p) => {
                  const active = p.id === page && !searching;
                  return (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => {
                        setQuery("");
                        setPage(p.id);
                        setDrilled(true);
                      }}
                      className={cn(
                        "flex h-8 items-center gap-2 rounded-md px-2 text-left text-body transition-colors",
                        active ? "@[40rem]:bg-selection @[40rem]:text-selection-fg" : "text-fg hover:bg-hover",
                      )}
                    >
                      <p.icon className="size-4 shrink-0" />
                      <span className="min-w-0 flex-1 truncate">{p.label}</span>
                      <ChevronRight className="size-3.5 text-fg-faint @[40rem]:hidden" />
                    </button>
                  );
                })}
              </nav>
            </aside>

            {/* PAGE */}
            <div className={cn("flex min-w-0 flex-1 flex-col", !drilled && !searching && "hidden @[40rem]:flex")}>
              <header className="flex h-14 shrink-0 items-center gap-1 px-6 @max-[40rem]:px-3">
                {!searching && (
                  <button
                    type="button"
                    aria-label="All settings"
                    onClick={() => setDrilled(false)}
                    className="-ml-1 flex size-(--control-h) items-center justify-center rounded-md text-fg-muted hover:bg-hover hover:text-fg @[40rem]:hidden"
                  >
                    <ChevronLeft className="size-4" />
                  </button>
                )}
                <h3 className="min-w-0 flex-1 truncate text-heading text-fg">{searching ? `Results for “${query.trim()}”` : current.label}</h3>
                <CloseButton className="@max-[40rem]:hidden" />
              </header>
              <ScrollArea className="min-h-0 flex-1" viewportClassName="px-6 pb-8 @max-[40rem]:px-3">
                {searching ? (
                  <div className="flex flex-col gap-8 [&:not(:has([data-setting-row]))]:after:block [&:not(:has([data-setting-row]))]:after:py-12 [&:not(:has([data-setting-row]))]:after:text-center [&:not(:has([data-setting-row]))]:after:text-body [&:not(:has([data-setting-row]))]:after:text-fg-faint [&:not(:has([data-setting-row]))]:after:content-['No_settings_match']">
                    {PAGES.map(({ id, Page }) => (
                      <Page key={id} />
                    ))}
                  </div>
                ) : (
                  <current.Page />
                )}
              </ScrollArea>
            </div>
          </div>
        </SettingsNavContext.Provider>
      </DialogContent>
    </Dialog>
  );
}

function SearchField({
  inputRef,
  query,
  setQuery,
}: {
  inputRef: React.RefObject<HTMLInputElement | null>;
  query: string;
  setQuery: (q: string) => void;
}) {
  useTypeToFocus(inputRef);
  return (
    <label className="flex h-(--control-h) items-center gap-1.5 rounded-md bg-raised px-2 text-fg-muted focus-within:text-fg">
      <Search className="size-3.5 shrink-0" />
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && query) {
            e.preventDefault();
            e.stopPropagation();
            setQuery("");
          }
        }}
        placeholder="Search settings"
        aria-label="Search settings"
        className="min-w-0 flex-1 bg-transparent text-body text-fg outline-none placeholder:text-fg-faint"
      />
    </label>
  );
}

function CloseButton({ className }: { className?: string }) {
  return (
    <button
      type="button"
      aria-label="Close settings"
      onClick={() => useSession.getState().setSettingsDialogOpen(false)}
      className={cn("flex size-(--control-h) items-center justify-center rounded-md text-fg-muted hover:bg-hover hover:text-fg [&_svg]:size-4", className)}
    >
      <X />
    </button>
  );
}
