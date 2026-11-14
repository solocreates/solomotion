/**
 * The wire protocol between a sandboxed plugin (inside a null-origin iframe) and
 * the host editor. Every message is a plain, structured-clonable object tagged
 * with a `kind`. The protocol is versioned so the host can refuse a plugin built
 * against an incompatible major.
 *
 * Direction matters:
 *   plugin → host : `ready` (boot handshake) and `req` (a method call)
 *   host → plugin : `res` (reply to a `req`) and `evt` (a pushed event)
 *
 * Every kind is tagged `<ns>:<kind>` with the host's data namespace (the host
 * injects both halves from one build, so they always agree).
 *
 * The `nonce` is a per-instance secret the host injects at boot; the plugin
 * echoes it on every request so the host can prove the message came from the
 * iframe it created (paired with an `event.source` identity check host-side).
 */
export const PLUGIN_PROTOCOL_VERSION = 1;

/** plugin → host: sent once the client boots and `window.<ns>` is installed. */
export interface PluginReadyMessage {
  kind: `${string}:ready`;
  nonce: string;
}

/** plugin → host: a method call awaiting a response, correlated by `id`. */
export interface PluginRequestMessage {
  kind: `${string}:req`;
  nonce: string;
  id: number;
  method: string;
  params: unknown;
}

/** host → plugin: the reply to a request. */
export interface PluginResponseMessage {
  kind: `${string}:res`;
  id: number;
  ok: boolean;
  result?: unknown;
  error?: { message: string };
}

/** host → plugin: a pushed event (e.g. selection changed). */
export interface PluginEventMessage {
  kind: `${string}:evt`;
  event: string;
  payload: unknown;
}

/** Messages the host receives from a plugin. */
export type HostBoundMessage = PluginReadyMessage | PluginRequestMessage;

/** Messages a plugin receives from the host. */
export type PluginBoundMessage = PluginResponseMessage | PluginEventMessage;

export function isHostBoundMessage(value: unknown, ns: string): value is HostBoundMessage {
  if (!value || typeof value !== "object") return false;
  const kind = (value as { kind?: unknown }).kind;
  return kind === `${ns}:ready` || kind === `${ns}:req`;
}

/** A host-bound message that is a method call. */
export function isPluginRequest(msg: HostBoundMessage, ns: string): msg is PluginRequestMessage {
  return msg.kind === `${ns}:req`;
}
