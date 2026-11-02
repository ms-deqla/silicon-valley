/**
 * DESIGN.md section 11: each event's two choices have exactly their documented effect,
 * eligibility and scheduling rules hold, and the books still reconcile after a write-off.
 *
 * staff.fire and customers.loseCustomers may still be stubs: the tests assert what the
 * events module owns and note where the rest depends on those modules.
 */
import { describe, expect, it } from 'vitest';
import { advanceDay, advanceTo, closeMonth, createGame, dispatch } from '../src/sim/game';
import * as events from '../src/sim/events';
import * as L from '../src/sim/ledger';
import * as S from '../src/sim/selectors';
import { CONFIG } from '../src/sim/config';
import { EVENT_TYPES } from '../src/sim/types';
import type { Archetype, Asset, Card, Customer, EventType, GameState, Invoice, Person, Quirk, Role } from '../src/sim/types';

const E = CONFIG.events;
const FAR = 1_000_000;

// ---------------------------------------------------------------- helpers

/**
 * A hand-built game at `day`: the clock is set, not ticked, so the other modules add no
 * visitors, features or cash of their own, and the scheduled event and knock are pushed away.
 */
function game(seed = 7, day = 180): GameState {
  const s = createGame(seed);
  s.schedule.nextEventDay = FAR;
  s.schedule.nextKnockDay = FAR;
  s.day = day;
  expect(s.card).toBeNull();
  expect(s.customers).toHaveLength(0);
  return s;
}

function addPerson(s: GameState, role: Role, archetype: Archetype, quirk: Quirk, baseSalary: number, name = `${archetype} ${role}`): Person {
  const p: Person = {
    id: `p${s.nextId++}`, name, role, archetype, quirk,
    skill: CONFIG.people.skill[archetype][1], baseSalary, morale: CONFIG.people.morale.start,
    roomId: 'garage', hiredDay: s.day, lastRaiseDay: s.day, raisePending: false,
    raiseRequestedDay: null, raiseGrantedDay: null, raiseRefusedDay: null, founder: false, hasLaptop: true,
  };
  s.people.push(p);
  return p;
}

function addSmbCustomers(s: GameState, n: number): void {
  for (let i = 0; i < n; i++) {
    const c: Customer = {
      id: `c${s.nextId++}`, kind: 'smb', joinedDay: s.day, monthlyPrice: S.smbPrice(s), contractValue: 0,
      contractEndDay: null, noRenew: false, servedShare: 1,
    };
    s.customers.push(c);
  }
}

/** An enterprise customer with an open invoice, booked through the ledger like a real deal. */
function addEnterprise(s: GameState, amount: number): { customer: Customer; invoice: Invoice } {
  const customer: Customer = {
    id: `c${s.nextId++}`, kind: 'enterprise', joinedDay: s.day, monthlyPrice: amount / 12, contractValue: amount,
    contractEndDay: s.day + CONFIG.customers.enterpriseContractMonths * CONFIG.time.daysPerMonth, noRenew: false, servedShare: 1,
  };
  s.customers.push(customer);
  const invoice = L.bookEnterpriseDeal(s, customer.id, amount, S.invoiceTermsDays(s));
  return { customer, invoice };
}

function addServer(s: GameState): Asset {
  const cfg = CONFIG.assets.catalogue.server;
  const a: Asset = { id: `a${s.nextId++}`, kind: 'server', cost: cfg.price, bookValue: cfg.price, lifeMonths: cfg.lifeMonths, boughtDay: s.day, roomId: null };
  s.assets.push(a);
  return a;
}

function open(s: GameState, type: EventType): Card {
  const card = events.openEvent(s, type);
  expect(card).not.toBeNull();
  expect(s.card).toBe(card);
  return card as Card;
}

/** Answer the open card through the real dispatcher. */
function choose(s: GameState, choiceId: string): void {
  const v = dispatch(s, { type: 'card', choiceId });
  expect(v.ok).toBe(true);
  expect(s.card).toBeNull();
}

function lastLog(s: GameState): string {
  return s.log[s.log.length - 1]?.text ?? '';
}

function expectReconciled(s: GameState): void {
  closeMonth(s);
  const closed = s.history[s.history.length - 1];
  expect(L.checkIdentities(closed)).toEqual([]);
}

// ---------------------------------------------------------------- scheduling

