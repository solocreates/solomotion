# @solomotion/plugin-sdk

Types and validation for [SoloMotion](https://github.com/novincode/solomotion)
plugins. The editor validates every plugin with this same package, so what
type-checks here is what the host accepts.

## Install

```bash
npm install --save-dev @solomotion/plugin-sdk
```

## Example

A plugin is a folder with a manifest and an HTML entry. It runs in a sandboxed
iframe and reaches the editor only through `window.solomotion`:

```ts
import type { PluginApi } from "@solomotion/plugin-sdk";

const app = (window as unknown as { solomotion: PluginApi }).solomotion;

document.querySelector("#title")!.addEventListener("click", async () => {
  const doc = await app.document.getInfo();
  await app.document.insertText({ text: doc.name, fontSize: 120 });
  await app.ui.notify("Added a title", "success");
});
app.on("selectionchange", (sel) => console.log(sel.clipIds));
```

## The manifest

`solomotion.plugin.json`, beside the entry:

```json
{
  "manifestVersion": 1,
  "id": "com.acme.confetti",
  "name": "Confetti",
  "version": "1.0.0",
  "author": { "name": "Acme" },
  "api": 1,
  "main": "ui.html",
  "capabilities": ["document:write", "ui:notify"],
  "window": { "width": 360, "height": 560 }
}
```

Check one before you ship it with `parseManifest(json)`. The `id` is
reverse-DNS and unique; `version` is semver, which is how the editor tells an
update from a new install.

## Capabilities

A plugin declares what it needs, and the host rejects any call outside it.

| Capability       | Grants                                  |
| ---------------- | --------------------------------------- |
| `document:read`  | Read frames, layers and properties.     |
| `document:write` | Create, edit and remove layers.         |
| `selection:read` | See and react to the current selection. |
| `ui:notify`      | Show messages in the editor.            |

New methods and capabilities are only ever added, so a plugin built for
`api: 1` keeps working.

## Theme

The plugin's page opens with the editor's theme as CSS variables
(`--host-bg`, `--host-fg`, `--host-accent`, `--host-radius`, `--host-font` and
more), so an unstyled plugin already looks at home. Your own CSS wins.

## Docs

[solomotion.app/docs](https://solomotion.app/docs)

## License

GPL-3.0-only
