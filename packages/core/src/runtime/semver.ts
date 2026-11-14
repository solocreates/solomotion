/**
 * Semantic versions: parse and compare (semver §11 precedence). Pure — the
 * editor's update check, the site's release list and a plugin's engine range
 * all ask the same question, so they share this one answer.
 */

/** A parsed semantic version. `prerelease` is the dot-split tail, e.g. ["beta","2"]. */
export interface Semver {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** Parse a semver string ("0.5.1", "v1.0.0-beta.2"), or `null` if malformed. */
export function parseSemver(input: string): Semver | null {
  const m = SEMVER_RE.exec(input.trim());
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ? m[4].split(".") : [],
  };
}

/** Compare two prerelease identifier lists per semver §11. */
function comparePrerelease(a: string[], b: string[]): -1 | 0 | 1 {
  // A version WITHOUT a prerelease tail outranks one that has it.
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i] as string; // i < len ≤ a.length, so always present
    const y = b[i] as string;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d < 0 ? -1 : 1;
    } else if (xn !== yn) {
      // Numeric identifiers always rank lower than alphanumeric ones.
      return xn ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  if (a.length === b.length) return 0;
  return a.length < b.length ? -1 : 1;
}

/**
 * Semver-correct comparison. Returns -1 if `a < b`, 0 if equal, 1 if `a > b`.
 * Unparseable versions sort BELOW any valid one (so a valid remote always wins),
 * and fall back to string compare against each other.
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) {
    if (pa) return 1;
    if (pb) return -1;
    return a === b ? 0 : a < b ? -1 : 1;
  }
  for (const k of ["major", "minor", "patch"] as const) {
    if (pa[k] !== pb[k]) return pa[k] < pb[k] ? -1 : 1;
  }
  return comparePrerelease(pa.prerelease, pb.prerelease);
}

/** True when `candidate` is a strictly newer version than `current`. */
export function isNewer(candidate: string, current: string): boolean {
  return compareVersions(candidate, current) > 0;
}
