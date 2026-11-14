import type { Theme } from "./schema";

/** Theme → the file a person exports. Stable key order, two-space indent. */
export function writeThemeFile(theme: Theme): string {
  return `${JSON.stringify(theme, null, 2)}\n`;
}