describe('events: scheduling', () => {
  it('schedules the first event in [180, 270] and fires nothing before it', () => {
    const s = createGame(3);
    s.schedule.nextKnockDay = FAR; // investor knocks are capital.ts's business
    const first = s.schedule.nextEventDay;
    expect(first).toBeGreaterThanOrEqual(E.firstDay[0]);
    expect(first).toBeLessThanOrEqual(E.firstDay[1]);
    advanceTo(s, first - 1);
    expect(s.day).toBe(first - 1);
    expect(s.card).toBeNull();
    advanceDay(s);
    expect(s.day).toBe(first);
    expect(s.card?.kind).toBe('event');
    expect(s.schedule.nextEventDay).toBeGreaterThanOrEqual(first + E.everyDays[0]);
    expect(s.schedule.nextEventDay).toBeLessThanOrEqual(first + E.everyDays[1]);
  });

  it('opens an event card on nextEventDay and reschedules [90, 180] days later', () => {
    const s = game(3, 200);
    s.schedule.nextEventDay = s.day;
    const before = s.log.length;
    events.dailyEvents(s);
    expect(s.card).not.toBeNull();
    expect(s.card?.kind).toBe('event');
    expect(s.card?.createdDay).toBe(s.day);
    expect(s.log.length).toBe(before + 1);
    expect(s.schedule.nextEventDay).toBeGreaterThanOrEqual(s.day + E.everyDays[0]);
    expect(s.schedule.nextEventDay).toBeLessThanOrEqual(s.day + E.everyDays[1]);
  });

  it('does nothing before nextEventDay', () => {
    const s = game(3, 200);
    s.schedule.nextEventDay = s.day + 1;
    events.dailyEvents(s);
    expect(s.card).toBeNull();
    expect(s.schedule.nextEventDay).toBe(s.day + 1);
  });

  it('does nothing (and does not reschedule) while a card is open', () => {
    const s = game(3, 200);
    const card = open(s, 'press');
    s.schedule.nextEventDay = s.day;
    events.dailyEvents(s);
    expect(s.card).toBe(card);
    expect(s.schedule.nextEventDay).toBe(s.day);
    expect(events.openEvent(s)).toBeNull();
    expect(events.openEvent(s, 'recession')).toBeNull();
  });

  it('pauses the clock while the card is open and resumes after the answer', () => {
    const s = createGame(11);
    s.schedule.nextKnockDay = FAR;
    advanceTo(s, 400);
    expect(s.card?.kind).toBe('event');
    const day = s.day;
    advanceDay(s);
    expect(s.day).toBe(day);
    choose(s, s.card!.choices[0].id);
    advanceDay(s);
    expect(s.day).toBe(day + 1);
  });

  it('the debug drawer can force an event', () => {
    const s = game(3, 200);
    expect(dispatch(s, { type: 'debug', op: 'event' }).ok).toBe(true);
    expect(s.card?.kind).toBe('event');
  });

  it('is deterministic: same seed → same card, same schedule', () => {
    const a = createGame(2024);
    const b = createGame(2024);
    a.schedule.nextKnockDay = FAR;
    b.schedule.nextKnockDay = FAR;
    advanceTo(a, 400);
    advanceTo(b, 400);
    expect(a.card?.kind).toBe('event');
    expect(JSON.stringify(a.card)).toBe(JSON.stringify(b.card));
    expect(a.schedule.nextEventDay).toBe(b.schedule.nextEventDay);
    expect(a.rng).toEqual(b.rng);
  });

  it('a long run through several events keeps every closed month reconciled', () => {
    const s = createGame(99);
    s.schedule.nextKnockDay = FAR;
    let answered = 0;
    let guard = 0;
    while (s.day < 1200 && s.status === 'playing' && guard++ < 50) {
      advanceTo(s, 1200);
      if (s.card) {
        expect(s.card.kind).toBe('event');
        // a founder-only company has no income to fund repeated $15k fixes: take the free option on outage/press, alternate elsewhere
        const free = s.card.eventType === 'outage' || s.card.eventType === 'press';
        choose(s, s.card.choices[free ? 1 : answered % 2].id);
        answered += 1;
      }
    }
    expect(s.day).toBe(1200);
    expect(answered).toBeGreaterThanOrEqual(3);
    for (const b of s.history) expect(L.checkIdentities(b)).toEqual([]);
  });
});

