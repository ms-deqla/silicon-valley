/**
 * The coach (DESIGN.md 18): the single best next action with a reason, and the
 * recommendation on an open card. Advice only; nothing here mutates state and nothing
 * here rolls dice, so the same state always gets the same advice (DESIGN.md 0: the coach
 * is "the same for every player"). Every advised action is one canDispatch accepts.
 */
import type { Action, Card, GameState, Role } from './types';
import { CONFIG, RULES } from './config';
import * as S from './selectors';
import { canDispatch } from './game';
import { headcount, roomRentForHire, setupCost, upstairsCostForHire } from './tournament';
import { EVENT_CHOICES } from './events';
import { fmtMoney as money, fmtPct } from './hints';

export type Urgency = 'now' | 'soon' | 'idea';

export interface Advice {
  /** what to dispatch, or null when the advice is to wait */
  action: Action | null;
  /** short imperative, e.g. "Hire a rep" */
  label: string;
  /** one sentence with the numbers behind it */
  reason: string;
  urgency: Urgency;
  /** the board row or asset the advice points at, for the pulse */
  target: Role | 'server' | 'demo' | null;
}

export interface CardAdvice {
  choiceId: string;
  /** one sentence, e.g. "you have 2 months of cash left" */
  reason: string;
}

const D = CONFIG.time.daysPerMonth;
const E = CONFIG.events;

/**
 * The coach's thresholds (DESIGN.md 18, "Coach rules"): CONFIG.coach, which the Playbook and
 * the scripted tPlayer read too, plus the two the engine already names, reused here so the
 * coach and the mechanic it describes can never drift.
 */
const COACH = {
  ...CONFIG.coach,
  /** rule 1 (lifeline) and rule 10: the runway the lifeline itself keys on (DESIGN.md 10) */
  lifelineRunwayMonths: CONFIG.capital.desperationRunwayMonths,
  /** rule 1 (press coverage) and rule 6: features worth bringing visitors to, where the hint line says "Open Marketing" (DESIGN.md 13) */
  sellableFeatures: CONFIG.ui.marketingHintFeatures,
};

/** The choice ids of an investor card (capital.ts). */
const EQUITY = 'equity';
const DECLINE = 'decline';

// ---------------------------------------------------------------- helpers

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** The cards' percent format without a bare ".0": "24%", "4.1%", "8%". */
function pct(share: number): string {
  return fmtPct(share).replace(/\.0%$/, '%');
}

