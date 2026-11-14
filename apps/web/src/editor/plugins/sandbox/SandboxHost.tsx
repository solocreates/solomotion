"use client";

import { NAMES } from "@/editor/names";
import * as React from "react";
import {
  isHostBoundMessage,
  isPluginRequest,
  PLUGIN_PROTOCOL_VERSION,
  type Capability,
  type HostContext,
  type NotifyLevel,
} from "@solomotion/plugin-sdk";
import { toast } from "@/lib/toast";
import { useDocStore } from "../../state/document-context";
import { useSession } from "../../state/session";
import { buildSandboxHtml } from "../plugin-bundle";
import { useTheme } from "../../theme/use-theme";
import { hostThemeCss } from "./host-theme";
import type { InstalledPlugin } from "../plugin-model";
import { handlePluginCall, selectionInfoFrom, type SessionSnapshot } from "./bridge";

/**
 * Runs one sandboxed plugin. The plugin's assembled document loads into a
 * null-origin iframe (`sandbox="allow-scripts"` — no same-origin, no top nav, no
 * forms), so it can execute its own code but reach the editor ONLY through the
 * bridge. Every inbound message is checked twice: it must come from THIS iframe's
 * window and carry the per-instance nonce injected at boot. Selection events are
 * pushed only to plugins that asked for `selection:read`.
 */
export function SandboxHost({
  installed,
  granted,
  appVersion = process.env.NEXT_PUBLIC_APP_VERSION ?? "dev",
  onResize,
  onClose,
}: {
  installed: InstalledPlugin;
  granted: Capability[];
  appVersion?: string;
  onResize?: (width: number, height: number) => void;
  onClose?: () => void;
}) {
  const store = useDocStore();
  const iframeRef = React.useRef<HTMLIFrameElement>(null);

  // A fresh nonce per (re)load ties messages to exactly this iframe instance.
  const nonce = React.useMemo(
    () => (typeof crypto !== "undefined" ? crypto.randomUUID() : String(Math.random())),
    [installed.updatedAt, installed.manifest.id],
  );

  // A theme change reloads the plugin with the new look: the sandbox is a
  // null origin, so the host cannot restyle a running document, and theme
  // changes are rare, deliberate acts (a plugin already survives a reload).
  const theme = useTheme((s) => s.theme);
  const mode = useTheme((s) => s.activeMode);
  const html = React.useMemo(() => {
    const context: HostContext = {
      appVersion,
      apiVersion: PLUGIN_PROTOCOL_VERSION,
      plugin: { id: installed.manifest.id, name: installed.manifest.name, version: installed.manifest.version },
      capabilities: granted,
    };
    try {
      return buildSandboxHtml(
        installed.manifest,
        installed.files,
        { nonce, context, ns: NAMES.wire.pluginGlobal },
        hostThemeCss(theme, mode),
      );
    } catch (err) {
      return errorDocument((err as Error).message);
    }
  }, [installed, granted, appVersion, nonce, theme, mode]);

  const snapshot = React.useCallback((): SessionSnapshot => {
    const s = useSession.getState();
    return {
      activeFrameId: s.activeFrameId,
      selectedFrameIds: s.selectedFrameIds,
      selectedClipIds: s.selectedClipIds,
      playheadMs: s.playheadMs,
    };
  }, []);

  // Request/response bridge.
  React.useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const iframe = iframeRef.current;
      if (!iframe || event.source !== iframe.contentWindow) return;
      const msg = event.data;
      if (!isHostBoundMessage(msg, NAMES.wire.pluginGlobal) || msg.nonce !== nonce || !isPluginRequest(msg, NAMES.wire.pluginGlobal)) return;

      const reply = (payload: unknown) => iframe.contentWindow?.postMessage(payload, "*");
      void handlePluginCall(
        {
          store,
          getSession: snapshot,
          granted,
          notify,
          resize: (w, h) => onResize?.(w, h),
          close: () => onClose?.(),
        },
        msg.method,
        msg.params,
      ).then(
        (result) => reply({ kind: NAMES.wire.plugin("res"), id: msg.id, ok: true, result }),
        (err: Error) => reply({ kind: NAMES.wire.plugin("res"), id: msg.id, ok: false, error: { message: err.message } }),
      );
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [store, nonce, granted, snapshot, onResize, onClose]);

  // Push selection changes (only when the plugin was granted selection:read).
  React.useEffect(() => {
    if (!granted.includes("selection:read")) return;
    return useSession.subscribe((s, prev) => {
      if (
        s.selectedClipIds === prev.selectedClipIds &&
        s.selectedFrameIds === prev.selectedFrameIds &&
        s.activeFrameId === prev.activeFrameId
      ) {
        return;
      }
      iframeRef.current?.contentWindow?.postMessage(
        { kind: NAMES.wire.plugin("evt"), event: "selectionchange", payload: selectionInfoFrom(snapshot()) },
        "*",
      );
    });
  }, [granted, snapshot]);

  return (
    <iframe
      ref={iframeRef}
      title={installed.manifest.name}
      // No allow-same-origin on purpose: keeps the iframe at a null origin so it
      // can never reach into the host page.
      sandbox="allow-scripts allow-pointer-lock"
      srcDoc={html}
      // Transparent until the document paints its own ground (`--host-bg`),
      // and the same colour scheme, or the browser lays a white canvas under it.
      style={{ colorScheme: mode }}
      className="h-full w-full border-0 bg-transparent"
    />
  );
}

function notify(message: string, level?: NotifyLevel): void {
  const fn =
    level === "success" ? toast.success : level === "warning" ? toast.warning : level === "error" ? toast.error : toast.info;
  fn(message);
}

function errorDocument(message: string): string {
  const safe = message.replace(/[<&>]/g, (c) => ({ "<": "&lt;", "&": "&amp;", ">": "&gt;" })[c] ?? c);
  return `<!doctype html><meta charset="utf-8"><body style="margin:0;font:13px/1.5 system-ui;color:#b91c1c;background:#fff;padding:16px">
    <strong>This plugin couldn't load.</strong><p style="color:#57534e;white-space:pre-wrap">${safe}</p></body>`;
}
