# Links

Any visible layer, a whole text, or a run of text can be a link. A click goes
to a URL, a place in this project, or somewhere else in the app.

## Targets (`link_set {id, target, start?, end?, atMs?, open?}`)

| Write | Goes to |
| --- | --- |
| `https://site.com`, `site.com`, `hi@example.com`, `+1 555 0100` | the web, an email, a phone call |
| `frame:<id>` or `frame:Hero` (a unique name works) | a frame — also a 3D world, a component, a nested comp |
| `clip:<id>` / `clip:Title` | a layer: its comp opens with it selected |
| `page:<id>` | a page |
| `atMs` with a frame/layer target | that time on the target comp's clock |
| `/plugin/icons?q=arrow` | a plugin's window, opened with its params |
| `/project/<id>?at=frame:<id>` | another project |

- `start`/`end` (grapheme indices, end exclusive) link a run; omit them for the whole layer. A run's link wins over its layer's; a member of a linked group is reached through the group.
- `open`: `auto` (default — web links open a new tab, in-project ones open here), `here`, `new`.
- Unsafe schemes (`javascript:`, `data:`) are refused.
- Linking never restyles text. If the design wants an underline, set `decoration: "underline"` on that run with `text_style`.

## Working with links

- Targets are ids, so renaming never breaks a link. Deleting a target keeps the link and marks it broken: run `link_list {broken: true}` after deleting frames and fix or `link_remove` what it finds.
- `link_follow {id, at?}` tells you where a click lands (the URL, or the node key and time) without moving the user's view.
- In the editor, ⌘-click follows a link while editing; with the Hand tool a plain click follows.

## Decks and documents

- A table of contents is a column of text layers, each linked to its frame (`frame:<id>`). A "back to contents" button on every slide links to the contents frame.
- PDF export keeps every link: URLs stay URLs, links to frames in the PDF jump to their page, links to places outside the PDF open the web app. Every exported frame becomes a bookmark under its frame name, so name frames the way the outline should read.
