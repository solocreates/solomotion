/**
 * LIVE PLAYBACK MAKES MISSING PICTURES WITHIN A BUDGET — and takes turns.
 *
 * A comp seen through a nested clip has ONE picture per instant, kept in the
 * comp-picture store. A wall of them (the Playground cover: nine scenes as
 * tiles) misses all nine every frame of a first pass, each a whole scene's
 * render; live playback then draws a frame in ~150 ms, visits one instant in
 * five, and keeps a fifth of the loop. The second loop misses as often as the
 * first, the governor steps down, and the wall never fills.
 *
 * So while the transport runs LIVE, a frame makes only a budget's worth of
 * missing pictures; every other miss shows that comp's nearest kept picture as
 * a TRANSIENT stand-in (nothing keeps the frame it lands in) and is made on a
 * later turn. The frame stays fast, the tier stays sharp, and every frame
 * leaves the store fuller — the loop converges instead of resampling.
 *
 * THE TURNS. Draw order is fixed, so a plain budget hands every frame to the
 * first comps drawn and starves the rest. Instead a comp that made a picture
 * waits until every other comp that wanted one has had its turn — a ROUND —
 * and the first make of a frame always may (a frame makes progress even when
 * one picture costs more than the budget).
 *
 * One concept with two clients: the stage's live playback (nested comp
 * pictures) and the board (retained pictures of the comps you are not in).
 * Headless and clock-free: the caller measures and reports.
 */
export interface PictureFill {
  /** A new frame: the budget refills, and the last frame may have closed a round. */
  beginFrame(): void;
  /** May this comp's missing picture be made now? */
  mayMake(key: string): boolean;
  /** A picture of this comp was made, at this cost. */
  made(key: string, ms: number): void;
  /** What this frame has spent making pictures — paced here, so not the frame's steady cost. */
  spent(): number;
}

export function createPictureFill(budgetMs: number): PictureFill {
  /** Comps that have made a picture in the current round. */
  const served = new Set<string>();
  let spent = 0;
  let makes = 0;
  /** A comp that had its turn wanted another this frame. */
  let waitedTurn = false;
  /** A comp still owed a turn was refused for budget this frame. */
  let waitedBudget = false;

  return {
    beginFrame() {
      // Everyone refused last frame had already had a turn: the round is over.
      if (waitedTurn && !waitedBudget) served.clear();
      spent = 0;
      makes = 0;
      waitedTurn = false;
      waitedBudget = false;
    },
    mayMake(key) {
      if (served.has(key)) {
        waitedTurn = true;
        return false;
      }
      if (makes > 0 && spent >= budgetMs) {
        waitedBudget = true;
        return false;
      }
      return true;
    },
    made(key, ms) {
      served.add(key);
      spent += Math.max(0, ms);
      makes++;
    },
    spent: () => spent,
  };
}
