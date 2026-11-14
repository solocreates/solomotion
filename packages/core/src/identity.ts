/**
 * WHO WROTE IT — the little the engine needs to know about the product it runs
 * in. One engine serves several products, and some ids that land in files and
 * on the clipboard carry the writer's name: a `.motion` manifest's `format`,
 * a frame's origin stamp, a packed sequence's mime, a preset or variables
 * file's kind. Those ids are VENDOR-STAMPED:
 *
 *   • WRITTEN with the product's namespace (`<ns>-motion`, `<ns>.origin`), so
 *     a product's output is exactly what it always wrote;
 *   • READ by their SHAPE, for any namespace, so every product on this engine
 *     opens every other's files with no migration and no list of names.
 *
 * Nothing here is global: a writer takes the identity as a parameter, and a
 * command gets it from `createCommandApi(identity)`.
 */
export interface EngineIdentity {
  /** The product's name, where the engine signs its own output (a bug report, a file's writer). */
  name: string;
  /** The data namespace: lowercase letters and digits ("solomotion"). */
  ns: string;
  /** Where the web app lives — the origin a copied link and a PDF's fallback use. */
  webOrigin: string;
  /** The desktop link scheme, with its colon: `<ns>:`. */
  scheme: string;
}

/** What a namespace may be. */
export const NAMESPACE_PATTERN = "[a-z][a-z0-9]*";
const NAMESPACE = new RegExp(`^${NAMESPACE_PATTERN}$`);

/** An identity from its parts; the scheme is always derived from the namespace. */
export function engineIdentity(parts: { name: string; ns: string; webOrigin: string }): EngineIdentity {
  const { name, ns, webOrigin } = parts;
  if (!NAMESPACE.test(ns)) throw new Error(`"${ns}" is not a namespace (lowercase letters and digits).`);
  return { name, ns, webOrigin, scheme: `${ns}:` };
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/** `<prefix><ns><sep><name>` written by `ns`; `matches` reads it for any namespace. */
export function stampedId(prefix: string, sep: string, name: string) {
  const re = new RegExp(`^${escape(prefix)}${NAMESPACE_PATTERN}${escape(sep)}${escape(name)}$`);
  return {
    of: (ns: string) => `${prefix}${ns}${sep}${name}`,
    matches: (id: unknown): id is string => typeof id === "string" && re.test(id),
  };
}
