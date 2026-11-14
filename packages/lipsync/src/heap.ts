/**
 * A tiny binary min-heap over (primary, secondary) number keys — the "shortest
 * first, earliest on ties" order every run-merging pass in this package uses.
 * Entries go stale instead of being removed (callers re-check on pop), which
 * keeps every merge pass O(n log n) instead of rescanning all runs per merge.
 */
export class MinHeap<T> {
  private keys: number[] = [];
  private ties: number[] = [];
  private items: T[] = [];

  get size(): number {
    return this.items.length;
  }

  push(key: number, tie: number, item: T): void {
    this.keys.push(key);
    this.ties.push(tie);
    this.items.push(item);
    let i = this.items.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(i, p)) break;
      this.swap(i, p);
      i = p;
    }
  }

  pop(): T | undefined {
    const n = this.items.length;
    if (n === 0) return undefined;
    const top = this.items[0]!;
    this.swap(0, n - 1);
    this.keys.pop();
    this.ties.pop();
    this.items.pop();
    const m = n - 1;
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let s = i;
      if (l < m && this.less(l, s)) s = l;
      if (r < m && this.less(r, s)) s = r;
      if (s === i) break;
      this.swap(i, s);
      i = s;
    }
    return top;
  }

  private less(a: number, b: number): boolean {
    const ka = this.keys[a]!;
    const kb = this.keys[b]!;
    return ka < kb || (ka === kb && this.ties[a]! < this.ties[b]!);
  }

  private swap(a: number, b: number): void {
    [this.keys[a], this.keys[b]] = [this.keys[b]!, this.keys[a]!];
    [this.ties[a], this.ties[b]] = [this.ties[b]!, this.ties[a]!];
    [this.items[a], this.items[b]] = [this.items[b]!, this.items[a]!];
  }
}
