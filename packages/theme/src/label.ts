/**
 * A label in the `--var` style: "Motion blur" → "--motion-blur".
 *
 * Components render the real words and put this beside them as `data-var`;
 * the `var` label dialect shows it with `content: attr(data-var)`. So the
 * style is CSS-only, the accessible name stays the words, and no component has
 * to know which label style is on.
 */
export function varName(label: string): string {
  const slug = label
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/ß/g, "ss")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `--${slug || "value"}`;
}
