/**
 * What the run teaches (DESIGN.md 20): the takeaways with the biggest impact in dollars
 * and the timeline of the stake. Pure reads of a finished (or running) state: nothing
 * here mutates state, draws randomness or reads the clock.
 *
 * Sources. Months come from state.history (one closed book per month); hires, purchases
 * and card answers from state.actions, which is never trimmed; rounds from state.rounds;
 * the second floor from state.assets (the tournament builds it by itself, DESIGN.md 0, so
 * no action records it). Event cards come from the action log's card choices: every event
 * owns its two choice ids (events.EVENT_CHOICES), so a choice names its event without the
 * card. state.log is read only for the two outage lines, because nothing else records how
 * many customers an outage took; the log is capped (CONFIG.ui.logLength), so an old outage
 * card falls back to an estimate from that month's customer count.
 */
import type { ActionRecord, EventType, GameState, MonthBook, Role } from './types';
import { EVENT_TYPES } from './types';
import { CONFIG, RULES } from './config';
import { EVENT_CHOICES } from './events';
import { costsOf, revenueOf } from './ledger';
import * as S from './selectors';
import { fmtMoney, fmtPct, fmtRate } from './hints';
import { JOB_WORD } from './names';

const D = CONFIG.time.daysPerMonth;

/** DESIGN.md 20, idle cash: a closed month with more than this in the bank and no hire. */
const IDLE_CASH = CONFIG.postmortem.idleCash;

export interface RunExtras {
  /** wall-clock milliseconds with a card open, from the controller */
  cardWaitMs: number;
  practice: boolean;
}

export interface Takeaway {
  title: string;
  detail: string;
  /** rough $ impact, used to pick the top three */
  impact: number;
}

export interface TimelinePoint {
  month: number;
  value: number;
  share: number;
  stake: number;
}

export type MarkerKind = 'hire' | 'fire' | 'round' | 'event' | 'server' | 'demo' | 'upstairs';

export interface TimelineMarker {
  day: number;
  kind: MarkerKind;
  label: string;
}

// ---------------------------------------------------------------- words

const EVENT_WORD: Record<EventType, string> = {
  latePayer: 'Late payer', outage: 'Outage', press: 'Press', competitor: 'Competitor', poach: 'Poaching', recession: 'Recession',
};

/** The answer, in the past tense of the card's choice labels (DESIGN.md 11). */
const CHOICE_WORD: ReadonlyMap<string, string> = new Map([
  ['wait', 'waited'], ['press', 'pressed them'], ['fix', 'paid the fix'], ['ride', 'rode it out'],
  ['push', 'PR push'], ['enjoy', 'enjoyed it'], ['outbuild', 'out-built them'], ['cut', 'cut prices'],
  ['counter', 'counter-offer'], ['letgo', 'let them go'], ['tighten', 'tightened'], ['hold', 'held the line'],
]);

/** choice id → the event that owns it. */
const EVENT_OF_CHOICE: ReadonlyMap<string, EventType> = new Map(
  EVENT_TYPES.flatMap((t) => EVENT_CHOICES[t].map((id) => [id, t] as const)),
);

const DEMO_LABEL = 'Built the demo room';
const UPSTAIRS_LABEL = 'Built the second floor';

/** game.ts, the silent outage at a close (DESIGN.md 7). */
const BUCKLED = /^Servers buckled under load\. (\d+) customers? left\.$/;
/** events.ts, the "Ride it out" answer (DESIGN.md 11). */
const RODE_OUT = /^You rode out the outage\. (\d+) customers? left\.$/;

// ---------------------------------------------------------------- small helpers

/** The day a closed month's book was closed on (the next book starts that day). */
function closeDayOf(book: MonthBook): number {
  return book.startDay + D;
}

function monthsBetween(fromDay: number, toDay: number): number {
  return Math.max(0, toDay - fromDay) / D;
}

/** "month 7": the number the HUD calendar shows for that day. */
function monthWord(day: number): string {
  return `month ${S.monthIndex(day) + 1}`;
}