// ---------------------------------------------------------------- eligibility

describe('events: eligibility and weights', () => {
  it('a fresh company can only get press, competitor or recession', () => {
    const s = game();
    expect(events.eventWeights(s)).toEqual({ latePayer: 0, outage: 0, press: 1, competitor: 1, poach: 0, recession: 1 });
    expect(events.eligibleEvents(s)).toEqual(['press', 'competitor', 'recession']);
    expect(events.openEvent(s, 'latePayer')).toBeNull();
    expect(events.openEvent(s, 'outage')).toBeNull();
    expect(events.openEvent(s, 'poach')).toBeNull();
    expect(s.card).toBeNull();
  });

  it('latePayer needs an open invoice (weight 2) and targets the largest one', () => {
    const s = game();
    const small = addEnterprise(s, 20_000);
    const big = addEnterprise(s, 45_000);
    expect(events.eventWeights(s).latePayer).toBe(2);
    expect(events.latePayerTarget(s)?.id).toBe(big.invoice.id);
    const card = open(s, 'latePayer');
    expect(card.eventType).toBe('latePayer');
    expect(card.data.invoiceId).toBe(big.invoice.id);
    expect(card.data.customerId).toBe(big.customer.id);
    expect(card.body).toContain('$45k');
    choose(s, 'press');
    // an invoice already pushed back is picked last
    big.invoice.late = true;
    expect(events.latePayerTarget(s)?.id).toBe(small.invoice.id);
    L.collectInvoice(s, small.invoice);
    L.collectInvoice(s, big.invoice);
    expect(events.eventWeights(s).latePayer).toBe(0);
  });

  it('outage needs a customer and is weighted up when servers are short', () => {
    const s = game();
    expect(events.eventWeights(s).outage).toBe(0);
    addSmbCustomers(s, 10);
    expect(S.serversShort(s)).toBe(1);
    expect(events.eventWeights(s).outage).toBe(E.outageShortWeight);
    addServer(s);
    expect(S.serversShort(s)).toBe(0);
    expect(events.eventWeights(s).outage).toBe(1);
  });

  it('competitor is skipped while one is active, recession while one is active', () => {
    const s = game();
    s.effects.competitorUntilFeatures = s.features + E.competitorFeatures;
    expect(S.competitorActive(s)).toBe(true);
    expect(events.eventWeights(s).competitor).toBe(0);
    expect(events.openEvent(s, 'competitor')).toBeNull();
    s.features += E.competitorFeatures;
    expect(events.eventWeights(s).competitor).toBe(1);

    s.effects.recessionUntilDay = s.day + 1;
    expect(events.eventWeights(s).recession).toBe(0);
    expect(events.openEvent(s, 'recession')).toBeNull();
    s.effects.recessionUntilDay = s.day;
    expect(events.eventWeights(s).recession).toBe(1);
  });

  it('poach needs a non-founder senior or star and prefers mercenaries', () => {
    const s = game();
    addPerson(s, 'product', 'mid', 'loyal', 7_000);
    addPerson(s, 'product', 'junior', 'mercenary', 4_000);
    expect(events.eventWeights(s).poach).toBe(0);
    const senior = addPerson(s, 'product', 'senior', 'loyal', 11_000, 'Sara');
    expect(events.eventWeights(s).poach).toBe(1);
    expect(events.poachTargets(s).map((p) => p.id)).toEqual([senior.id]);
    const star = addPerson(s, 'sales', 'star', 'mercenary', 14_000, 'Max');
    expect(events.poachTargets(s).map((p) => p.id)).toEqual([star.id]);
    const card = open(s, 'poach');
    expect(card.data.personId).toBe(star.id);
    expect(card.title).toContain('Max');
  });

  it('the random pick only draws eligible events', () => {
    const s = game();
    const seen = new Set<EventType>();
    for (let i = 0; i < 200; i++) {
      const card = events.openEvent(s);
      expect(card).not.toBeNull();
      seen.add(card!.eventType!);
      s.card = null;
      s.effects.recessionUntilDay = 0; // undo the recession so it stays eligible
    }
    expect([...seen].sort()).toEqual(['competitor', 'press', 'recession']);
  });

  it('short servers make outages much likelier', () => {
    const draws = (short: boolean): number => {
      const s = game(21);
      addSmbCustomers(s, 10);
      if (!short) addServer(s);
      let outages = 0;
      for (let i = 0; i < 400; i++) {
        const card = events.openEvent(s);
        if (card?.eventType === 'outage') outages += 1;
        s.card = null;
        s.effects.recessionUntilDay = 0;
      }
      return outages;
    };
    const withShort = draws(true);
    const withEnough = draws(false);
    // weights 4 of 7 (≈57%) against 1 of 4 (25%) over 400 draws
    expect(withShort).toBeGreaterThan(withEnough * 1.5);
    expect(withEnough).toBeGreaterThan(40);
  });
});

