// @solomotion/agent — a provider-agnostic agent runtime. No React, no DOM beyond
// `fetch`, and nothing product-specific: the editor hands it tools, knowledge
// and a connection; it hands back a stream of events and a transcript.
export * from "./types";
export * from "./providers";
export * from "./retry";
export * from "./runtime";
export * from "./subagents";
export * from "./knowledge";
export * from "./generation";
export type { TurnEvent, TurnRequest, TurnResult, StopReason } from "./dialects/dialect";
export * from "./feedback";
export * from "./test-connection";
export { scriptedDialect, type ScriptedTurn } from "./dialects/scripted";
export type { DialectAdapter } from "./dialects/dialect";