/** "2 game months", "0.3 game months", "1 game month". */
function monthsText(n: number): string {
  const v = Math.round(n * 10) / 10;
  return `${v.toFixed(1).replace(/\.0$/, '')} game month${v === 1 ? '' : 's'}`;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function withArticle(word: string): string {
  return `${/^[aeiou]/i.test(word) ? 'an' : 'a'} ${word}`;
}

function last<T>(list: readonly T[]): T | null {
  return list.length > 0 ? list[list.length - 1] : null;
}

/**
 * The founder's share before `day` (DESIGN.md 10: each round multiplies it by 1 − the share
 * sold). A round signed on a close day comes after that close: the knock opens and the month
 * closes in the same tick, and the answer lands in the new month.
 */
function shareBefore(state: GameState, day: number): number {
  let share = 1;
  for (const r of state.rounds) if (r.day < day) share *= 1 - r.shareSold;
  return share;
}

function points(state: GameState): TimelinePoint[] {
  return state.history.map((b) => {
    const value = Math.max(0, b.valueEnd);
    const share = shareBefore(state, closeDayOf(b));
    return { month: b.month, value, share, stake: value * share };
  });
}

/**
 * What the last closed month added to the stake (DESIGN.md 20: the price of a lost month).
 * With a single closed month the comparison is with day 0, whose value still heads
 * valueHistory while that list is shorter than its cap; null when there is nothing to compare.
 */
function stakeChangeOfLastMonth(state: GameState): number | null {
  const pts = points(state);
  const latest = last(pts);
  if (!latest) return null;
  if (pts.length >= 2) return latest.stake - pts[pts.length - 2].stake;
  if (state.valueHistory.length <= state.history.length) return null;
  return latest.stake - Math.max(0, state.valueHistory[0]);
}

/** The first day the role was hired into: the action log (hireRole) first, then the people still on the payroll. */
function firstHireDay(state: GameState, role: Role): number | null {
  let day: number | null = null;
  for (const rec of state.actions) {
    if (rec.action.type === 'hireRole' && rec.action.role === role) {
      day = rec.day;
      break;
    }
  }
  for (const p of state.people) if (!p.founder && p.role === role && (day === null || p.hiredDay < day)) day = p.hiredDay;
  return day;
}

/** Was anyone hired in the month this book covers (its start day up to, not including, its close day)? */
function hiredDuring(state: GameState, book: MonthBook): boolean {
  const end = closeDayOf(book);
  return state.actions.some((rec) =>
    (rec.action.type === 'hireRole' || rec.action.type === 'hire') && rec.day >= book.startDay && rec.day < end);
}

/** Mean monthly price of today's customers; today's subscription price when none are left. */
function averageMonthlyPrice(state: GameState): number {
  if (state.customers.length === 0) return S.smbPrice(state);
  let sum = 0;
  for (const c of state.customers) sum += c.monthlyPrice;
  return sum / state.customers.length;
}

/** Customers at the last close on or before `day` (0 before the first close). */
function customersAt(state: GameState, day: number): number {
  let n = 0;
  for (const b of state.history) if (closeDayOf(b) <= day) n = b.customersEnd;
  return n;
}

/** Were servers short that day? DESIGN.md 7: one per customersPerServer customers, against the servers bought by then. */
function serversShortAt(state: GameState, day: number): boolean {
  const needed = Math.floor(customersAt(state, day) / CONFIG.assets.customersPerServer);
  const owned = state.assets.filter((a) => a.kind === 'server' && a.boughtDay <= day).length;
  return needed > owned;
}

// ---------------------------------------------------------------- the candidates (DESIGN.md 20)

/** Raised but unspent: equity in against the cash left at the end. Impact: the unspent cash × the share sold. */
function raisedButUnspent(state: GameState): Takeaway | null {
  let raised = 0;
  let kept = 1;
  for (const r of state.rounds) {
    raised += r.amount;
    kept *= 1 - r.shareSold;
  }
  const sold = 1 - kept;
  const unspent = Math.min(raised, Math.max(0, state.cash));
  if (raised <= 0 || unspent <= 0) return null;
  // the slice of the company that bought the cash never used, pro rata
  const forNothing = sold * (unspent / raised);
  return {
    title: 'Raised but unspent',
    detail: `You raised ${fmtMoney(raised)} and ended with ${fmtMoney(unspent)} unspent: ${fmtPct(forNothing)} of the company sold for cash you never used.`,
    impact: unspent * sold,
  };
}

/**
 * Cards left waiting: wall-clock time with a card open is game time lost (DESIGN.md 0: a card
 * stops the game, not the clock). Impact: the months lost × what the last month added to the stake.
 */
function cardsLeftWaiting(state: GameState, extras: RunExtras): Takeaway | null {
  const ms = Number.isFinite(extras.cardWaitMs) ? Math.max(0, extras.cardWaitMs) : 0;
  const seconds = Math.round(ms / 1000);
  if (seconds < 1) return null;
  const monthsLost = ms / (RULES.secondsPerMonth * 1000);
  const lastChange = stakeChangeOfLastMonth(state);
  const pts = points(state);
  const latest = last(pts);
  // a positive proxy for what a month is worth: the last month's move, or the stake spread over the months played
  const average = latest ? latest.stake / Math.max(1, pts.length) : 0;
  const perMonth = Math.max(Math.abs(lastChange ?? 0), average);
  if (perMonth <= 0) return null;
  const impact = monthsLost * perMonth;
  return {
    title: 'Cards left waiting',
    detail: `Cards waited ${seconds} s: ${monthsText(monthsLost)} lost. A month of your round was worth about ${fmtMoney(perMonth)} of stake, so those months cost about ${fmtMoney(impact)}.`,
    impact,
  };
}

/**
 * Support too late: the customers who cancelled before the first support agent (all of them
 * when support was never hired). Without an agent no ticket is answered, so the churn rate is
 * churnBase + churnUnserved (DESIGN.md 8) and the unserved part was avoidable. Impact: the
 * avoidable churn × the average monthly price × the months each had left in the round.
 */
function supportTooLate(state: GameState): Takeaway | null {
  const C = CONFIG.customers;
  const hireDay = firstHireDay(state, 'support');
  // DESIGN.md 20: "late" means later than the coach's threshold, not merely after the first cancellation
  if (hireDay !== null && customersAt(state, hireDay) <= CONFIG.coach.supportCustomers) return null;
  const avoidable = C.churnUnserved / (C.churnBase + C.churnUnserved);
  const price = averageMonthlyPrice(state);
  let churned = 0;
  let impact = 0;
  for (const b of state.history) {
    const close = closeDayOf(b);
    if (hireDay !== null && close > hireDay) break;
    churned += b.churned;
    impact += b.churned * avoidable * price * monthsBetween(close, state.day);
  }
  if (churned <= 0) return null;
  const who = hireDay === null
    ? 'You never hired support'
    : `Your first support agent came in ${monthWord(hireDay)} with about ${customersAt(state, hireDay)} customers`;
  return {
    title: hireDay === null ? 'No support' : 'Support came late',
    detail: `${who}: ${plural(churned, 'customer had', 'customers had')} already cancelled, about ${Math.round(churned * avoidable)} of them over unanswered tickets. `
      + `At ${fmtMoney(price)} a month each, those would have paid about ${fmtMoney(impact)} by the end of the round.`,
    impact,
  };
}

/** Customers a ridden-out outage took: the log line while it is there, else the share of that month's customers (DESIGN.md 11). */
function riddenOut(state: GameState, day: number): number {
  for (const e of state.log) {
    if (e.day !== day) continue;
    const m = RODE_OUT.exec(e.text);
    if (m) return Number(m[1]);
  }
  return Math.round(CONFIG.events.outageLoss * customersAt(state, day));
}

/**
 * Servers too late: the outages suffered while servers were short, silent ones at a close
 * (DESIGN.md 7) and outage cards (DESIGN.md 11). An outage card with enough servers is bad
 * luck, not a lesson about servers, so it is left out. Impact: customers lost × the average
 * monthly price × the months left in the round, plus the emergency fixes paid.
 */
function serversTooLate(state: GameState): Takeaway | null {
  const [FIX, RIDE] = EVENT_CHOICES.outage;
  const price = averageMonthlyPrice(state);
  let outages = 0;
  let lost = 0;
  let fixes = 0;
  let impact = 0;
  const took = (n: number, day: number): void => {
    lost += n;
    impact += n * price * monthsBetween(day, state.day);
  };
  for (const e of state.log) {
    const m = BUCKLED.exec(e.text);
    if (!m) continue;
    outages += 1;
    took(Number(m[1]), e.day);
  }
  for (const rec of state.actions) {
    if (rec.action.type !== 'card' || !serversShortAt(state, rec.day)) continue;
    if (rec.action.choiceId === FIX) {
      outages += 1;
      fixes += CONFIG.events.outageFix;
      impact += CONFIG.events.outageFix;
    } else if (rec.action.choiceId === RIDE) {
      outages += 1;
      took(riddenOut(state, rec.day), rec.day);
    }
  }
  if (outages === 0) return null;
  const costs: string[] = [];
  if (lost > 0) costs.push(plural(lost, 'customer'));
  if (fixes > 0) costs.push(`${fmtMoney(fixes)} in emergency fixes`);
  const server = CONFIG.assets.catalogue.server;
  return {
    title: 'Servers came late',
    detail: `${plural(outages, 'outage')} while servers were short cost you ${costs.join(' and ')}: about ${fmtMoney(impact)} by the end of the round. `
      + `A server is ${fmtMoney(server.price)} and covers ${CONFIG.assets.customersPerServer} customers.`,
    impact,
  };
}

/**
 * Marketing too late: the months between features reaching the hint's count
 * (CONFIG.ui.marketingHintFeatures: "Visitors are a trickle. Open Marketing.") and the first
 * marketer. Impact: those months × the visitors one marketer brings × the conversion at that
 * feature count × the subscription price then (DESIGN.md 8): the monthly subscriptions never signed.
 */
function marketingTooLate(state: GameState): Takeaway | null {
  const F = CONFIG.ui.marketingHintFeatures;
  const reached = state.history.find((b) => b.featuresEnd >= F);
  if (!reached) return null;
  const reachDay = closeDayOf(reached);
  const hireDay = firstHireDay(state, 'marketing');
  const monthsLate = monthsBetween(reachDay, hireDay ?? state.day);
  if (monthsLate <= 0) return null;
  const P = CONFIG.people;
  // DESIGN.md 6 and 8: output = skill × (0.5 + morale ÷ 200); visitors = visitorsPerOutput × output
  const output = RULES.hire.marketing.skill * (P.outputMoraleBase + P.morale.base / P.outputMoraleDivisor);
  const visitors = CONFIG.marketing.visitorsPerOutput * output;
  const conversion = CONFIG.product.conversionMax * (1 - Math.exp(-CONFIG.product.conversionK * F));
  const price = CONFIG.customers.smbPrice * (1 + CONFIG.product.pricePerFeature * Math.min(F, CONFIG.product.priceFeatureCap));
  const customers = monthsLate * visitors * conversion;
  const impact = customers * price;
  const when = hireDay === null
    ? `you never hired a marketer: ${monthsText(monthsLate)} without one`
    : `your first marketer came in ${monthWord(hireDay)}, ${monthsText(monthsLate)} later`;
  return {
    title: hireDay === null ? 'No marketing' : 'Marketing came late',
    detail: `Features reached ${F} in ${monthWord(reachDay)} and ${when}. A marketer brings about ${Math.round(visitors)} visitors a month and `
      + `${fmtPct(conversion)} of them buy at ${fmtMoney(price)}: about ${Math.round(customers)} customers never signed, worth ${fmtMoney(impact)} a month.`,
    impact,
  };
}

/**
 * Idle cash: closed months with more than IDLE_CASH in the bank and no hire. Impact: the
 * return investors wanted on the cash above the line (DESIGN.md 10: the required return at
 * that close, never below the base) for the months it sat there.
 */
function idleCash(state: GameState): Takeaway | null {
  let months = 0;
  let excess = 0;
  let rate = 0;
  let impact = 0;
  for (const b of state.history) {
    if (b.cashEnd <= IDLE_CASH || hiredDuring(state, b)) continue;
    const r = Math.max(b.requiredReturnEnd, CONFIG.valuation.base);
    months += 1;
    excess += b.cashEnd - IDLE_CASH;
    rate += r;
    impact += ((b.cashEnd - IDLE_CASH) * r) / 12;
  }
  if (months === 0) return null;
  return {
    title: 'Idle cash',
    detail: `${plural(months, 'month')} with more than ${fmtMoney(IDLE_CASH)} in the bank and no hire, ${fmtMoney(excess / months)} above it on average. `
      + `Money in the bank earns nothing while investors wanted ${fmtRate(rate / months)} a year: about ${fmtMoney(impact)} of growth not bought.`,
    impact,
  };
}

/**
 * Out of cash: the last closed month's costs against its revenue (DESIGN.md 9: game over at a
 * close with cash < 0). Impact: the stake that went to zero, never less than the gap or the shortfall.
 */
function outOfCash(state: GameState): Takeaway | null {
  if (state.status !== 'gameOver') return null;
  const book = last(state.history);
  if (!book) return null;
  const revenue = revenueOf(book);
  const costs = costsOf(book);
  const gap = costs - revenue;
  const stake = last(points(state))?.stake ?? 0;
  const shortfall = Math.max(0, -book.cashEnd);
  let books: string;
  if (gap > 0) {
    books = `In the last month costs were ${fmtMoney(costs)} against ${fmtMoney(revenue)} of revenue, a gap of ${fmtMoney(gap)},`;
  } else {
    // DESIGN.md 9: profit is not cash; the receivables and the capex are where it went
    const where: string[] = [];
    if (book.arEnd > 0) where.push(`${fmtMoney(book.arEnd)} sat in unpaid invoices`);
    if (book.cf.capex > 0) where.push(`${fmtMoney(book.cf.capex)} went into assets`);
    books = `The last month was profitable on paper, ${fmtMoney(revenue)} of revenue against ${fmtMoney(costs)} of costs, `
      + `but ${where.length > 0 ? where.join(' and ') : 'the cash had already gone'},`;
  }
  return {
    title: 'Out of cash',
    detail: `${books} and the bank balance ended at ${fmtMoney(book.cashEnd)}. Running out of cash scores 0: a stake worth ${fmtMoney(stake)} went with it.`,
    impact: Math.max(gap, stake, shortfall),
  };
}

/** The three takeaways with the highest impact (fewer when the run has less to say). */
export function takeaways(state: GameState, extras: RunExtras): Takeaway[] {
  const candidates = [
    raisedButUnspent(state),
    cardsLeftWaiting(state, extras),
    supportTooLate(state),
    serversTooLate(state),
    marketingTooLate(state),
    idleCash(state),
    outOfCash(state),
  ];
  return candidates
    .filter((t): t is Takeaway => t !== null && t.impact > 0)
    .sort((a, b) => b.impact - a.impact)
    .slice(0, 3);
}

// ---------------------------------------------------------------- the timeline

function actionMarker(rec: ActionRecord): TimelineMarker | null {
  const a = rec.action;
  const day = rec.day;
  switch (a.type) {
    case 'hireRole': return { day, kind: 'hire', label: `Hired ${withArticle(JOB_WORD[a.role])}` };
    case 'fireRole': return { day, kind: 'fire', label: `Let ${withArticle(JOB_WORD[a.role])} go` };
    case 'hire': return { day, kind: 'hire', label: 'New hire' };
    case 'fire': return { day, kind: 'fire', label: 'Someone let go' };
    case 'buyAsset':
      if (a.kind === 'server') return { day, kind: 'server', label: 'Bought a server' };
      if (a.kind === 'secondFloor') return { day, kind: 'upstairs', label: UPSTAIRS_LABEL };
      return null;
    case 'buyDemoRoom': return { day, kind: 'demo', label: DEMO_LABEL };
    case 'placeRoom': return a.kind === 'demo' ? { day, kind: 'demo', label: DEMO_LABEL } : null;
    case 'card': {
      const type = EVENT_OF_CHOICE.get(a.choiceId);
      if (!type) return null;
      return { day, kind: 'event', label: `${EVENT_WORD[type]}: ${CHOICE_WORD.get(a.choiceId) ?? a.choiceId}` };
    }
    default: return null;
  }
}

/** One point per closed month (value, share, stake = value × share) and the markers, by day. */
export function timeline(state: GameState): { points: TimelinePoint[]; markers: TimelineMarker[] } {
  const markers: TimelineMarker[] = [];
  for (const rec of state.actions) {
    const m = actionMarker(rec);
    if (m) markers.push(m);
  }
  for (const r of state.rounds) {
    markers.push({ day: r.day, kind: 'round', label: `${r.desperate ? 'Lifeline' : 'Round'}: ${fmtMoney(r.amount)} for ${fmtPct(r.shareSold)}` });
  }
  // DESIGN.md 0: the tournament builds the second floor by itself, so only the asset records it
  for (const a of state.assets) {
    if (a.kind === 'secondFloor' && !markers.some((m) => m.kind === 'upstairs' && m.day === a.boughtDay)) {
      markers.push({ day: a.boughtDay, kind: 'upstairs', label: UPSTAIRS_LABEL });
    }
  }
  markers.sort((a, b) => a.day - b.day);
  return { points: points(state), markers };
}
