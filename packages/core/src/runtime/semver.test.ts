import { describe, expect, it } from "vitest";
import { compareVersions, parseSemver } from "./semver";

describe("parseSemver", () => {
  it("parses plain and v-prefixed versions", () => {
    expect(parseSemver("0.5.1")).toEqual({ major: 0, minor: 5, patch: 1, prerelease: [] });
    expect(parseSemver("v1.2.3")).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [] });
  });
  it("parses prerelease + strips build metadata", () => {
    expect(parseSemver("1.0.0-beta.2+abc")).toEqual({
      major: 1, minor: 0, patch: 0, prerelease: ["beta", "2"],
    });
  });
  it("rejects garbage", () => {
    expect(parseSemver("nightly")).toBeNull();
    expect(parseSemver("1.2")).toBeNull();
  });
});

describe("compareVersions", () => {
  it("orders by major/minor/patch", () => {
    expect(compareVersions("1.0.0", "2.0.0")).toBe(-1);
    expect(compareVersions("0.5.10", "0.5.9")).toBe(1); // numeric, not lexical
    expect(compareVersions("0.5.1", "0.5.1")).toBe(0);
  });
  it("ranks a release above its prerelease", () => {
    expect(compareVersions("1.0.0", "1.0.0-beta.1")).toBe(1);
    expect(compareVersions("1.0.0-beta.1", "1.0.0-beta.2")).toBe(-1);
    expect(compareVersions("1.0.0-alpha", "1.0.0-alpha.1")).toBe(-1);
  });
  it("sorts unparseable below valid, tolerant of the v prefix", () => {
    expect(compareVersions("v0.5.2", "0.5.1")).toBe(1);
    expect(compareVersions("weird", "0.1.0")).toBe(-1);
  });
});
