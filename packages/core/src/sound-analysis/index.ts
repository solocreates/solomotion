/**
 * SOUND ANALYSIS IN THE DOCUMENT — what a recording is made of (loudness,
 * bands, brightness, hits, beat, tempo, waveform), derived once per asset and
 * read by anything: expressions (`sound()`), the Sound node, the waveform
 * visualizer and the agent API. Analyses arrive through an installed reader;
 * the expression functions register on import.
 */
import "./functions";

export * from "./types";
export * from "./analyze";
export * from "./query";
export * from "./visualizer";
export * from "./reader";
