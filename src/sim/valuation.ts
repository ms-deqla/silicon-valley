/**
 * Required return, DCF, floor. DESIGN.md section 10.
 *
 * value = max(DCF + cash − debt, floor); DCF is an enterprise value built from a
 * run-rate of operating cash flow after maintenance capex, grown at a decaying
 * trailing growth rate and discounted at the required return r, which is the base
 * rate plus five risk premia.
 */
import type { GameState, MonthBook, Premia, Valuation } from './types';
import { CONFIG } from './config';
import { assetsAtBook, debtOf, openReceivables, revenueOf } from './ledger';
import * as S from './selectors';

/** Calendar constant, not a tuning number. */
const MONTHS_PER_YEAR = 12;

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

/**
 * DESIGN.md 10: base = average of the last closed months of
 * FCF + capex − disposal proceeds − depreciation (operating cash flow after
 * maintenance capex). Before the first close: subscriptions in, costs out, at today's staffing.
 */
function runRateOf(state: GameState): number {
  const recent = state.history.slice(-CONFIG.valuation.runRateMonths);
  if (recent.length === 0) {
    let smb = 0;
    for (const c of state.customers) if (c.kind === 'smb') smb += c.monthlyPrice;
    return smb - S.monthlyCosts(state).total;
  }
  let sum = 0;
  for (const b of recent) sum += b.fcf + b.cf.capex - b.cf.disposalProceeds - b.pnl.depreciation;
  return sum / recent.length;
}

/**
 * DESIGN.md 10: g0 = trailing revenue growth per month measured over growthWindowMonths
 * (or the longest window available, at least 2 months), scaled by a trust factor so a
 * few hundred dollars of revenue never forecast a rocket: trust = min(1, revenue ÷
 * growthTrustRevenue) × min(1, window ÷ growthWindowMonths). Clamped to [growthMin, growthMax].
 */
/** Average revenue of the n closed months ending just before index `end`. */
function averageRevenue(h: MonthBook[], end: number, n: number): number {
  let sum = 0;
  for (let i = end - n; i < end; i++) sum += revenueOf(h[i]);
  return sum / n;
}

/**
 * DESIGN.md 10: growth compares 3-month average revenues `lag` months apart (annual
 * enterprise bookings are lumpy), scaled by the trust factor, clamped.
 */
function initialGrowth(state: GameState): number {
  const V = CONFIG.valuation;
  const h = state.history;
  const n = V.growthSmoothMonths;
  const lag = Math.min(V.growthWindowMonths, h.length - n);
  if (lag < V.growthMinLagMonths) return 0;
  const last = averageRevenue(h, h.length, n);
  const earlier = averageRevenue(h, h.length - lag, n);
  if (last <= 0 || earlier <= 0) return 0;
  const raw = Math.pow(last / earlier, 1 / lag) - 1;
  const trust = Math.min(1, last / V.growthTrustRevenue) * Math.min(1, lag / V.growthWindowMonths);
  return clamp(raw * trust, V.growthMin, V.growthMax);
}

/** DESIGN.md 10: the five premia on top of the base rate. */
function premiaOf(state: GameState, runway: number | null): Premia {
  const V = CONFIG.valuation;
  const debt = debtOf(state);
  // "last month's value": the valuation still on the state; null while createGame is building it
  const prev = state.valuation as Valuation | null;
  const lastValue = prev ? Math.max(0, prev.value) : 0;
  return {
    base: V.base,
    // burn: DESIGN.md 10 keys it on the FCF run-rate ("if FCF run-rate < 0"), not on the DCF base,
    // which adds capex back; selectors.runwayMonths is null exactly when that run-rate is not negative
    burn: runway !== null ? V.burnMax * clamp(1 - runway / V.burnRunwayMonths, 0, 1) : 0,
    rnd: S.rndCostShare(state) * V.rndMax,
    leverage: debt > 0 ? (debt / (debt + lastValue)) * V.leverageMax : 0,
    concentration: S.largestCustomerShare(state) * V.concentrationMax,
    recession: S.recessionActive(state) ? V.recession : 0,
  };
}

/**
 * DESIGN.md 10: project horizonMonths of monthly flows from the run-rate, growth
 * decaying linearly from g0 to the monthly terminal rate over growthDecayMonths,
 * discounted at (1+r)^(1/12) − 1. Terminal value at the horizon only when that
 * flow is positive. Enterprise value.
 */
function dcfOf(runRate: number, g0: number, r: number): number {
  const V = CONFIG.valuation;
  const gT = Math.pow(1 + V.terminalGrowthAnnual, 1 / MONTHS_PER_YEAR) - 1;
  const rm = Math.pow(1 + r, 1 / MONTHS_PER_YEAR) - 1;
  let flow = runRate;
  let disc = 1;
  let pv = 0;
  for (let m = 1; m <= V.horizonMonths; m++) {
    const g = g0 + (gT - g0) * Math.min(m / V.growthDecayMonths, 1);
    flow *= 1 + g;
    disc /= 1 + rm;
    pv += flow * disc;
  }
  // terminal value: Gordon growth, capped at terminalMaxYears of the horizon flow (DESIGN.md 10)
  if (flow > 0 && rm > gT) {
    const gordon = (flow * (1 + gT)) / (rm - gT);
    const cap = flow * MONTHS_PER_YEAR * V.terminalMaxYears;
    pv += Math.min(gordon, cap) * disc;
  }
  return pv;
}

export function computeValuation(state: GameState): Valuation {
  const V = CONFIG.valuation;
  const runRate = runRateOf(state);
  const runway = S.runwayMonths(state);
  const premia = premiaOf(state, runway);
  const r = premia.base + premia.burn + premia.rnd + premia.leverage + premia.concentration + premia.recession;
  const growth = initialGrowth(state);
  const dcf = dcfOf(runRate, growth, r);
  const debt = debtOf(state);

  // DESIGN.md 10: floor = cash + 0.9 AR + 0.6 assets at book − debt + acqui-hire min(Σ skill × $50k, cap), founder included
  let acquihire = 0;
  for (const p of state.people) acquihire += p.skill * V.acquihirePerSkill;
  acquihire = Math.min(acquihire, V.acquihireCap);
  const floor = state.cash + V.arRecovery * openReceivables(state) + V.assetRecovery * assetsAtBook(state) - debt + acquihire;

  // DESIGN.md 10: operating equity value = max(0, DCF + cash − debt); company value = max(operating, floor), never below 0
  const operating = Math.max(0, dcf + state.cash - debt);
  const value = Math.max(0, operating, floor);

  return { value, dcf, operating, floor, acquihire, r, premia, growth, runRate, runwayMonths: runway };
}
