// See apps/web/src/app/page.tsx — the editor lives in the root layout, not
// here; this segment only gives a project its own shareable/refreshable URL —
// and, through the optional catch-all, every place IN it: the page slug after
// the id (`/project/<id>/intro?at=frame:<id>`; ADR-links). The rest of the
// path is cosmetic; `use-url-sync` reads the location from `window.location`.
//
// The static export (desktop build) needs a non-empty `generateStaticParams`
// for this dynamic segment — an empty set counts as "missing" and fails the
// export. Project ids are runtime-generated so we can't enumerate them; we emit
// one throwaway placeholder page purely to satisfy the exporter. It's never
// used: the desktop app has no address bar, so use-url-sync skips URL
// reflection there (the store is the single source of truth for which project
// is open), and nothing else links to /project/*. On the hosted web server
// `dynamicParams` still defaults to true, so real /project/<id> URLs render on
// demand as before.
export function generateStaticParams() {
  return [{ id: "index", rest: [] }];
}

export default function Page() {
  return null;
}
