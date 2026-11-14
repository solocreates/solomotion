/**
 * @solomotion/core — the library.
 *
 * One concept covering everything browsable: built-in presets, saved
 * components, this project's media and sounds, and the online catalogue served
 * from object storage. See `item.ts` for the model and why it is shaped this
 * way; `manifest.ts` for the wire format; `catalog.ts` for the local half and
 * `client.ts` for the remote one.
 */
export * from "./snapshot";
export * from "./item";
export * from "./manifest";
export * from "./scope";
export * from "./query";
export * from "./catalog";
export * from "./client";
export * from "./merge";
export * from "./publish";
export * from "./focus";
export * from "./usage";
export * from "./marks";
export * from "./template";