// ---------------------------------------------------------------- card shape

describe('events: cards', () => {
  function everythingEligible(seed: number): GameState {
    const s = game(seed);
    addEnterprise(s, 33_000);
    addSmbCustomers(s, 20);
    addPerson(s, 'product', 'senior', 'loyal', 11_000, 'Sara');
    return s;
  }

  it('every event builds a two-choice card with the numbers in plain words, logs on open and on answer', () => {
    for (const type of EVENT_TYPES) {
      for (const choiceId of events.EVENT_CHOICES[type]) {
        const s = everythingEligible(5);
        const logBefore = s.log.length;
        const card = open(s, type);
        expect(card.kind).toBe('event');
        expect(card.eventType).toBe(type);
        expect(card.id).toMatch(/^ev\d+$/);
        expect(card.createdDay).toBe(s.day);
        expect(card.title.length).toBeGreaterThan(0);
        expect(card.body.length).toBeGreaterThan(20);
        expect(card.speaker).toBeTruthy();
        expect(card.quote).toBeTruthy();
        expect(card.choices).toHaveLength(2);
        expect(card.choices.map((c) => c.id)).toEqual([...events.EVENT_CHOICES[type]]);
        for (const c of card.choices) {
          expect(c.label.length).toBeGreaterThan(0);
          expect(c.detail.length).toBeGreaterThan(0);
          expect(c.disabled).toBeFalsy();
        }
        expect(s.log.length).toBe(logBefore + 1);
        choose(s, choiceId);
        expect(s.log.length).toBeGreaterThanOrEqual(logBefore + 2);
        expect(s.log[s.log.length - 1].day).toBe(s.day);
      }
    }
  });

  it('rejects an unknown choice through the dispatcher and clears the card on a direct resolve', () => {
    const s = game();
    const card = open(s, 'press');
    expect(dispatch(s, { type: 'card', choiceId: 'nope' }).ok).toBe(false);
    expect(s.card).toBe(card);
    events.resolveEventCard(s, card, 'nope');
    expect(s.card).toBeNull();
    expect(s.cash).toBe(CONFIG.start.cash);
  });

  it('uses config numbers in the card text', () => {
    const s = game();
    addSmbCustomers(s, 10);
    const outage = open(s, 'outage');
    expect(outage.choices[0].detail).toContain('$15k');
    expect(outage.body).toContain('15%');
    choose(s, 'fix');
    const press = open(s, 'press');
    expect(press.choices[0].detail).toContain('$10k');
    expect(press.choices[0].detail).toContain('×3');
    expect(press.choices[1].detail).toContain('×2');
    choose(s, 'enjoy');
  });
});

// ---------------------------------------------------------------- 1. late payer

