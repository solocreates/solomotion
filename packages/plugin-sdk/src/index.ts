/**
 * @solomotion/plugin-sdk — the public contract shared by the editor (the host)
 * and every plugin. Plugin authors depend on this for the manifest schema and
 * the typed `window.<ns>` surface; the editor depends on it for validation
 * and the sandbox bridge. Keeping both sides in ONE package is what stops the
 * host and the client from ever drifting.
 */
export {
  CAPABILITIES,
  ALL_CAPABILITIES,
  isCapability,
  capabilityDescription,
  type Capability,
} from "./capabilities";

export {
  MANIFEST_VERSION,
  manifestFileName,
  isManifestFileName,
  PLUGIN_ID_RE,
  pluginManifestSchema,
  pluginAuthorSchema,
  pluginWindowSchema,
  parseManifest,
  type PluginManifest,
  type PluginAuthor,
  type PluginWindowSpec,
  type ManifestParseResult,
} from "./manifest";

export {
  PLUGIN_PROTOCOL_VERSION,
  isHostBoundMessage,
  isPluginRequest,
  type PluginReadyMessage,
  type PluginRequestMessage,
  type PluginResponseMessage,
  type PluginEventMessage,
  type HostBoundMessage,
  type PluginBoundMessage,
} from "./protocol";

export {
  METHOD_CAPABILITY,
  type PluginApi,
  type HostContext,
  type DocInfo,
  type SelectionInfo,
  type InsertTextParams,
  type InsertTextResult,
  type NotifyLevel,
  type PluginEventName,
} from "./api";

export { pluginClientBootstrap, type PluginBootstrapConfig } from "./client";
