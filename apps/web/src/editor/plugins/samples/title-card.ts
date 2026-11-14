"use client";

import { identity } from "@/editor/identity";
import { NAMES } from "@/editor/names";
import { strToU8 } from "fflate";
import { installPlugin, type InstallResult } from "../install";
import type { PluginBundleFiles } from "../plugin-model";

/**
 * A real, self-contained example plugin — the exact same shape a third party
 * would ship (manifest + ui.html + icon), materialized in code so "Install the
 * sample" exercises the whole sandbox path end-to-end. It's installed like any
 * other plugin, so it's removable and behaves identically to an uploaded zip.
 */

export const SAMPLE_PLUGIN_ID = NAMES.ids.samplePlugin;

const MANIFEST = JSON.stringify(
  {
    manifestVersion: 1,
    id: SAMPLE_PLUGIN_ID,
    name: "Title Card",
    version: "1.0.0",
    description: "Drop a styled title onto the canvas — a tiny example plugin.",
    author: { name: identity.name, url: identity.siteUrl },
    api: 1,
    main: "ui.html",
    icon: "icon.svg",
    capabilities: ["document:write", "selection:read", "ui:notify"],
    categories: ["Example"],
    window: { width: 320, height: 430 },
  },
  null,
  2,
);

const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="6" fill="#F5B843"/><path d="M6 7.5h12M12 7.5v9.5" stroke="#161310" stroke-width="2.4" stroke-linecap="round"/></svg>`;

const UI_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin:0; font:13px/1.45 -apple-system, system-ui, sans-serif; background:#151517; color:#e7e5e4; padding:14px; }
  h1 { font-size:13px; margin:0 0 2px; }
  p.sub { margin:0 0 8px; color:#a8a29e; font-size:11px; }
  label { display:block; font-size:11px; color:#a8a29e; margin:12px 0 4px; }
  input[type=text] { width:100%; padding:7px 9px; border-radius:7px; border:1px solid #2a2a2e; background:#1d1d20; color:inherit; font-size:13px; }
  input[type=range] { width:100%; accent-color:#F5B843; }
  button { width:100%; margin-top:16px; padding:9px; border:0; border-radius:8px; background:#F5B843; color:#161310; font-weight:600; font-size:13px; cursor:pointer; }
  button:active { transform: translateY(1px); }
  .sel { margin-top:14px; font-size:11px; color:#78716c; }
  .val { color:#e7e5e4; font-variant-numeric: tabular-nums; }
</style>
</head>
<body>
  <h1>Title Card</h1>
  <p class="sub">Adds a styled title to the active frame.</p>

  <label for="t">Title text</label>
  <input id="t" type="text" value="Everything moves" />

  <label for="s">Size <span class="val" id="sv">120</span></label>
  <input id="s" type="range" min="24" max="320" value="120" />

  <label for="c">Color</label>
  <input id="c" type="text" value="#F5B843" />

  <button id="go">Add title to canvas</button>
  <div class="sel" id="sel">Selection: —</div>

<script>
  var app = window["${NAMES.wire.pluginGlobal}"];
  function $(id) { return document.getElementById(id); }
  $("s").addEventListener("input", function () { $("sv").textContent = $("s").value; });

  $("go").addEventListener("click", async function () {
    var text = $("t").value.trim();
    if (!text) { await app.ui.notify("Type a title first", "warning"); return; }
    try {
      await app.document.insertText({ text: text, fontSize: Number($("s").value), color: $("c").value });
      await app.ui.notify("Title added \\u2713", "success");
    } catch (e) {
      await app.ui.notify(String((e && e.message) || e), "error");
    }
  });

  function renderSel(sel) {
    $("sel").textContent = "Selection: " + (sel.clipIds.length ? sel.clipIds.length + " layer(s)" : "nothing");
  }
  app.selection.get().then(renderSel).catch(function () {});
  app.on("selectionchange", renderSel);
</script>
</body>
</html>`;

export function sampleBundle(): PluginBundleFiles {
  return {
    [NAMES.files.pluginManifest]: strToU8(MANIFEST),
    "ui.html": strToU8(UI_HTML),
    "icon.svg": strToU8(ICON_SVG),
  };
}

export function installSamplePlugin(): Promise<InstallResult> {
  return installPlugin({ kind: "files", files: sampleBundle(), source: { kind: "sample" } });
}