describe('event 1: big customer pays late', () => {
  const AMOUNT = 33_000;

  function setup(seed: number): { s: GameState; customer: Customer; invoice: Invoice } {
    const s = game(seed);
    const { customer, invoice } = addEnterprise(s, AMOUNT);
    open(s, 'latePayer');
    return { s, customer, invoice };
  }

  it('"wait": due +60 days and marked late, or (15%) written off as bad debt with cash untouched', () => {
    let defaults = 0;
    let delays = 0;
    for (let seed = 1; seed <= 300; seed++) {
      const { s, customer, invoice } = setup(seed);
      const cash = s.cash;
      const due = invoice.dueDay;
      const ar = L.openReceivables(s);
      choose(s, 'wait');
      expect(s.cash).toBe(cash);
      if (invoice.status === 'writtenOff') {
        defaults += 1;
        expect(invoice.settledDay).toBe(s.day);
        expect(s.book.pnl.badDebt).toBe(AMOUNT);
        expect(L.openReceivables(s)).toBe(ar - AMOUNT);
        expect(customer.noRenew).toBe(true);
        expect(lastLog(s)).toContain('went under');
        expect(lastLog(s)).toContain('$33k written off');
        expect(s.visuals.some((v) => v.t === 'toast' && v.tone === 'bad')).toBe(true);
      } else {
        delays += 1;
        expect(invoice.status).toBe('open');
        expect(invoice.dueDay).toBe(due + E.latePayerDelayDays);
        expect(invoice.late).toBe(true);
        expect(s.book.pnl.badDebt).toBe(0);
        expect(customer.noRenew).toBe(false);
        expect(lastLog(s)).toContain('days late');
      }
    }
    expect(defaults).toBeGreaterThan(0);
    expect(delays).toBeGreaterThan(0);
    // ≈15% of 300, loosely
    expect(defaults).toBeGreaterThan(15);
    expect(defaults).toBeLessThan(90);
  });

  it('finance staff halve the default chance', () => {
    const s = game();
    expect(events.latePayerDefaultChance(s)).toBeCloseTo(E.latePayerDefault);
    addPerson(s, 'finance', 'mid', 'loyal', 7_000);
    expect(S.roleOutput(s, 'finance')).toBeGreaterThan(0);
    expect(events.latePayerDefaultChance(s)).toBeCloseTo(E.latePayerDefault * CONFIG.finance.defaultHalving);
    addEnterprise(s, AMOUNT);
    const card = open(s, 'latePayer');
    expect(card.data.defaultChance).toBeCloseTo(0.075);
    expect(card.choices[0].detail).toContain('7.5%');
  });

  it('"press them": paid in 10 days, 50% chance the customer will not renew', () => {
    let noRenew = 0;
    let renew = 0;
    for (let seed = 1; seed <= 200; seed++) {
      const { s, customer, invoice } = setup(seed);
      const cash = s.cash;
      choose(s, 'press');
      expect(invoice.status).toBe('open');
      expect(invoice.dueDay).toBe(s.day + E.pressPayDays);
      expect(invoice.late).toBe(false);
      expect(s.cash).toBe(cash);
      expect(s.book.pnl.badDebt).toBe(0);
      if (customer.noRenew) {
        noRenew += 1;
        expect(lastLog(s)).toContain('will not renew');
      } else {
        renew += 1;
        expect(lastLog(s)).not.toContain('will not renew');
      }
    }
    expect(noRenew).toBeGreaterThan(50);
    expect(renew).toBeGreaterThan(50);
  });

  it('"press them" never un-sets an existing noRenew flag', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const { s, customer } = setup(seed);
      customer.noRenew = true;
      choose(s, 'press');
      expect(customer.noRenew).toBe(true);
    }
  });

  it('the books reconcile at the close after a write-off (bad debt in profit, receivable gone)', () => {
    let checked = 0;
    for (let seed = 1; seed <= 300 && checked < 3; seed++) {
      const { s, invoice } = setup(seed);
      choose(s, 'wait');
      if (invoice.status !== 'writtenOff') continue;
      checked += 1;
      const cashBefore = s.cash;
      expectReconciled(s);
      const closed = s.history[s.history.length - 1];
      expect(closed.pnl.badDebt).toBe(AMOUNT);
      expect(closed.pnl.enterpriseRevenue).toBe(AMOUNT);
      expect(closed.arEnd - closed.arStart).toBe(0);
      expect(closed.cashEnd).toBe(cashBefore);
      // bad debt cancels against ΔReceivables; nothing was bought or sold, so only non-cash depreciation separates the bars
      expect(closed.cf.capex).toBe(0);
      expect(closed.profit - closed.fcf).toBeCloseTo(-closed.pnl.depreciation, 5);
    }
    expect(checked).toBe(3);
  });

  it('the books reconcile at the close after a delay (revenue booked, cash still owed)', () => {
    const { s, invoice } = setup(4);
    choose(s, 'wait');
    if (invoice.status === 'writtenOff') return;
    expectReconciled(s);
    const closed = s.history[s.history.length - 1];
    expect(closed.arEnd).toBe(AMOUNT);
    // the contract sits in profit while the cash is still owed (plus non-cash depreciation)
    expect(closed.profit - closed.fcf).toBeCloseTo(AMOUNT - closed.pnl.depreciation, 5);
  });

  it('a settled invoice resolves harmlessly', () => {
    const { s, invoice } = setup(4);
    L.collectInvoice(s, invoice);
    choose(s, 'wait');
    expect(invoice.status).toBe('paid');
    expect(lastLog(s)).toContain('already settled');
  });
});

