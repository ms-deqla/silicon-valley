/**
 * DESIGN.md 18: the coach. One test per rule on hand-built states (createGame + mutate), the
 * card rules on real cards, "advice is always dispatchable" over the scripted tournament round
 * of test/unit-tournament.test.ts (its helper copied here), a round played by following the
 * coach exactly, and determinism (same state → same advice).
 *
 * test/setup.ts switches the full engine on for the suite; the coach is a tournament feature,
 * so beforeEach puts the published ruleset back. Tests that need the full engine say so.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { CONFIG, RULES, advanceDay, advise, adviseCard, canDispatch, createGame, dispatch, ledger, selectors as S } from '../src/sim';
import type { Action, Advice, Card, GameState, Role } from '../src/sim';
import * as tournament from '../src/sim/tournament';
import * as events from '../src/sim/events';
import { openKnock } from '../src/sim/capital';
import { useFullEngine, useTournamentRules } from './setup';

const D = CONFIG.time.daysPerMonth;
const A = CONFIG.assets.catalogue;
const E = CONFIG.events;
const FAR = 1_000_000;
/** the round: 30 game months (DESIGN.md 0) */
const ROUND_MONTHS = 30;

beforeEach(() => {
  useTournamentRules();
});

// ---------------------------------------------------------------- helpers

/** A fresh game with the scheduled knock and event pushed away, so only the tested rule moves anything. */
function game(seed = 3): GameState {
  const s = createGame(seed);
  s.schedule.nextKnockDay = FAR;
  s.schedule.nextEventDay = FAR;
  return s;
}

/** Dispatch through the public API and insist it went through. */
function act(s: GameState, action: Action): void {
  const v = dispatch(s, action);
  expect(v.ok, `${action.type}: ${v.reason ?? ''}`).toBe(true);
}

/** +$100k per call through the ledger (booked as financing). */
function fund(s: GameState, times: number): void {
  for (let i = 0; i < times; i++) act(s, { type: 'debug', op: 'cash' });
}

const hire = (role: Role): Action => ({ type: 'hireRole', role });

/** The Playbook's first move done: an engineer on day 0 and a first feature, so rule 2 is behind us. */
function started(seed = 3): GameState {
  const s = game(seed);
  act(s, hire('product'));
  s.features = 1;
  return s;
}

function addCustomers(s: GameState, n: number): void {
  const price = S.smbPrice(s);
  for (let i = 0; i < n; i++) {
    s.customers.push({ id: `c${s.nextId++}`, kind: 'smb', joinedDay: s.day, monthlyPrice: price, contractValue: 0, contractEndDay: null, noRenew: false, servedShare: 1 });
  }
}

function addProspect(s: GameState, value = CONFIG.customers.enterpriseDeal): void {
  s.prospects.push({ id: `pr${s.nextId++}`, arrivedDay: s.day, expiresDay: s.day + CONFIG.customers.prospectWaitDays, value, repId: null, progress: 0 });
}

/** Cash as the engine would set it, then the hint the coach gives for it. */
function withCash(s: GameState, cash: number): Advice {
  s.cash = cash;
  return advise(s);
}

function openCard(s: GameState): Card {
  expect(s.card).not.toBeNull();
  return s.card as Card;
}

/** The card advice, checked to be dispatchable (the task's rule for every advice). */
function cardChoice(s: GameState): string {
  const card = openCard(s);
  const advice = adviseCard(s, card);
  expect(advice).not.toBeNull();
  if (!advice) return '';
  expect(canDispatch(s, { type: 'card', choiceId: advice.choiceId })).toEqual({ ok: true });
  // advise() wraps the same recommendation as a dispatchable card action
  const a = advise(s);
  expect(a.action).toEqual({ type: 'card', choiceId: advice.choiceId });
  expect(a.reason).toBe(advice.reason);
  expect(a.urgency).toBe('now');
  expect(a.target).toBeNull();
  return advice.choiceId;
}

function expectHire(a: Advice, role: Role, urgency: Advice['urgency']): void {
  expect(a.action).toEqual({ type: 'hireRole', role });
  expect(a.target).toBe(role);
  expect(a.urgency).toBe(urgency);
  expect(a.label.length).toBeGreaterThan(0);
}

function expectWatch(a: Advice): void {
  expect(a.action).toBeNull();
  expect(a.label).toBe('Watch the lobby and the strip.');
  expect(a.urgency).toBe('idea');
  expect(a.target).toBeNull();
}

