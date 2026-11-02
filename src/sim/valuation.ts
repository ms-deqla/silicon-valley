/**
 * Required return, DCF, floor. DESIGN.md section 10. STUB — to be implemented.
 */
import type { GameState, Valuation } from './types';
import { CONFIG } from './config';
import { debtOf } from './ledger';

export function computeValuation(state: GameState): Valuation {
  // placeholder: floor only
  let acqui = 0;
  for (const p of state.people) acqui += p.skill * CONFIG.valuation.acquihirePerSkill;
  const floor = state.cash - debtOf(state) + acqui;
  return {
    value: Math.max(0, floor),
    dcf: 0,
    floor,
    r: CONFIG.valuation.base,
    premia: { base: CONFIG.valuation.base, burn: 0, rnd: 0, leverage: 0, concentration: 0, recession: 0 },
    growth: 0,
    runRate: 0,
    runwayMonths: null,
  };
}