// ---------------------------------------------------------------- 2. outage

describe('event 2: server outage', () => {
  it('"emergency fix": −$15k event cost in both bars, customers kept, books reconcile', () => {
    const s = game();
    addSmbCustomers(s, 30);
    open(s, 'outage');
    const cash = s.cash;
    choose(s, 'fix');
    expect(s.cash).toBe(cash - E.outageFix);
    expect(s.book.pnl.eventCosts).toBe(E.outageFix);
    expect(s.book.cf.eventCosts).toBe(E.outageFix);
    expect(s.customers).toHaveLength(30);
    expect(lastLog(s)).toContain('$15k');
    expectReconciled(s);
  });

  it('"ride it out": no cost, customers.loseCustomers(15%) and an outage on the floor', () => {
    const s = game();
    addSmbCustomers(s, 30);
    open(s, 'outage');
    const cash = s.cash;
    choose(s, 'ride');
    expect(s.cash).toBe(cash);
    expect(s.book.pnl.eventCosts).toBe(0);
    expect(s.visuals.some((v) => v.t === 'outage' && v.day === s.day)).toBe(true);
    expect(lastLog(s)).toContain('rode out');
    // the exact count is customers.loseCustomers' contract (15% of 30 ≈ 4–5; 0 while it is a stub)
    expect(s.customers.length).toBeLessThanOrEqual(30);
    expect(s.customers.length).toBeGreaterThanOrEqual(25);
    expectReconciled(s);
  });
});

// ---------------------------------------------------------------- 3. press

