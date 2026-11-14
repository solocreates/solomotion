import { customAlphabet } from "nanoid";

const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
const nano = customAlphabet(alphabet, 12);

/** Short, URL-safe, collision-resistant id with a readable type prefix (e.g. `clip_x1y2z3`). */
export function createId(prefix: string): string {
  return `${prefix}_${nano()}`;
}