/** "4.2", "2", "0.5" (one decimal, no trailing zero). */
function months(x: number): string {
  return Math.max(0, x).toFixed(1).replace(/\.0$/, '');
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function lowerFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

/**
 * Game months left in the round, measured the way the knock blackout is (DESIGN.md 0): to the
 * day the shell projects, else to the nominal round; infinite without a round (the full engine).
 */
function monthsLeft(state: GameState): number {
  const nominal = RULES.roundMonths === null ? null : RULES.roundMonths * D;
  const end = state.schedule.roundEndDay ?? nominal;
  if (end === null) return Infinity;
  return Math.max(0, (end - state.day) / D);
}

/** Runway in months; infinite when the company is not burning cash. */
function runway(state: GameState): number {
  return S.runwayMonths(state) ?? Infinity;
}

function runwayText(state: GameState): string {
  const r = S.runwayMonths(state);
  return r === null ? 'you are not burning cash' : `you have ${months(r)} months of cash`;
}

/** Output of the department's fixed hire on day one (DESIGN.md 6: skill × (0.5 + morale ÷ 200), with a laptop). */
function hireOutput(role: Role): number {
  const spec = RULES.hire[role];
  return spec.skill * (CONFIG.people.outputMoraleBase + CONFIG.people.morale.start / CONFIG.people.outputMoraleDivisor);
}

/** DESIGN.md 18 rule 7 (and stop 6): the customers one fresh agent keeps served, about 120: tickets an agent serves ÷ tickets a customer raises. */
function customersPerAgent(): number {
  return (CONFIG.customers.ticketsPerAgentOutput * hireOutput('support')) / CONFIG.customers.ticketsPerCustomerPerMonth;
}

/** Days until the next feature ships at this many feature points a month (DESIGN.md 8). */
function daysToFeature(points: number, outputPerMonth: number): number {
  return outputPerMonth > 0 ? Math.ceil((points / outputPerMonth) * D) : Infinity;
}

interface Cover {
  ok: boolean;
  /** months of the new run-rate the cash left after the setup covers */
  months: number;
}

/**
 * The cash rule (DESIGN.md 18, as DESIGN.md 16's careful player): the cash left after the setup
 * (desk and laptop, and the second floor when this hire would build it, DESIGN.md 0 "Space (v2)")
 * covers coverMonths of the new run-rate, today's costs plus the salary and the rent of the room
 * the hire would open.
 */
function hireCover(state: GameState, role: Role): Cover {
  const runRate = S.monthlyCosts(state).total + RULES.hire[role].salary + roomRentForHire(state, role);
  const left = state.cash - setupCost(state, role) - upstairsCostForHire(state, role);
  return { ok: left >= COACH.coverMonths * runRate, months: runRate > 0 ? left / runRate : Infinity };
}

function coverText(cover: Cover): string {
  return Number.isFinite(cover.months) ? `you have ${months(cover.months)} months of cash after the hire` : 'the hire costs you nothing a month';
}

/** A hire advice, or null when canDispatch would refuse it (the rule then falls through). */
function hireAdvice(state: GameState, role: Role, urgency: Urgency, label: string, reason: string): Advice | null {
  const action: Action = { type: 'hireRole', role };
  if (!canDispatch(state, action).ok) return null;
  return { action, label, reason, urgency, target: role };
}

// ---------------------------------------------------------------- the rules (DESIGN.md 18)

/** Rule 2: no features and no engineer → hire an engineer (now). */
function firstEngineer(state: GameState): Advice | null {
  if (state.features > 0 || headcount(state, 'product') > 0) return null;
  const points = Math.max(0, S.featureCost(state) - state.featurePoints);
  const alone = S.roleOutput(state, 'product');
  const daysAlone = daysToFeature(points, alone);
  const daysWith = daysToFeature(points, alone + hireOutput('product'));
  const wait = Number.isFinite(daysAlone) ? `alone the first one ships in about ${plural(daysAlone, 'day')}, ` : '';
  return hireAdvice(state, 'product', 'now', 'Hire an engineer',
    `No features yet and nothing sells without one: ${wait}with an engineer at ${money(RULES.hire.product.salary)} a month in about ${plural(daysWith, 'day')}.`);
}

/** Rule 3: a prospect waits, no rep, the cash rule holds → hire a rep (now). */
function repForProspect(state: GameState): Advice | null {
  if (state.prospects.length === 0 || headcount(state, 'sales') > 0) return null;
  const cover = hireCover(state, 'sales');
  if (!cover.ok) return null;
  let best = 0;
  for (const p of state.prospects) best = Math.max(best, p.value);
  return hireAdvice(state, 'sales', 'now', 'Hire a rep',
    `A ${money(best)} prospect is waiting in the lobby and ${coverText(cover)}.`);
}

/** Rule 4: servers short and cash ≥ price → buy a server (now). */
function serverForLoad(state: GameState): Advice | null {
  if (S.serversShort(state) <= 0) return null;
  const action: Action = { type: 'buyAsset', kind: 'server' };
  if (state.cash < CONFIG.assets.catalogue.server.price || !canDispatch(state, action).ok) return null;
  const A = CONFIG.assets;
  return {
    action,
    label: 'Buy a server',
    reason: `${plural(state.customers.length, 'customer')} on ${plural(S.serversOwned(state), 'server')} (you need ${S.serversNeeded(state)}): `
      + `each missing one is a ${pct(A.outageChancePerMissingServer)} chance a month of losing ${pct(A.outageChurn)} of them.`,
    urgency: 'now',
    target: 'server',
  };
}

/** Rule 5: customers ≥ 10 and no support agent, the cash rule holds → hire support (soon). */
function firstSupport(state: GameState): Advice | null {
  if (state.customers.length < COACH.supportCustomers || headcount(state, 'support') > 0) return null;
  const cover = hireCover(state, 'support');
  if (!cover.ok) return null;
  return hireAdvice(state, 'support', 'soon', 'Hire a support agent',
    `${plural(state.customers.length, 'customer')} and nobody answering their tickets: ${pct(S.monthlySmbChurn(state, 0))} of them leave every month `
    + `instead of ${pct(S.monthlySmbChurn(state, 1))}, and ${coverText(cover)}.`);
}

/** Rule 6: features ≥ 3 and no marketer, the cash rule holds → hire a marketer (soon). */
function firstMarketer(state: GameState): Advice | null {
  if (state.features < COACH.sellableFeatures || headcount(state, 'marketing') > 0) return null;
  const cover = hireCover(state, 'marketing');
  if (!cover.ok) return null;
  const extra = CONFIG.marketing.visitorsPerOutput * hireOutput('marketing');
  return hireAdvice(state, 'marketing', 'soon', 'Hire a marketer',
    `${plural(state.features, 'feature')} but only about ${plural(Math.round(S.visitorsPerMonth(state)), 'visitor')} a month: `
    + `a marketer brings about ${Math.round(extra)} more, and ${coverText(cover)}.`);
}

/** Rule 7: customers > (about 120) × support agents → another agent (soon), under the cash rule. */
function moreSupport(state: GameState): Advice | null {
  const agents = headcount(state, 'support');
  if (agents === 0) return null;
  const per = customersPerAgent();
  if (state.customers.length <= per * agents) return null;
  const cover = hireCover(state, 'support');
  if (!cover.ok) return null;
  return hireAdvice(state, 'support', 'soon', 'Hire another agent',
    `${plural(state.customers.length, 'customer')} for ${plural(agents, 'agent')}: one keeps about ${Math.round(per)} served, `
    + `support is at ${pct(S.servedShareNow(state))} of tickets, and ${coverText(cover)}.`);
}

/** Rule 8: cash > $100k, a rep hired, no demo room → build the demo room (idea). */
function demoRoom(state: GameState): Advice | null {
  if (state.cash <= COACH.growthCash || headcount(state, 'sales') === 0 || S.hasDemoRoom(state)) return null;
  const action: Action = { type: 'buyDemoRoom' };
  if (!canDispatch(state, action).ok) return null;
  const deal = S.enterpriseDealValue(state);
  return {
    action,
    label: 'Build the demo room',
    reason: `${money(state.cash)} in the bank and a rep closing: enterprise deals grow from ${money(deal)} to `
      + `${money(deal * CONFIG.assets.demoRoomMult)} for a one-off ${money(CONFIG.assets.catalogue.demoRoom.price)}.`,
    urgency: 'idea',
    target: 'demo',
  };
}

function growthHire(state: GameState, role: Role): Advice | null {
  if (role === 'marketing') {
    const extra = CONFIG.marketing.visitorsPerOutput * hireOutput('marketing');
    return hireAdvice(state, 'marketing', 'idea', 'Hire another marketer',
      `${money(state.cash)} in the bank and about ${plural(Math.round(S.visitorsPerMonth(state)), 'visitor')} a month: another marketer brings about ${Math.round(extra)} more.`);
  }
  const output = S.roleOutput(state, 'product');
  const cost = S.featureCost(state);
  const now = daysToFeature(cost, output);
  const after = daysToFeature(cost, output + hireOutput('product'));
  return hireAdvice(state, 'product', 'idea', 'Hire another engineer',
    `${money(state.cash)} in the bank: the team ships a feature every ${plural(now, 'day')}; another engineer makes it ${plural(after, 'day')}.`);
}

/**
 * Rule 9: cash > $100k → another engineer, then another marketer (idea), alternating by count,
 * up to the second of each (the Playbook's "a second engineer, then a second marketer"; without
 * that cap every round raised would be spent on more hires). A marketer only once there are
 * features to sell (stop 4: marketing before that is wasted money); when the turn's department
 * cannot take the hire, the other one is offered.
 */
function growth(state: GameState): Advice | null {
  if (state.cash <= COACH.growthCash) return null;
  const engineers = headcount(state, 'product');
  const marketers = headcount(state, 'marketing');
  const wantEngineer = engineers < COACH.growthTeam;
  const wantMarketer = marketers < COACH.growthTeam && state.features >= COACH.sellableFeatures;
  const order: Role[] = [];
  if (wantEngineer && (engineers <= marketers || !wantMarketer)) order.push('product');
  if (wantMarketer) order.push('marketing');
  if (wantEngineer && !order.includes('product')) order.push('product');
  for (const role of order) {
    const advice = growthHire(state, role);
    if (advice) return advice;
  }
  return null;
}

/** Rule 10: runway < 2 months and no card → hold on (now, no action). */
function holdOn(state: GameState): Advice | null {
  const r = S.runwayMonths(state);
  if (r === null || r >= COACH.lifelineRunwayMonths) return null;
  return {
    action: null,
    label: 'Hold on',
    reason: `${months(r)} months of cash left: a lifeline comes if the bank runs dry. Don't hire.`,
    urgency: 'now',
    target: null,
  };
}

/** Rule 11: otherwise, watch. */
function watch(state: GameState): Advice {
  return {
    action: null,
    label: 'Watch the lobby and the strip.',
    reason: `${plural(state.customers.length, 'customer')}, ${plural(state.features, 'feature')}, ${money(state.cash)} in the bank: nothing needs you right now.`,
    urgency: 'idea',
    target: null,
  };
}

const RULES_2_TO_10: readonly ((state: GameState) => Advice | null)[] = [
  firstEngineer, repForProspect, serverForLoad, firstSupport, firstMarketer, moreSupport, demoRoom, growth, holdOn,
];

/** DESIGN.md 18, rules 1–11, first match wins. Never returns null. */
export function advise(state: GameState): Advice {
  if (state.status !== 'playing') return { action: null, label: 'The round is over.', reason: '', urgency: 'idea', target: null };
  // DESIGN.md 18 rule 1: a card is open → the card's advice (DESIGN.md 0: cards stop the game, not the clock)
  if (state.card) return cardAdvice(state, state.card);
  for (const rule of RULES_2_TO_10) {
    const advice = rule(state);
    if (advice) return advice;
  }
  return watch(state);
}

// ---------------------------------------------------------------- cards (rule 1)

const CHOICE_LABEL: Readonly<Record<string, string>> = {
  [EQUITY]: 'Take it',
  [DECLINE]: 'Decline',
  [EVENT_CHOICES.latePayer[0]]: 'Wait',
  [EVENT_CHOICES.latePayer[1]]: 'Press them',
  [EVENT_CHOICES.press[0]]: 'Pay for the push',
  [EVENT_CHOICES.press[1]]: 'Enjoy it',
  [EVENT_CHOICES.outage[0]]: 'Pay the fix',
  [EVENT_CHOICES.outage[1]]: 'Ride it out',
};

function cardAdvice(state: GameState, card: Card): Advice {
  const advice = adviseCard(state, card);
  if (!advice) return { action: null, label: 'Answer the card', reason: 'It stops your game, not the clock.', urgency: 'now', target: null };
  const label = CHOICE_LABEL[advice.choiceId] ?? card.choices.find((c) => c.id === advice.choiceId)?.label ?? 'Answer the card';
  return { action: { type: 'card', choiceId: advice.choiceId }, label, reason: advice.reason, urgency: 'now', target: null };
}

/** Is this choice one the player can take right now? Checked through canDispatch when the card is the open one. */
function isOpen(state: GameState, card: Card, choiceId: string): boolean {
  const choice = card.choices.find((c) => c.id === choiceId);
  if (!choice || choice.disabled) return false;
  return state.card !== card || canDispatch(state, { type: 'card', choiceId }).ok;
}

/** The recommended choice, or, when it is greyed out, the only choice left open; null when nothing can be chosen. */
function pickChoice(state: GameState, card: Card, choiceId: string, reason: string): CardAdvice | null {
  if (isOpen(state, card, choiceId)) return { choiceId, reason };
  const wanted = card.choices.find((c) => c.id === choiceId);
  const open = card.choices.find((c) => isOpen(state, card, c.id));
  if (!open) return null;
  const why = wanted?.reason ? ` (${lowerFirst(wanted.reason)})` : '';
  return { choiceId: open.id, reason: `${wanted?.label ?? choiceId} is not on the table${why}: ${open.label} is the only move.` };
}

function leftText(left: number): string {
  return Number.isFinite(left) ? `${months(left)} months remain to spend it` : 'there is time to spend it';
}

/**
 * Investor knock: take when runway < 6 months, or when the share sold ≤ 15% and at least 6 game
 * months remain; decline when fewer than 4 game months remain or the share sold > 30% with
 * runway > 8 months; otherwise decline (stop 8: take money you can spend inside the round,
 * decline the rest).
 */
function knockAdvice(state: GameState, card: Card): CardAdvice | null {
  const share = num(card.data.share);
  const amount = num(card.data.amount);
  const r = runway(state);
  const left = monthsLeft(state);
  // DESIGN.md 18 rule 1: cash below zero at a month-end close scores 0, so "would not reach the buzzer" wins over everything
  if (diesBeforeBuzzer(state)) {
    return pickChoice(state, card, EQUITY, `${months(r)} months of cash against ${months(left)} to the buzzer: without it you run out.`);
  }
  if (left < COACH.knockDeclineMonthsLeft) {
    return pickChoice(state, card, DECLINE, `Only ${months(left)} months remain: money that arrives now cannot be used.`);
  }
  if (r < COACH.knockTakeRunwayMonths) return pickChoice(state, card, EQUITY, `${months(r)} months of cash left.`);
  if (share <= COACH.knockCheapShare && left >= COACH.knockSpendMonthsLeft) {
    // cheap money is only worth its slice while there is something to buy with it (the Playbook: after the second investor, decline unless you can spend it)
    if (state.rounds.length < COACH.knocksTaken || state.cash + amount <= COACH.growthCash) {
      return pickChoice(state, card, EQUITY, `${pct(share)} for ${money(amount)} is cheap and ${leftText(left)}.`);
    }
    return pickChoice(state, card, DECLINE, `${money(state.cash)} in the bank and nothing left to buy: keep your ${pct(1 - share)}.`);
  }
  if (share > COACH.knockDearShare && r > COACH.knockDearRunwayMonths) {
    return pickChoice(state, card, DECLINE, `${pct(share)} is too much for ${money(amount)} when ${runwayText(state)}.`);
  }
  return pickChoice(state, card, DECLINE, `${pct(share)} for ${money(amount)} is more than you need: ${runwayText(state)}.`);
}

/** Lifeline (desperation / crisis knock): take when cash < 0 or runway < 2 months, else decline. */
function lifelineAdvice(state: GameState, card: Card): CardAdvice | null {
  const share = num(card.data.share);
  if (state.cash < 0) return pickChoice(state, card, EQUITY, `The bank balance is ${money(state.cash)}: take it or the bank closes you.`);
  const r = runway(state);
  // the bank only closes you at a month-end close with cash below zero; a short runway that outlasts the buzzer is not a crisis
  if (diesBeforeBuzzer(state)) return pickChoice(state, card, EQUITY, `${months(r)} months of cash against ${months(monthsLeft(state))} to the buzzer: take it or the bank closes you.`);
  return pickChoice(state, card, DECLINE, `${runwayText(state)}: you can reach the buzzer without giving up ${pct(share)}.`);
}

/** Cash runs out before the buzzer: the runway is shorter than the month-end closes still to come (infinite rounds never die this way). */
function diesBeforeBuzzer(state: GameState): boolean {
  const left = monthsLeft(state);
  if (!Number.isFinite(left)) return false;
  return runway(state) < Math.ceil(left);
}

/** Late payer: press when cash < 3 months of costs, else wait. */
function latePayerAdvice(state: GameState, card: Card): CardAdvice | null {
  const [wait, press] = EVENT_CHOICES.latePayer;
  const costs = S.monthlyCosts(state).total;
  const amount = num(card.data.amount);
  if (state.cash < COACH.coverMonths * costs) {
    return pickChoice(state, card, press,
      `${money(state.cash)} in the bank against ${money(costs)} a month of costs: the ${money(amount)} matters more than the renewal.`);
  }
  const cover = costs > 0 ? `${money(state.cash)} covers ${months(state.cash / costs)} months of costs` : `${money(state.cash)} in the bank and nothing to pay`;
  return pickChoice(state, card, wait,
    `${cover}: a ${pct(num(card.data.defaultChance))} chance of a write-off beats a ${pct(E.pressNoRenew)} chance of losing the renewal.`);
}

/** Press coverage: push when features ≥ 3 and cash > $25k, else enjoy it. */
function pressAdvice(state: GameState, card: Card): CardAdvice | null {
  const [push, enjoy] = EVENT_CHOICES.press;
  const features = state.features;
  if (features < COACH.sellableFeatures) {
    return pickChoice(state, card, enjoy, `Only ${plural(features, 'feature')}: extra visitors would not buy yet, so take the free ×${E.pressMult}.`);
  }
  if (state.cash <= COACH.pushCash) {
    return pickChoice(state, card, enjoy, `${money(state.cash)} in the bank is too little to spend ${money(E.prPush)} on a push: take the free ×${E.pressMult}.`);
  }
  return pickChoice(state, card, push,
    `${plural(features, 'feature')} to sell and ${money(state.cash)} in the bank: ×${E.prMult} visitors for ${E.pressDays} days beats ×${E.pressMult}, for ${money(E.prPush)}.`);
}

/** Outage: fix when customers lost × average monthly price × months left > the fix cost. */
function outageAdvice(state: GameState, card: Card): CardAdvice | null {
  const [fix, ride] = EVENT_CHOICES.outage;
  const n = state.customers.length;
  const lost = Math.round(n * E.outageLoss);
  let revenue = 0;
  for (const c of state.customers) revenue += c.monthlyPrice;
  const avg = n > 0 ? revenue / n : 0;
  const monthly = lost * avg;
  const left = monthsLeft(state);
  const atStake = monthly > 0 ? monthly * left : 0;
  const who = `${plural(lost, 'customer')} at ${money(avg)} a month`;
  if (atStake > E.outageFix) {
    const worth = Number.isFinite(left)
      ? `for the ${months(left)} months left are worth ${money(atStake)}, more than`
      : 'are worth more than';
    return pickChoice(state, card, fix, `${who} ${worth} the ${money(E.outageFix)} fix.`);
  }
  const worth = Number.isFinite(left) ? `for the ${months(left)} months left are worth ${money(atStake)}` : `are worth ${money(atStake)}`;
  return pickChoice(state, card, ride, `${who} ${worth}: less than the ${money(E.outageFix)} fix.`);
}

/** DESIGN.md 18, rule 1. Null when the card has no recommendation. */
export function adviseCard(state: GameState, card: Card): CardAdvice | null {
  switch (card.kind) {
    case 'knock': return knockAdvice(state, card);
    case 'desperation': return lifelineAdvice(state, card);
    case 'event':
      switch (card.eventType) {
        case 'latePayer': return latePayerAdvice(state, card);
        case 'press': return pressAdvice(state, card);
        case 'outage': return outageAdvice(state, card);
        default: return null;
      }
    default: return null;
  }
}