describe('event 3: press coverage', () => {
  it('"PR push": −$10k, visitors ×3 for 30 days', () => {
    const s = game();
    const base = S.visitorsPerMonth(s);
    open(s, 'press');
    const cash = s.cash;
    choose(s, 'push');
    expect(s.cash).toBe(cash - E.prPush);
    expect(s.book.pnl.eventCosts).toBe(E.prPush);
    expect(s.book.cf.eventCosts).toBe(E.prPush);
    expect(s.effects.pressUntilDay).toBe(s.day + E.pressDays);
    expect(s.effects.pressMult).toBe(E.prMult);
    expect(S.pressActive(s)).toBe(true);
    expect(S.visitorsPerMonth(s)).toBeCloseTo(base * E.prMult);
    expectReconciled(s);
  });

  it('"enjoy it": free, visitors ×2 for 30 days', () => {
    const s = game();
    const base = S.visitorsPerMonth(s);
    open(s, 'press');
    const cash = s.cash;
    choose(s, 'enjoy');
    expect(s.cash).toBe(cash);
    expect(s.book.pnl.eventCosts).toBe(0);
    expect(s.effects.pressUntilDay).toBe(s.day + E.pressDays);
    expect(s.effects.pressMult).toBe(E.pressMult);
    expect(S.visitorsPerMonth(s)).toBeCloseTo(base * E.pressMult);
  });

  it('the multiplier expires exactly on pressUntilDay (dailyEffects resets it once)', () => {
    const s = game(3, 200);
    const base = S.visitorsPerMonth(s);
    open(s, 'press');
    choose(s, 'push');
    const until = s.effects.pressUntilDay;
    advanceTo(s, until - 1);
    expect(s.effects.pressMult).toBe(E.prMult);
    expect(S.visitorsPerMonth(s)).toBeCloseTo(base * E.prMult);
    advanceDay(s);
    expect(s.day).toBe(until);
    expect(S.pressActive(s)).toBe(false);
    expect(s.effects.pressMult).toBe(1);
    expect(S.visitorsPerMonth(s)).toBeCloseTo(base);
    const faded = s.log.filter((l) => l.text.includes('press coverage has faded'));
    expect(faded).toHaveLength(1);
    expect(faded[0].day).toBe(until);
    events.dailyEffects(s);
    expect(s.log.filter((l) => l.text.includes('press coverage has faded'))).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- 4. competitor

describe('event 4: competitor next door', () => {
  it('"out-build them": conversion ×0.75 until two more features ship', () => {
    const s = game();
    s.features = 5;
    const conv = S.smbConversion(s);
    const close = S.enterpriseCloseProb(s);
    const price = S.priceMult(s);
    open(s, 'competitor');
    choose(s, 'outbuild');
    expect(s.effects.competitorUntilFeatures).toBe(5 + E.competitorFeatures);
    expect(S.competitorActive(s)).toBe(true);
    expect(S.smbConversion(s)).toBeCloseTo(conv * E.competitorMult);
    expect(S.enterpriseCloseProb(s)).toBeCloseTo(close * E.competitorMult);
    expect(S.priceMult(s)).toBeCloseTo(price);
    expect(s.effects.priceCutUntilDay).toBe(0);
    s.features += 1;
    expect(S.competitorActive(s)).toBe(true);
    s.features += 1;
    expect(S.competitorActive(s)).toBe(false);
    expect(S.smbConversion(s)).toBeGreaterThan(conv);
  });

  it('"cut prices": no conversion penalty, all prices ×0.85 for 180 days', () => {
    const s = game();
    s.features = 5;
    const conv = S.smbConversion(s);
    const price = S.priceMult(s);
    const smb = S.smbPrice(s);
    const deal = S.enterpriseDealValue(s);
    open(s, 'competitor');
    choose(s, 'cut');
    expect(s.effects.priceCutUntilDay).toBe(s.day + E.priceCutDays);
    expect(s.effects.competitorUntilFeatures).toBeNull();
    expect(S.competitorActive(s)).toBe(false);
    expect(S.priceCutActive(s)).toBe(true);
    expect(S.smbConversion(s)).toBeCloseTo(conv);
    expect(S.priceMult(s)).toBeCloseTo(price * E.priceCut);
    expect(S.smbPrice(s)).toBeCloseTo(smb * E.priceCut);
    expect(S.enterpriseDealValue(s)).toBeCloseTo(deal * E.priceCut);
    s.day = s.effects.priceCutUntilDay;
    expect(S.priceCutActive(s)).toBe(false);
    expect(S.priceMult(s)).toBeCloseTo(price);
    events.dailyEffects(s);
    expect(lastLog(s)).toContain('price cut has ended');
  });
});

// ---------------------------------------------------------------- 5. poach

describe('event 5: star employee poached', () => {
  it('"counter-offer": +30% base salary, rounded to $100, they stay', () => {
    const s = game();
    const sara = addPerson(s, 'product', 'senior', 'loyal', 11_000, 'Sara');
    open(s, 'poach');
    const cash = s.cash;
    choose(s, 'counter');
    expect(sara.baseSalary).toBe(14_300);
    expect(S.personById(s, sara.id)).toBe(sara);
    expect(s.cash).toBe(cash);
    expect(s.book.pnl.severance).toBe(0);
    expect(lastLog(s)).toContain('Sara stays');
    expect(lastLog(s)).toContain('$14.3k');
    expect(S.monthlySalaries(s)).toBe(14_300);
  });

  it('rounds the counter-offer to $100 with salary noise', () => {
    const s = game();
    const max = addPerson(s, 'sales', 'star', 'loyal', 11_370, 'Max');
    expect(events.counterOfferSalary(11_370)).toBe(14_800);
    expect(events.counterOfferSalary(14_000)).toBe(18_200);
    open(s, 'poach');
    choose(s, 'counter');
    expect(max.baseSalary).toBe(14_800);
  });

  it('"let them go": staff.fire(…, "poached"), no severance, salary untouched', () => {
    const s = game();
    const sara = addPerson(s, 'product', 'senior', 'loyal', 11_000, 'Sara');
    const card = open(s, 'poach');
    expect(card.data.personId).toBe(sara.id);
    const cash = s.cash;
    const logBefore = s.log.length;
    choose(s, 'letgo');
    expect(s.cash).toBe(cash);
    expect(s.book.pnl.severance).toBe(0);
    expect(s.book.cf.severance).toBe(0);
    expect(sara.baseSalary).toBe(11_000);
    // staff.fire's contract: the person is removed, a 'leave' visual with reason 'poached', a log line
    expect(S.personById(s, sara.id)).toBeUndefined();
    expect(s.visuals.some((v) => v.t === 'leave' && v.personId === sara.id && v.reason === 'poached')).toBe(true);
    expect(s.log.slice(logBefore).some((l) => l.text.includes('Sara'))).toBe(true);
    expectReconciled(s);
  });
});

// ---------------------------------------------------------------- 6. recession

describe('event 6: recession', () => {
  it('starts when the card opens: visitors ×0.6 and recession active for 180 days, whatever the choice', () => {
    for (const choiceId of events.EVENT_CHOICES.recession) {
      const s = game();
      const base = S.visitorsPerMonth(s);
      open(s, 'recession');
      expect(s.effects.recessionUntilDay).toBe(s.day + E.recessionDays);
      expect(S.recessionActive(s)).toBe(true);
      choose(s, choiceId);
      expect(s.effects.recessionUntilDay).toBe(s.day + E.recessionDays);
      expect(S.recessionActive(s)).toBe(true);
      expect(S.visitorsPerMonth(s)).toBeCloseTo(base * E.recessionVisitors);
      expect(s.cash).toBe(CONFIG.start.cash);
    }
  });

  it('"hold the line": nothing else changes', () => {
    const s = game();
    const sara = addPerson(s, 'product', 'senior', 'loyal', 11_000, 'Sara');
    const founderMorale = s.people[0].morale;
    open(s, 'recession');
    choose(s, 'hold');
    expect(s.effects.salaryCutUntilDay).toBe(0);
    expect(sara.morale).toBe(CONFIG.people.morale.start);
    expect(s.people[0].morale).toBe(founderMorale);
    expect(S.salaryOf(s, sara)).toBe(11_000);
    expect(lastLog(s)).toContain('held the line');
  });

  it('"tighten": salaries −10% for 180 days and morale −20 for everyone, clamped at 0', () => {
    const s = game();
    const sara = addPerson(s, 'product', 'senior', 'loyal', 11_000, 'Sara');
    const low = addPerson(s, 'support', 'junior', 'coffee', 4_000, 'Lee');
    low.morale = 10;
    const founder = s.people[0];
    const founderMorale = founder.morale;
    open(s, 'recession');
    choose(s, 'tighten');
    expect(s.effects.salaryCutUntilDay).toBe(s.day + E.recessionDays);
    expect(sara.morale).toBe(CONFIG.people.morale.start + E.tightenMorale);
    expect(low.morale).toBe(0);
    expect(founder.morale).toBe(Math.max(0, founderMorale + E.tightenMorale));
    expect(sara.baseSalary).toBe(11_000);
    expect(S.salaryOf(s, sara)).toBeCloseTo(11_000 * (1 - E.tightenCut));
    expect(S.salaryOf(s, low)).toBeCloseTo(4_000 * (1 - E.tightenCut));
    expect(S.salaryOf(s, founder)).toBe(0);
    expect(S.monthlySalaries(s)).toBeCloseTo(15_000 * (1 - E.tightenCut));
    expect(lastLog(s)).toContain('Belt tightened');
    // the cut and the recession end together
    s.day = s.effects.salaryCutUntilDay;
    expect(S.salaryOf(s, sara)).toBe(11_000);
    expect(S.recessionActive(s)).toBe(false);
    events.dailyEffects(s);
    const texts = s.log.slice(-2).map((l) => l.text).join(' ');
    expect(texts).toContain('recession is over');
    expect(texts).toContain('Salaries are back');
  });

  it('the daily accrual charges the cut salary while the cut is on and the books reconcile', () => {
    const s = game(3, 200);
    addPerson(s, 'product', 'senior', 'loyal', 12_000, 'Sara');
    open(s, 'recession');
    choose(s, 'tighten');
    advanceTo(s, 210);
    expect(s.day).toBe(210);
    const closed = s.history[s.history.length - 1];
    expect(closed.closed).toBe(true);
    // 10 days of 12_000 × 0.9 / 30, in both bars (the founder is free)
    const expected = 10 * (12_000 * (1 - E.tightenCut)) / CONFIG.time.daysPerMonth;
    expect(closed.cf.salaries).toBeCloseTo(expected, 5);
    expect(closed.pnl.salaries).toBeCloseTo(expected, 5);
    for (const b of s.history) expect(L.checkIdentities(b)).toEqual([]);
  });
});