// ---------------------------------------------------------------- rule 1: cards

describe('rule 1: an open card gets the card advice (DESIGN 18)', () => {
  describe('investor knock', () => {
    it('take when runway < 6 months, with the months in the reason', () => {
      const s = started();
      s.cash = 4 * RULES.hire.product.salary; // 4 months of the engineer's pay, nothing else to pay
      act(s, { type: 'debug', op: 'knock' });
      expect(openCard(s).kind).toBe('knock');
      expect(S.runwayMonths(s)).toBeCloseTo(4, 6);
      expect(cardChoice(s)).toBe('equity');
      expect(adviseCard(s, openCard(s))?.reason).toBe('4 months of cash left.');
      expect(advise(s).label).toBe('Take it');
    });

    it('take when the share sold ≤ 15% and at least 6 game months remain', () => {
      const s = started();
      fund(s, 2);
      act(s, { type: 'debug', op: 'knock' });
      const card = openCard(s);
      expect(S.runwayMonths(s) ?? Infinity).toBeGreaterThanOrEqual(6);
      card.data.share = 0.12;
      card.data.amount = 50_000;
      expect(cardChoice(s)).toBe('equity');
      const reason = adviseCard(s, card)?.reason ?? '';
      expect(reason).toContain('12%');
      expect(reason).toContain('$50k');
      expect(reason).toContain(`${ROUND_MONTHS} months remain`);
    });

    it('decline when fewer than 4 game months remain, measured to the end the shell projects', () => {
      const s = started();
      fund(s, 2);
      act(s, { type: 'debug', op: 'knock' });
      const card = openCard(s);
      card.data.share = 0.12;
      s.schedule.roundEndDay = s.day + 3 * D;
      expect(cardChoice(s)).toBe('decline');
      expect(adviseCard(s, card)?.reason).toBe('Only 3 months remain: money that arrives now cannot be used.');
      expect(advise(s).label).toBe('Decline');
      // with 5 months left the cheap-money rule needs 6, nothing else matches: still a decline
      s.schedule.roundEndDay = s.day + 5 * D;
      expect(cardChoice(s)).toBe('decline');
    });

    it('decline when the share sold > 30% with runway > 8 months', () => {
      const s = started();
      fund(s, 2);
      act(s, { type: 'debug', op: 'knock' });
      const card = openCard(s);
      card.data.share = 0.35;
      card.data.amount = 90_000;
      expect(S.runwayMonths(s) ?? Infinity).toBeGreaterThan(8);
      expect(cardChoice(s)).toBe('decline');
      const reason = adviseCard(s, card)?.reason ?? '';
      expect(reason).toContain('35% is too much for $90k');
      expect(reason).toMatch(/months of cash/);
    });

    it('declines what is neither needed nor cheap (stop 8: take money you can spend, decline the rest)', () => {
      const s = started();
      fund(s, 2);
      act(s, { type: 'debug', op: 'knock' });
      const card = openCard(s);
      card.data.share = 0.2;
      expect(cardChoice(s)).toBe('decline');
      expect(adviseCard(s, card)?.reason).toMatch(/^20% for .* is more than you need: you have [\d.]+ months of cash\.$/);
    });

    it('a short runway is checked first: the money is taken even in the last months', () => {
      const s = started();
      s.cash = 4 * RULES.hire.product.salary;
      s.schedule.roundEndDay = s.day + 2 * D;
      act(s, { type: 'debug', op: 'knock' });
      expect(cardChoice(s)).toBe('equity');
    });

    it('when the equity choice is greyed out the only open choice is advised, and it is dispatchable', () => {
      const s = started();
      s.cash = 4 * RULES.hire.product.salary;
      act(s, { type: 'debug', op: 'knock' });
      const card = openCard(s);
      const equity = card.choices.find((c) => c.id === 'equity');
      expect(equity).toBeDefined();
      if (!equity) return;
      equity.disabled = true;
      equity.reason = 'Nothing to raise against: the company is worth too little';
      expect(canDispatch(s, { type: 'card', choiceId: 'equity' }).ok).toBe(false);
      expect(cardChoice(s)).toBe('decline');
      expect(adviseCard(s, card)?.reason).toBe('Take equity is not on the table (nothing to raise against: the company is worth too little): Not now is the only move.');
    });
  });

  describe('lifeline', () => {
    it('take when cash < 0 or runway < 2 months ("or the bank closes you"), else decline', () => {
      const s = started();
      const card = openKnock(s, true);
      expect(card?.kind).toBe('desperation');
      if (!card) return;

      s.cash = -5_000;
      expect(cardChoice(s)).toBe('equity');
      expect(adviseCard(s, card)?.reason).toBe('The bank balance is −$5k: take it or the bank closes you.');

      s.cash = 1.6 * RULES.hire.product.salary;
      expect(S.runwayMonths(s)).toBeCloseTo(1.6, 6);
      expect(cardChoice(s)).toBe('equity');
      expect(adviseCard(s, card)?.reason).toBe('1.6 months of cash left: take it or the bank closes you.');

      s.cash = 100_000;
      expect(cardChoice(s)).toBe('decline');
      expect(adviseCard(s, card)?.reason).toContain('you can reach the buzzer without giving up');
    });
  });

  describe('events', () => {
    it('late payer: press when cash < 3 months of costs, else wait', () => {
      const s = started();
      ledger.bookEnterpriseDeal(s, 'cust', 30_000, CONFIG.finance.terms);
      const card = events.openEvent(s, 'latePayer');
      expect(card?.eventType).toBe('latePayer');
      const costs = S.monthlyCosts(s).total;
      expect(costs).toBe(RULES.hire.product.salary);

      s.cash = 3 * costs - 1;
      expect(cardChoice(s)).toBe('press');
      expect(advise(s).label).toBe('Press them');
      expect(adviseCard(s, openCard(s))?.reason).toContain('$30k matters more than the renewal');

      s.cash = 3 * costs;
      expect(cardChoice(s)).toBe('wait');
      expect(advise(s).label).toBe('Wait');
      const reason = adviseCard(s, openCard(s))?.reason ?? '';
      expect(reason).toContain(`${E.latePayerDefault * 100}% chance of a write-off`);
      expect(reason).toContain(`${E.pressNoRenew * 100}% chance of losing the renewal`);
    });

    it('press coverage: push when features ≥ 3 and cash > $25k, else enjoy it', () => {
      const s = started();
      const card = events.openEvent(s, 'press');
      expect(card?.eventType).toBe('press');

      s.features = 3;
      s.cash = 30_000;
      expect(cardChoice(s)).toBe('push');
      expect(advise(s).label).toBe('Pay for the push');
      expect(adviseCard(s, openCard(s))?.reason).toContain(`×${E.prMult} visitors for ${E.pressDays} days`);

      s.features = 2;
      expect(cardChoice(s)).toBe('enjoy');
      expect(adviseCard(s, openCard(s))?.reason).toContain('Only 2 features');

      s.features = 3;
      s.cash = 25_000;
      expect(cardChoice(s)).toBe('enjoy');
      expect(adviseCard(s, openCard(s))?.reason).toContain('too little to spend $10k');
    });

    it('outage: fix when customers lost × average monthly price × months left > the fix cost', () => {
      const s = started();
      addCustomers(s, 20);
      const card = events.openEvent(s, 'outage');
      expect(card?.eventType).toBe('outage');
      const lost = Math.round(20 * E.outageLoss);
      const price = S.smbPrice(s);
      expect(lost * price * ROUND_MONTHS).toBeGreaterThan(E.outageFix);
      expect(cardChoice(s)).toBe('fix');
      expect(advise(s).label).toBe('Pay the fix');
      expect(adviseCard(s, openCard(s))?.reason).toContain(`${lost} customers at $${price} a month for the ${ROUND_MONTHS} months left`);

      // one month left: the customers at stake are worth less than the fix
      s.schedule.roundEndDay = s.day + D;
      expect(lost * price).toBeLessThan(E.outageFix);
      expect(cardChoice(s)).toBe('ride');
      expect(advise(s).label).toBe('Ride it out');

      // the full engine has no round: months left are infinite, the customers always outweigh the fix
      useFullEngine();
      s.schedule.roundEndDay = null;
      expect(cardChoice(s)).toBe('fix');
      expect(adviseCard(s, openCard(s))?.reason).toContain('are worth more than');
    });

    it('a card kind without a rule gets null, and advise() then says to answer it', () => {
      useFullEngine();
      const s = started();
      addCustomers(s, 5);
      const card = events.openEvent(s, 'competitor');
      expect(card?.eventType).toBe('competitor');
      if (!card) return;
      expect(adviseCard(s, card)).toBeNull();
      const a = advise(s);
      expect(a.action).toBeNull();
      expect(a.label).toBe('Answer the card');
      expect(a.urgency).toBe('now');

      const maturity: Card = { id: 'm', kind: 'maturity', title: 'The loan is due', body: '', choices: [], data: {}, createdDay: s.day };
      expect(adviseCard(s, maturity)).toBeNull();
    });
  });
});

