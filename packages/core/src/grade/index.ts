// COLOUR GRADING (v77) — the headless brain behind the Color page.
//
// Schema lives in ../schema/grade; this module is the engine: the graph→plan
// compiler the renderer executes, the per-pixel matte maths, the window
// resolver that joins grades to trackers, the scopes, and the document ops. No
// DOM anywhere — the stage, the exporter and a test compile identical plans.
export * from "./plan";
export * from "./key";
export * from "./windows";
export * from "./scopes";
export * from "./ops";
export * from "./paths";
export * from "./filter-ops";
