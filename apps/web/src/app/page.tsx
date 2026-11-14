// The editor itself is mounted once in the root layout (see layout.tsx) so it
// survives navigation between "/" and "/project/[id]" — these route segments
// only exist to give the URL a shape; use-url-sync.ts reads the [id] param
// and drives the already-mounted editor.
export default function Page() {
  return null;
}
