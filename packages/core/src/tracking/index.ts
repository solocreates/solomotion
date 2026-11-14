// Tracking (v39, rebuilt v77, re-founded v101) — what footage knows, headless.
// Schema in ../schema/tracking; this module is the brains: pose maths (a full
// homography in pinnable channels), the contour both trackers and grade windows
// read, where the footage is in a comp, THE reader and its readings table, the
// follow bake, the anchored solve plan, engines, and the document ops. No DOM —
// the host decodes frames. See docs/adr/ADR-tracking.md.
export * from "./pose";
export * from "./engine";
export * from "./contour";
export * from "./solve";
export * from "./samples";
export * from "./footage";
export * from "./read";
export * from "./follow";
export * from "./ops";
export * from "./palette";
export * from "./run";
export * from "./usage";
export * from "./strip";
export { makeTrackApi, trackerIdFor, trackReference, trackReadingSource, linkPropertyToTrack } from "./expressions";
export { trackReadingPickKey } from "./pick";
export type { Stepper, StepResult } from "./steppers";
export { runAnalysisJob, jobWantsColor, type AnalysisJob, type AnalysisOutcome, type AnalysisProgress } from "./analysis";
export {
  cameraPoseAt,
  cameraReadout,
  cameraSceneOf,
  defaultCameraScene,
  cameraPointsInWorld,
  cameraPlatePoints,
  projectToPlate,
  sceneToWorld,
  type CameraReadout,
  type CameraPose,
} from "./camera/read-camera";
export { solveCamera, focalFromFov, SENSOR_MM, SolveError, type TrackSet, type FeatureTrack, type SolveOptions } from "./camera/solve";
export { followFeatures } from "./camera/features";
export { runCameraSolve, toDocument as cameraSolutionToDocument, type CameraRunResult } from "./camera/run-camera";
export { createCameraTracker, commitCameraSolve, setCameraSolve, setCameraGround, setCameraOrigin, setCameraScale, resetCameraScene } from "./camera/ops-camera";
export { makeCameraScene, placeTextOnSolvedPoints, catchShadowsOnGround, worldsFollowing, solvedPointsNear, type CameraSceneIds } from "./camera/scene";
export { installDepthReader, noteDepthChanged, depthGeneration, readDepthFrame, nearnessAt, depthRamp, depthTrackerFor, depthForClip, type DepthFrame, type DepthReader } from "./depth/frame";
export { createDepthTracker, commitDepthRun, setDepthSolve } from "./depth/ops-depth";
export { runDepth, toTensor, mapSize, depthModelFor, type DepthEngine, type DepthRunResult } from "./depth/run-depth";
