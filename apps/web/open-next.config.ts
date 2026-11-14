import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// The editor's Worker (each product's config: products/<id>/deploy). Kept minimal on purpose — the editor is a client
// app (local IndexedDB projects, no server data), so there's nothing to cache at
// the edge beyond Next's own static assets, which the ASSETS binding serves.
export default defineCloudflareConfig({});