// ---------------------------------------------------------------- rules 2–11

describe('rules 2–11 on the board (DESIGN 18, first match wins)', () => {
  it('rule 2: no features and no engineer → hire an engineer (now)', () => {
    const s = game();
    const a = advise(s);
    expectHire(a, 'product', 'now');
    expect(a.label).toBe('Hire an engineer');
    expect(a.reason).toContain(`an engineer at $${RULES.hire.product.salary / 1000}k a month`);
    expect(a.reason).toMatch(/alone the first one ships in about \d+ days/);
    expect(canDispatch(s, a.action as Action)).toEqual({ ok: true });

    // the hire the cash cannot carry is never advised: the rule falls through
    s.cash = RULES.hire.product.salary + tournament.setupCost(s, 'product') - 1;
    expect(canDispatch(s, hire('product')).ok).toBe(false);
    expect(advise(s).action).toBeNull();
  });

  it('rule 3: a prospect waits, no rep, cash covers 3 months of the new run-rate → hire a rep (now)', () => {
    const s = started();
    addProspect(s);
    const runRate = S.monthlyCosts(s).total + RULES.hire.sales.salary + tournament.roomRentForHire(s, 'sales');
    const left = s.cash - tournament.setupCost(s, 'sales');
    expect(tournament.roomRentForHire(s, 'sales')).toBe(CONFIG.rooms.size[RULES.roomSize].rent);
    expect(left).toBeGreaterThanOrEqual(3 * runRate);

    const a = advise(s);
    expectHire(a, 'sales', 'now');
    expect(a.label).toBe('Hire a rep');
    expect(a.reason).toBe(`A $${CONFIG.customers.enterpriseDeal / 1000}k prospect is waiting in the lobby and you have ${(left / runRate).toFixed(1)} months of cash after the hire.`);

    // the cash rule: enough for the hire itself, not for three months of the new run-rate
    s.cash = 3 * runRate + tournament.setupCost(s, 'sales') - 1;
    expect(canDispatch(s, hire('sales'))).toEqual({ ok: true });
    expect(advise(s).action).not.toEqual(hire('sales'));

    // a rep already hired: the prospect is theirs
    s.cash = 50_000;
    act(s, hire('sales'));
    expect(advise(s).action).not.toEqual(hire('sales'));
  });

  it('rule 4: servers short and cash ≥ price → buy a server (now)', () => {
    const s = started();
    addCustomers(s, CONFIG.assets.customersPerServer);
    expect(S.serversShort(s)).toBe(1);
    const a = advise(s);
    expect(a.action).toEqual({ type: 'buyAsset', kind: 'server' });
    expect(a.urgency).toBe('now');
    expect(a.target).toBe('server');
    expect(a.label).toBe('Buy a server');
    expect(a.reason).toBe(`${CONFIG.assets.customersPerServer} customers on 0 servers (you need 1): each missing one is a ${CONFIG.assets.outageChancePerMissingServer * 100}% chance a month of losing ${CONFIG.assets.outageChurn * 100}% of them.`);
    expect(canDispatch(s, a.action as Action)).toEqual({ ok: true });

    // short of the price the rule falls through (nothing else to do: the subscribers cover the costs)
    expect(withCash(s, A.server.price - 1).action).toBeNull();
    act(s, { type: 'debug', op: 'cash' });
    act(s, { type: 'buyAsset', kind: 'server' });
    expect(advise(s).action).not.toEqual({ type: 'buyAsset', kind: 'server' });
  });

  it('rule 5: customers ≥ 10 and no support agent, cash rule → hire support (soon)', () => {
    const s = started();
    addCustomers(s, 9);
    expectWatch(advise(s));
    addCustomers(s, 1);
    const a = advise(s);
    expectHire(a, 'support', 'soon');
    expect(a.label).toBe('Hire a support agent');
    expect(a.reason).toContain('10 customers and nobody answering their tickets');
    expect(a.reason).toContain(`${Math.round((CONFIG.customers.churnBase + CONFIG.customers.churnUnserved) * 100)}% of them leave every month instead of ${Math.round(CONFIG.customers.churnBase * 100)}%`);
    expect(a.reason).toMatch(/you have [\d.]+ months of cash after the hire/);
    // the cash rule
    expect(withCash(s, RULES.hire.support.salary + tournament.setupCost(s, 'support')).action).toBeNull();
  });

  it('rule 6: features ≥ 3 and no marketer, cash rule → hire a marketer (soon)', () => {
    const s = started();
    s.features = CONFIG.ui.marketingHintFeatures - 1;
    expectWatch(advise(s));
    s.features = CONFIG.ui.marketingHintFeatures;
    const a = advise(s);
    expectHire(a, 'marketing', 'soon');
    expect(a.label).toBe('Hire a marketer');
    expect(a.reason).toContain(`${CONFIG.ui.marketingHintFeatures} features but only about ${Math.round(S.visitorsPerMonth(s))} visitors a month`);
    expect(a.reason).toMatch(/a marketer brings about \d+ more/);
    expect(withCash(s, RULES.hire.marketing.salary + tournament.setupCost(s, 'marketing')).action).toBeNull();
  });

  it('rule 7: customers above what the agents keep served (about 120 each) → another agent (soon)', () => {
    const s = started();
    act(s, hire('support'));
    fund(s, 1);
    addCustomers(s, 130);
    act(s, { type: 'buyAsset', kind: 'server' });
    act(s, { type: 'buyAsset', kind: 'server' });
    expect(S.serversShort(s)).toBe(0);
    s.cash = 90_000; // under the $100k of rules 8 and 9
    // one fresh agent serves 15 × output tickets a month, a customer raises 0.3: about 128 customers (DESIGN 18 stop 6: "about 120")
    const perAgent = (CONFIG.customers.ticketsPerAgentOutput * RULES.hire.support.skill * (CONFIG.people.outputMoraleBase + CONFIG.people.morale.start / CONFIG.people.outputMoraleDivisor)) / CONFIG.customers.ticketsPerCustomerPerMonth;
    expect(perAgent).toBeGreaterThan(120);
    expect(perAgent).toBeLessThan(130);
    const a = advise(s);
    expectHire(a, 'support', 'soon');
    expect(a.label).toBe('Hire another agent');
    expect(a.reason).toContain(`130 customers for 1 agent: one keeps about ${Math.round(perAgent)} served`);

    // at or under the capacity nothing is asked
    s.customers.splice(0, 10);
    expectWatch(advise(s));
  });

  it('rule 7 never fires without an agent: the first one comes from rule 5 at 10 customers', () => {
    const s = started();
    addCustomers(s, 5);
    expectWatch(advise(s));
  });

  it('rule 8: cash > $100k, a rep hired, no demo room → build the demo room (idea)', () => {
    const s = started();
    act(s, hire('sales'));
    s.features = CONFIG.ui.marketingHintFeatures;
    act(s, hire('marketing'));
    expect(advise(s).action).toBeNull(); // under $100k: nothing to do
    fund(s, 2);
    const a = advise(s);
    expect(a.action).toEqual({ type: 'buyDemoRoom' });
    expect(a.urgency).toBe('idea');
    expect(a.target).toBe('demo');
    expect(a.label).toBe('Build the demo room');
    expect(a.reason).toContain(`for a one-off $${A.demoRoom.price / 1000}k`);
    expect(a.reason).toContain(`in the bank and a rep closing`);
    expect(canDispatch(s, a.action as Action)).toEqual({ ok: true });

    // without a rep the demo room is not suggested
    act(s, { type: 'fireRole', role: 'sales' });
    expect(advise(s).action).not.toEqual({ type: 'buyDemoRoom' });
  });

  it('rule 9: cash > $100k → another engineer, then another marketer (idea), up to the second of each', () => {
    const s = started();
    act(s, hire('sales'));
    s.features = CONFIG.ui.marketingHintFeatures;
    act(s, hire('marketing'));
    fund(s, 3);
    act(s, { type: 'buyDemoRoom' });

    let a = advise(s);
    expectHire(a, 'product', 'idea');
    expect(a.label).toBe('Hire another engineer');
    expect(a.reason).toMatch(/the team ships a feature every \d+ days; another engineer makes it \d+ days/);
    act(s, hire('product'));

    a = advise(s);
    expectHire(a, 'marketing', 'idea');
    expect(a.label).toBe('Hire another marketer');
    expect(a.reason).toMatch(/another marketer brings about \d+ more/);
    act(s, hire('marketing'));

    // two of each: the Playbook's growth is done, the money stays in the bank
    expect(tournament.headcount(s, 'product')).toBe(2);
    expect(tournament.headcount(s, 'marketing')).toBe(2);
    expect(s.cash).toBeGreaterThan(100_000);
    expectWatch(advise(s));
  });

  it('rule 9 offers no marketer before there are features to sell: an engineer instead, then nothing', () => {
    const s = started(); // one feature, one engineer, no marketer
    fund(s, 2);
    const a = advise(s);
    expectHire(a, 'product', 'idea');
    act(s, hire('product'));
    expectWatch(advise(s));
    // with three features the first marketer is rule 6's (soon), not rule 9's
    s.features = CONFIG.ui.marketingHintFeatures;
    expectHire(advise(s), 'marketing', 'soon');
  });

  it('rule 10: runway < 2 months and no card → hold on (now, no action)', () => {
    const s = started();
    s.cash = 1.8 * RULES.hire.product.salary;
    expect(S.runwayMonths(s)).toBeCloseTo(1.8, 6);
    const a = advise(s);
    expect(a.action).toBeNull();
    expect(a.label).toBe('Hold on');
    expect(a.reason).toBe("1.8 months of cash left: a lifeline comes if the bank runs dry. Don't hire.");
    expect(a.urgency).toBe('now');
    expect(a.target).toBeNull();
  });

  it('rule 11: otherwise, watch the lobby and the strip (idea, no action)', () => {
    const s = started();
    const a = advise(s);
    expectWatch(a);
    const cash = (CONFIG.start.cash - A.desk.price - A.laptop.price) / 1000;
    expect(a.reason).toBe(`0 customers, 1 feature, $${cash}k in the bank: nothing needs you right now.`);
  });

  it('after the buzzer or a game over there is nothing to advise', () => {
    const s = started();
    act(s, { type: 'timeUp' });
    const a = advise(s);
    expect(a.action).toBeNull();
    expect(a.label).toBe('The round is over.');
  });
});

