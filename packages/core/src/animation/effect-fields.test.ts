import { describe, expect, it } from "vitest";
import { LFX } from "./layer-effects";
import { AFX } from "../audio/effects/registry";
import { propertyDef } from "./properties";

/**
 * `lfx.<id>.<field>` is resolved by field NAME — the path carries the instance
 * id, not its type. So one name must mean one kind across a whole domain, or
 * the registry refuses it for every card. Stroke once reused Shine's
 * `position` and nobody could key a shine's position for a release.
 */
describe("effect field names are never contested", () => {
  for (const [name, registry] of [["lfx", LFX], ["afx", AFX]] as const) {
    it(`${name}: one kind per field name`, () => {
      const kinds = new Map<string, Set<string>>();
      for (const t of registry.types) {
        for (const f of t.fields) kinds.set(f.key, (kinds.get(f.key) ?? new Set()).add(f.kind));
      }
      const contested = [...kinds].filter(([, k]) => k.size > 1).map(([key]) => key);
      expect(contested).toEqual([]);
    });
  }

  it("a shine's position is keyable", () => {
    expect(propertyDef("lfx.abc.position")?.kind).toBe("number");
  });
});
