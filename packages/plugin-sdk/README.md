# @solomotion/plugin-sdk

The shared contract between the **editor** (the host) and **plugins**.
One package, edited on both sides at once, so the sandbox client and the host
bridge can never drift.

## What a plugin is

A plugin is a small bundle — an HTML entry plus its assets and an
`<ns>.plugin.json` manifest, where `<ns>` is the host product's namespace
(`solomotion` in SoloMotion; a host reads any product's manifest). It runs
inside a **null-origin sandboxed iframe** and talks to the editor only through
`window.<ns>` (typed by
[`PluginApi`](./src/api.ts)). It cannot touch the document directly; every call
is a `postMessage` the host validates against the plugin's declared
**capabilities**.

```
my-plugin/
├─ solomotion.plugin.json   # manifest (identity, permissions, window)
├─ ui.html               # the entry — your plugin's UI
├─ main.js               # your code (optional; can be inline in ui.html)
└─ icon.svg              # avatar (optional)
```

## Manifest

```jsonc
{
  "manifestVersion": 1,
  "id": "com.acme.confetti",     // reverse-DNS; the UNIQUENESS key
  "name": "Confetti",
  "version": "1.0.0",            // semver — how updates are detected
  "description": "Rain text confetti onto the canvas.",
  "author": { "name": "Acme", "url": "https://acme.dev" },
  "api": 1,                       // protocol major you target
  "main": "ui.html",
  "icon": "icon.svg",
  "capabilities": ["document:write", "selection:read", "ui:notify"],
  "window": { "width": 360, "height": 560, "resizable": true },
  "categories": ["Utility"]
}
```

Validate one with `parseManifest(json)`.

## The API

Inside `ui.html`, the host's API is ready to use (`window.solomotion` in SoloMotion):

```html
<button id="go">Add title</button>
<script>
  const app = window.solomotion;
  document.getElementById("go").onclick = async () => {
    const info = await app.document.getInfo();
    await app.document.insertText({ text: info.name, fontSize: 120 });
    await app.ui.notify("Added a title layer", "success");
  };
  app.on("selectionchange", (sel) => console.log("selection", sel));
</script>
```

Every method maps to a capability (see [`METHOD_CAPABILITY`](./src/api.ts));
calling one you didn't declare is rejected. The vocabulary grows additively — new
methods and capabilities never break older plugins.

## Capabilities

| Capability        | Grants                                            |
| ----------------- | ------------------------------------------------- |
| `document:read`   | Read frames, layers and properties.               |
| `document:write`  | Create, edit and remove layers.                   |
| `selection:read`  | See and react to the current selection.           |
| `ui:notify`       | Show toast messages in the editor.                |

## Installing

- **Anyone** can install a plugin from a `.zip` of the bundle — Editor →
  Plugins → Install.
- **Developers** can point the editor at the plugin's folder (Chromium) for
  live reload while iterating — see the docs on the website.
