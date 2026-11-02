/**
 * Selling the company, score, game over. DESIGN.md section 12. STUB — to be implemented.
 */
import type { GameState, Result, Verdict } from './types';
import { no } from './types';

export interface ScorePreview {
  offer: number;
  founderShare: number;
  debt: number;
  score: number;
  /** when selling becomes possible */
  sellFromDay: number;
}

export function scorePreview(state: GameState): ScorePreview {
  void state;
  return { offer: 0, founderShare: 1, debt: 0, score: 0, sellFromDay: 0 };
}

export function canSell(state: GameState): Verdict {
  void state;
  return no('not implemented');
}

/** status = 'sold', result filled, log. */
export function sellCompany(state: GameState): Result {
  void state;
  throw new Error('not implemented');
}

/** status = 'gameOver', result with score 0, log. */
export function gameOver(state: GameState, reason: string): Result {
  state.status = 'gameOver';
  const result: Result = { kind: 'gameOver', day: state.day, offer: 0, founderShare: state.founderShare, debt: 0, score: 0, reason };
  state.result = result;
  return result;
}
