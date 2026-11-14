/**
 * @solomotion/platform — the headless bridge between the app and its host.
 *
 * App code imports ONLY from here. It never imports a host SDK directly and
 * never sniffs the environment: it calls `platform.*` and reads the log bus. A
 * new host (a native adapter, React Native, an extension) is a new adapter
 * behind this same surface — nothing downstream changes.
 */

export { createPlatform, initPlatform, type Platform } from "./platform";
export type { HostIdentity } from "./host";
export { isDesktop, platformKind, osKind, isBrowser, type PlatformKind, type OsKind } from "./env";
export type {
  AppFile,
  ClipboardPort,
  DirectoryRef,
  FileFilter,
  FolderPort,
  FolderScanFile,
  LogLevel,
  MenuPort,
  MenuTemplateNode,
  PlatformAdapter,
  SystemFont,
  UpdateManifest,
  UpdateApplyKind,
  UpdatePort,
} from "./ports";

// Console / log bus — the headless engine behind the in-app Console panel.
export {
  subscribe as subscribeLog,
  getEntries as getLogEntries,
  clearLog,
  pushLog,
  installConsoleCapture,
  setErrorSink,
  type LogEntry,
} from "./log/bus";