// ---------------------------------------------------------------- over a round

/** Every advice the coach gives on this state is one the sim accepts; the card advice too. */
function checkAdvice(s: GameState): void {
  const a = advise(s);
  expect(a.label.length, `day ${s.day}`).toBeGreaterThan(0);
  expect(['now', 'soon', 'idea']).toContain(a.urgency);
  if (a.action) expect(canDispatch(s, a.action), `day ${s.day}: ${a.label}`).toEqual({ ok: true });
  if (s.card) {
    const c = adviseCard(s, s.card);
    expect(c, `day ${s.day}: ${s.card.kind} ${s.card.eventType ?? ''}`).not.toBeNull();
    if (c) expect(canDispatch(s, { type: 'card', choiceId: c.choiceId }), `day ${s.day}`).toEqual({ ok: true });
  }
}

/**
 * The scripted round of test/unit-tournament.test.ts: hires in all four departments, a marketer
 * let go, servers when short, the demo room, every knock taken, every event answered with its
 * first choice, the buzzer at the end. Only tournament actions (DESIGN.md 0).
 */
function plan(s: GameState): Action[] {
  const card = s.card;
  if (card) {
    if (card.kind === 'knock' || card.kind === 'desperation') return [{ type: 'card', choiceId: 'equity' }, { type: 'card', choiceId: 'decline' }];
    const first = card.choices.find((c) => !c.disabled);
    return first ? [{ type: 'card', choiceId: first.id }] : [];
  }
  const month = S.monthIndex(s.day);
  const count = (role: Role): number => tournament.headcount(s, role);
  const out: Action[] = [];
  if (count('product') < 1) out.push(hire('product'));
  if (s.prospects.length > 0 && count('sales') < 1) out.push(hire('sales'));
  if (month >= 3 && month < 9 && count('marketing') < 1 && s.cash > 60_000) out.push(hire('marketing'));
  if (month >= 9 && count('marketing') > 0) out.push({ type: 'fireRole', role: 'marketing' });
  if (s.customers.length >= 10 && count('support') < 1 && s.cash > 40_000) out.push(hire('support'));
  if (S.serversShort(s) > 0) out.push({ type: 'buyAsset', kind: 'server' });
  if (!S.hasDemoRoom(s) && s.cash > 90_000) out.push({ type: 'buyDemoRoom' });
  if (month >= 12 && count('product') < 2 && s.cash > 80_000) out.push(hire('product'));
  return out;
}

