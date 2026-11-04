/**
 * The coach-mark tour on the first Start (DESIGN.md 18). STUB — to be implemented.
 */
import type { GameController } from './api';

export interface TourHandle {
  destroy(): void;
}

export function tourSeen(): boolean {
  return true;
}

export function markTourSeen(): void {}

/** Runs the nine stops over the mounted round; onDone fires on finish or skip. */
export function startTour(opts: { root: HTMLElement; controller: GameController; onDone: () => void }): TourHandle {
  opts.onDone();
  return { destroy() {} };
}
