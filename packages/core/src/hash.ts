/**
 * A short, stable content hash: two independent 32-bit lanes (FNV-1a and
 * djb2) plus the length, base-36. Not cryptographic; wide enough that a
 * collision would take deliberate effort. Used where a stale match is costly:
 * a render-in-place commit, a suspended session handed back to its document.
 */
export function hashString(s: string): string {
  let a = 0x811c9dc5;
  let b = 5381;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = (Math.imul(b, 33) + c) | 0;
  }
  return `${(a >>> 0).toString(36)}${(b >>> 0).toString(36)}${s.length.toString(36)}`;
}