function playRound(seed: number): GameState {
  const s = createGame(seed);
  let stalls = 0;
  while (s.status === 'playing' && s.day < ROUND_MONTHS * D) {
    checkAdvice(s);
    for (const a of plan(s)) if (canDispatch(s, a).ok) dispatch(s, a);
    const before = s.day;
    advanceDay(s);
    stalls = s.day === before ? stalls + 1 : 0;
    expect(stalls, `the clock stalled on day ${s.day}: ${s.card?.title ?? 'no card'}`).toBeLessThan(8);
  }
  for (let i = 0; s.status === 'playing' && s.card && i < 8; i++) {
    checkAdvice(s);
    for (const a of plan(s)) if (canDispatch(s, a).ok) dispatch(s, a);
  }
  if (s.status === 'playing') act(s, { type: 'timeUp' });
  return s;
}

/** A round played by following the coach exactly: every card answered as adviseCard says, every advised action taken the day it is given. */
function coachRound(seed: number): GameState {
  const s = createGame(seed);
  let stalls = 0;
  while (s.status === 'playing' && s.day < ROUND_MONTHS * D) {
    for (let i = 0; i < 8 && s.card; i++) {
      const c = adviseCard(s, s.card);
      expect(c, `day ${s.day}: ${s.card.kind}`).not.toBeNull();
      if (!c) return s;
      act(s, { type: 'card', choiceId: c.choiceId });
    }
    for (let i = 0; i < 4; i++) {
      const a = advise(s);
      if (!a.action) break;
      act(s, a.action);
    }
    const before = s.day;
    advanceDay(s);
    stalls = s.day === before ? stalls + 1 : 0;
    expect(stalls, `the clock stalled on day ${s.day}: ${s.card?.title ?? 'no card'}`).toBeLessThan(8);
  }
  for (let i = 0; s.status === 'playing' && s.card && i < 8; i++) {
    const c = adviseCard(s, s.card);
    if (!c) break;
    act(s, { type: 'card', choiceId: c.choiceId });
  }
  if (s.status === 'playing') act(s, { type: 'timeUp' });
  return s;
}

