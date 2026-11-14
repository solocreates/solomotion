/**
 * THE RUNTIME — the app's answer to "the page stopped responding".
 *
 * Read `supervisor.ts` first: it is the concept, and the other five files are
 * its parts. `chunk.ts` is the one that does the actual saving.
 */
export { now as runtimeNow, setRuntimeClock } from "./clock";
export {
  backgroundWaitMs,
  createBackgroundLane,
  DEFAULT_BACKGROUND_GATE,
  type BackgroundClock,
  type BackgroundGate,
  type BackgroundLane,
  type BackgroundLaneOptions,
} from "./background";
export {
  TaskAborted,
  TaskSignal,
  isTaskAborted,
  type AbortReason,
  type TaskProgress,
} from "./signal";
export {
  isIterator,
  runChunked,
  setYieldStrategy,
  yieldNow,
  type ChunkOptions,
  type ChunkStep,
  type TaskBody,
} from "./chunk";
export {
  LIMIT_DEFAULT,
  LIMIT_UNLIMITED,
  UNKNOWN_KIND,
  fixedLimit,
  registerTaskKind,
  taskKind,
  taskKinds,
  type ExpiryAction,
  type TaskKindDef,
  type TaskLimit,
} from "./kinds";
export {
  DEFAULT_RUNTIME_CONFIG,
  effectiveLimit,
  resolveLimitMs,
  type RuntimeConfig,
} from "./config";
export {
  supervise,
  superviseSync,
  supervisor,
  type TaskRecord,
  type TaskSpec,
  type TaskState,
} from "./supervisor";
export {
  DEFAULT_LOOP_LIMIT,
  RuntimeLoopError,
  isRuntimeLoopError,
  loopGuard,
} from "./guard";
export {
  EngineError,
  DocumentError,
  ExportError,
  MediaError,
  PluginError,
  RenderError,
  StorageError,
  UnknownError,
  isEngineError,
  normalizeError,
  type EngineErrorInit,
  type ErrorContext,
  type ErrorPayload,
  type ErrorSeverity,
} from "./errors";
export {
  buildBugReport,
  errorPayloads,
  errors,
  reportError,
  tryOrReport,
  type BugReportInput,
  type ErrorReport,
} from "./report";
export {
  currentSubject,
  entityRef,
  popSubject,
  pushSubject,
  resetSubjects,
  subjectLabel,
  subjectPath,
  withSubject,
  type EntityRef,
  type SubjectKind,
} from "./subject";
export {
  Watchdog,
  diagnoseBlackBox,
  snapshotBlackBox,
  watchdog,
  type BlackBox,
  type FreezeRecord,
} from "./watchdog";
export { createJobQueue, isJobFinished, type JobBody, type JobQueue, type JobSpec, type JobState, type JobView, type JobWaitOptions } from "./jobs";
export { FAILURE_META, classifyFailure, currentlyOnline, setOnlineProbe, type FailureKind } from "./failure";
export * from "./semver";
