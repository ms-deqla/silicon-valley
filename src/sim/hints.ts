/**
 * The "why" line (biggest cash-bridge item in words) and the contextual hint line.
 * DESIGN.md section 13. Also home of the shared money formatter used on cards.
 */
import type { GameState } from './types';
import { CONFIG, RULES } from './config';
import * as L from './ledger';
import * as S from './selectors';

/**
 * Display-only thresholds (CONFIG.ui). Cosmetic: they decide which sentence is shown,
 * never how any dollar moves.
 */
const WHY_MIN_ITEM = CONFIG.ui.whyMinItem;
const LOW_RUNWAY_MONTHS = CONFIG.ui.lowRunwayMonths;
const MARKETING_HINT_FEATURES = CONFIG.ui.marketingHintFeatures;
const SUPPORT_HINT_SERVED = CONFIG.ui.supportHintServed;

// ---------------------------------------------------------------- formatting

/** $500, $30k, $184k, $1.3M, $12M; negatives get a minus sign. */
export function fmtMoney(n: number): string {
  const sign = n < 0 ? '−' : '';
  const a = Math.abs(n);
  if (a < 1_000) return `${sign}$${Math.round(a)}`;
  const k = a / 1_000;
  if (k < 999.5) return `${sign}$${Math.round(k)}k`;
  const m = a / 1_000_000;
  const text = (m < 10 ? m.toFixed(1) : m.toFixed(0)).replace(/\.0$/, '');
  return `${sign}$${text}M`;
}

/** A share 0..1 as "24%" (one decimal below 10%). */
export function fmtPct(share: number): string {
  const v = share * 100;
  return `${v < 10 ? v.toFixed(1) : v.toFixed(0)}%`;
}

/** An annual rate as "5.5%". */
export function fmtRate(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

// ---------------------------------------------------------------- why line

interface WhyItem {
  size: number;
  text: string;
}

/** Monthly straight-line depreciation of the assets bought since this book started. */
function depreciationOfNewAssets(state: GameState): number {
  let d = 0;
  for (const a of state.assets) {
    if (a.boughtDay >= state.book.startDay && a.lifeMonths > 0) d += a.cost / a.lifeMonths;
  }
  return d;
}

/**
 * DESIGN.md 13: one sentence naming the biggest item of this month's cash bridge
 * (DESIGN.md 9): receivables, capex vs depreciation, bad debt, financing.
 */
const AGREE = 'Profit and cash agree this month.';

export function whyLine(state: GameState): string {
  const book = state.book;
  const bridge = L.bridgeOf(book, L.openReceivables(state), state.cash);
  const items: WhyItem[] = [];

  // A write-off lowers AR without any cash, so take it out of the receivables item
  // and name it on its own (DESIGN.md 9: bad debt sits in both Profit and ΔReceivables).
  const badDebt = book.pnl.badDebt;
  const deltaAr = bridge.deltaReceivables + badDebt;
  if (deltaAr > 0) items.push({ size: deltaAr, text: `Profit up, cash down: ${fmtMoney(deltaAr)} is owed to you.` });
  else if (deltaAr < 0) items.push({ size: -deltaAr, text: `Cash up, profit flat: ${fmtMoney(-deltaAr)} of old invoices got paid.` });

  if (bridge.capex > 0) {
    const monthly = depreciationOfNewAssets(state);
    items.push({ size: bridge.capex, text: `Cash down ${fmtMoney(bridge.capex)} on assets; profit only sees ${fmtMoney(monthly)} a month of it.` });
  }

  if (badDebt > 0) items.push({ size: badDebt, text: `${fmtMoney(badDebt)} written off: profit took the hit, cash never had it.` });

  const fin = bridge.financing;
  if (fin > 0) {
    const { equityIn, loanIn } = book.fin;
    const source = equityIn > 0 && loanIn > 0 ? 'investors and the bank' : equityIn > 0 ? 'investors' : 'the bank';
    items.push({ size: fin, text: `${fmtMoney(fin)} came in from ${source}: cash up, profit untouched.` });
  } else if (fin < 0) {
    items.push({ size: -fin, text: `${fmtMoney(-fin)} went to repay the loan: cash down, profit untouched.` });
  }

  let best: WhyItem | null = null;
  for (const it of items) if (it.size >= WHY_MIN_ITEM && (best === null || it.size > best.size)) best = it;
  return best ? best.text : AGREE;
}

// ---------------------------------------------------------------- hint line

/** DESIGN.md 13: contextual one-liner, priority-ordered rules, first match wins. */
export function hintLine(state: GameState): string {
  if (state.status !== 'playing') return '';
  if (state.card) return '';
  if (state.features === 0) return 'Ship a feature: nobody buys an empty product.';
  if (state.prospects.length > 0 && S.salesCapacityPerMonth(state) === 0) {
    // DESIGN.md 0: the tournament has no founder-role control, so the hire is the only move
    return RULES.founderRole
      ? 'An enterprise prospect is waiting in the lobby. Put yourself on sales or hire a rep.'
      : 'An enterprise prospect is waiting in the lobby. Hire a sales rep.';
  }
  const noLaptop = state.people.find((p) => !p.hasLaptop);
  if (noLaptop) {
    return noLaptop.founder ? 'You have no laptop and work at half speed.' : `${noLaptop.name} has no laptop and works at half speed.`;
  }
  if (S.serversShort(state) > 0) return 'Servers are short: outage risk every month.';
  const runway = S.runwayMonths(state);
  if (runway !== null && runway < LOW_RUNWAY_MONTHS) return `Runway: ${runway.toFixed(1)} months. Investors knock on their own schedule; a lifeline comes if the bank runs dry.`;
  const asking = state.people.find((p) => p.raisePending);
  if (asking) return `${asking.name} is asking for a raise.`;
  const ar = L.openReceivables(state);
  if (RULES.finance && state.financeUnlocked && !S.hasRoom(state, 'finance') && ar > 0) {
    return `${fmtMoney(ar)} is owed to you. A Finance room gets you paid faster.`;
  }
  if (state.features >= MARKETING_HINT_FEATURES && !S.hasRoom(state, 'marketing')) return 'Visitors are a trickle. Open Marketing.';
  if (state.ticketsServedShare < SUPPORT_HINT_SERVED) return 'Support is swamped: customers are churning.';
  if (RULES.sell && state.day >= CONFIG.exit.sellFromDay) return `You can sell any time. Today's offer: ${fmtMoney(state.valuation.value)}.`;
  if (whyLine(state) === AGREE) return 'Nothing owed and nothing bought yet, so the bars agree. Sign an enterprise deal and watch them split.';
  return 'Watch Profit and Cash flow disagree, then open Books to see why.';
}
