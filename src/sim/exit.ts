/**
 * Selling the company, score, game over. DESIGN.md section 12.
 */
import type { GameState, Result, Verdict } from './types';
import { no, OK } from './types';
import { CONFIG } from './config';
import { debtOf } from './ledger';
import { fmtMoney, fmtPct } from './hints';

export interface ScorePreview {
  offer: number;
  founderShare: number;
  debt: number;
  score: number;
  /** when selling becomes possible */
  sellFromDay: number;
}

/** DESIGN.md 12: offer = company value (debt already netted), score = offer × founder share. */
export function scorePreview(state: GameState): ScorePreview {
  const offer = Math.max(0, state.valuation.value);
  return {
    offer,
    founderShare: state.founderShare,
    debt: debtOf(state),
    score: offer * state.founderShare,
    sellFromDay: CONFIG.exit.sellFromDay,
  };
}

/** DESIGN.md 12: Sell is enabled from day 720 (month 24). */
export function canSell(state: GameState): Verdict {
  if (state.day < CONFIG.exit.sellFromDay) return no('You can sell from the start of year 3');
  return OK;
}

/** status = 'sold', result filled, log. */
export function sellCompany(state: GameState): Result {
  const p = scorePreview(state);
  const result: Result = {
    kind: 'sold',
    day: state.day,
    offer: p.offer,
    founderShare: p.founderShare,
    debt: p.debt,
    score: p.score,
    reason: `You sold ${state.companyName} for ${fmtMoney(p.offer)}. Your ${fmtPct(p.founderShare)} is worth ${fmtMoney(p.score)}.`,
  };
  state.status = 'sold';
  state.result = result;
  state.log.push({ day: state.day, text: result.reason, tone: 'good' });
  return result;
}

/** status = 'gameOver', result with score 0 and the debt still owed, log. */
export function gameOver(state: GameState, reason: string): Result {
  state.status = 'gameOver';
  const result: Result = {
    kind: 'gameOver',
    day: state.day,
    offer: 0,
    founderShare: state.founderShare,
    debt: debtOf(state),
    score: 0,
    reason,
  };
  state.result = result;
  state.log.push({ day: state.day, text: `Game over: ${reason}`, tone: 'bad' });
  return result;
}
