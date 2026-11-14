/**
 * WHICH PRODUCTS SEE A LIBRARY ITEM.
 *
 * One library serves every product on this engine (one bucket, under each
 * product's own host), so its catalogue is data they all read. Most of it is
 * for everyone: a sound is a sound. Some of it is one product's own — its
 * brand kit, a pack it signs — and only the data can say so, because no reader
 * should know any product by name.
 *
 * A scope is a list of product namespaces (`identity.ns`), or `null` for every
 * product. It is written per pack and per file in `pack.json` (a file's own
 * scope wins over its pack's), carried onto every manifest entry by the build,
 * and the index row of a pack is the union of its entries' (null as soon as
 * one entry is for everyone, or it has none). The client hides what is not for its product.
 */
export type ProductScope = readonly string[] | null;

/** A product namespace as a scope names it: lowercase letters and digits. */
export const PRODUCT_NS_PATTERN = /^[a-z][a-z0-9]*$/;

/**
 * A scope as written by hand (`pack.json`), checked: absent or null is every
 * product; otherwise a non-empty list of namespaces. Throws on anything else,
 * so a typo fails the build instead of hiding an item from everyone. The
 * manifest schema holds the same rule for what the client reads.
 */
export function parseProductScope(value: unknown, where: string): ProductScope {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.length === 0 || !value.every((v) => typeof v === "string" && PRODUCT_NS_PATTERN.test(v))) {
    throw new Error(`${where}: "products" must be a non-empty list of product namespaces, got ${JSON.stringify(value)}`);
  }
  return [...value];
}

/** Is an item with this scope for the product with namespace `ns`? */
export function availableTo(scope: ProductScope | undefined, ns: string): boolean {
  return !scope || scope.includes(ns);
}

/** An entry's scope: its file's own, else its pack's, else everyone. */
export function entryScope(fileScope: ProductScope | undefined, packScope: ProductScope | undefined): ProductScope {
  return fileScope ?? packScope ?? null;
}

/** A pack row's scope in the index: every product any of its entries is for. */
export function packScope(entries: readonly { products?: ProductScope }[]): ProductScope {
  const all = new Set<string>();
  for (const e of entries) {
    if (!e.products) return null;
    for (const p of e.products) all.add(p);
  }
  // An empty pack hides nothing; a scope is never an empty list.
  return all.size ? [...all].sort() : null;
}