describe('over a round', () => {
  it.each([1, 2, 3])('seed %i: the advice is always dispatchable over the scripted 30-month round', (seed) => {
    const s = playRound(seed);
    expect(s.status).toBe('sold');
    expect(s.day).toBe(ROUND_MONTHS * D);
  }, 30_000);

  it.each([1, 2, 3])('seed %i: a player who follows the coach exactly builds the Playbook team and sells at the buzzer', (seed) => {
    const s = coachRound(seed);
    expect(s.status).toBe('sold');
    expect(s.day).toBe(ROUND_MONTHS * D);
    expect(s.result?.score ?? 0).toBeGreaterThan(0);
    for (const role of RULES.roles) expect(tournament.headcount(s, role), role).toBeGreaterThanOrEqual(1);
    expect(tournament.headcount(s, 'product')).toBeLessThanOrEqual(2);
    expect(tournament.headcount(s, 'marketing')).toBeLessThanOrEqual(2);
    expect(S.hasDemoRoom(s)).toBe(true);
    expect(s.rounds.length).toBeGreaterThan(0);
    expect(s.actions.every((a) => a.action.type !== 'debug')).toBe(true);
  }, 30_000);

  it('the same state always gets the same advice: twice over, on a copy, and from a fresh game on the seed', () => {
    const s = createGame(7);
    let checked = 0;
    while (s.status === 'playing' && s.day < 12 * D) {
      for (const a of plan(s)) if (canDispatch(s, a).ok) dispatch(s, a);
      const first = advise(s);
      expect(advise(s)).toEqual(first);
      const copy = JSON.parse(JSON.stringify(s)) as GameState;
      expect(advise(copy)).toEqual(first);
      if (s.card) {
        const card = adviseCard(s, s.card);
        expect(adviseCard(s, s.card)).toEqual(card);
        expect(adviseCard(copy, copy.card as Card)).toEqual(card);
      }
      checked += 1;
      advanceDay(s);
    }
    expect(checked).toBeGreaterThan(300);
    expect(advise(createGame(7))).toEqual(advise(createGame(7)));
    expect(advise(createGame(7))).toEqual(advise(createGame(7)));
  });
});
