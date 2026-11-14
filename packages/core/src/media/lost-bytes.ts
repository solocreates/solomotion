import type { Asset } from "../schema";

/**
 * WHICH LOST ASSETS A FILE IS — the rule an import uses to put bytes back
 * under the ids that lost them, instead of minting new ones.
 *
 * A project's document outlives its media more often than it should: the
 * document is mirrored, the bytes are not, and a browser clearing storage
 * leaves every asset row behind with nothing under it. Whoever made the
 * project still has the files and imports them again. If that mints new ids,
 * every layer, script and hit sound still points at the empty ones.
 *
 * The first version matched size alone, and only when ONE byte-less asset had
 * it. That was right the first time and wrong every time after: each lost
 * round left one more byte-less copy of the same file behind, so the second
 * loss found three copies of `marimba.mp3`, called it a guess, and minted a
 * fourth id — 1049 references repointed by hand. Copies of one file are not a
 * guess. They are one file under several ids, and every one of them heals.
 *
 * Identity, strongest first:
 *   - the content fingerprint an import records (`sha256`): equal is the same
 *     bytes, different is a different file of the same size;
 *   - for assets imported before fingerprints, the file name: a byte-less
 *     asset of this size, kind and name is this file;
 *   - and, as before, the one byte-less asset of this size and kind when
 *     nothing else claims the file.
 *
 * Returned primary first: the copy the project uses most, which is the id a
 * caller asking "what did my file become?" should be told.
 */
export interface IncomingMedia {
  kind: Asset["kind"];
  bytes: number;
  name: string;
  sha256: string;
}

export function assetsLostAs(
  assets: readonly Asset[],
  file: IncomingMedia,
  hasBytes: (id: string) => boolean,
  uses: (id: string) => number = () => 0,
): Asset[] {
  const empty = assets.filter((a) => a.kind === file.kind && a.bytes === file.bytes && !hasBytes(a.id));
  const legacy = empty.filter((a) => !a.sha256);
  let found = [...empty.filter((a) => a.sha256 === file.sha256), ...legacy.filter((a) => a.name === file.name)];
  if (!found.length && legacy.length === 1 && empty.length === 1) found = legacy;
  if (found.length < 2) return found;
  return found
    .map((a, i) => ({ a, i, n: uses(a.id) }))
    .sort((x, y) => y.n - x.n || x.i - y.i)
    .map((x) => x.a);
}
