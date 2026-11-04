/**
 * DESIGN.md 20: the post-mortem. Every takeaway is checked on a hand-built state whose
 * closed months, rounds, actions, customers and log lines are set by hand, so each number
 * in a detail sentence can be recomputed from CONFIG/RULES; the timeline on the same kind
 * of state; one smoke run through the real engine. takeaways() and timeline() are pure:
 * the state is snapshotted before and after.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { CONFIG, RULES, advanceDay, createGame, dispatch, ledger, selectors as S, takeaways, timeline } from '../src/sim';
import type { Action, GameState, Role, Round, RunExtras, Takeaway } from '../src/sim';
import { EVENT_CHOICES } from '../src/sim/events';
import { fmtMoney, fmtPct, fmtRate } from '../src/sim/hints';
import { useTournamentRules } from './setup';

const D = CONFIG.time.daysPerMonth;
const FAR = 1_000_000;
const NO_WAIT: RunExtras = { cardWaitMs: 0, practice: false };
/** DESIGN.md 20 (idle cash: cash above this and no hire); postmortem.ts keeps it until config.ts carries it */
const IDLE_CASH = 150_000;

beforeEach(() => {
  useTournamentRules();
});

// ---------------------------------------------------------------- helpers

/** A game at `day` with the scheduled cards pushed away; nothing is ticked. */
function game(day = 0, seed = 11): GameState {
  const s = createGame(seed);
  s.schedule.nextKnockDay = FAR;
  s.schedule.nextEventDay = FAR;
  s.day = day;
  return s;
}

interface MonthSpec {
  cashEnd?: number;
  valueEnd?: number;
  churned?: number;
  customersEnd?: number;
  featuresEnd?: number;
  r?: number;
  revenue?: number;
  salaries?: number;
  capex?: number;
  arEnd?: number;
}

/** Close months by hand from month 0: book m covers days [30m, 30m + 30) and closes on day 30m + 30, as the engine's do. */
function closeMonths(s: GameState, specs: MonthSpec[]): void {
  specs.forEach((spec, m) => {
    const b = ledger.newBook(s, m, m * D);
    b.closed = true;
    b.cashEnd = spec.cashEnd ?? s.cash;
    b.valueEnd = spec.valueEnd ?? 0;
    b.churned = spec.churned ?? 0;
    b.customersEnd = spec.customersEnd ?? 0;
    b.featuresEnd = spec.featuresEnd ?? 0;
    b.requiredReturnEnd = spec.r ?? CONFIG.valuation.base;
    b.pnl.smbRevenue = spec.revenue ?? 0;
    b.pnl.salaries = spec.salaries ?? 0;
    b.cf.capex = spec.capex ?? 0;
    b.arEnd = spec.arEnd ?? 0;
    s.history.push(b);
    s.valueHistory.push(b.valueEnd);
    if (s.valueHistory.length > CONFIG.valuation.historyMonths) s.valueHistory.shift();
  });
  s.book = ledger.newBook(s, specs.length, specs.length * D);
  s.day = Math.max(s.day, specs.length * D);
}

function months(n: number, spec: MonthSpec = {}): MonthSpec[] {
  return Array.from({ length: n }, () => ({ ...spec }));
}

function addCustomers(s: GameState, n: number, monthlyPrice: number): void {
  for (let i = 0; i < n; i++) {
    s.customers.push({ id: `c${s.nextId++}`, kind: 'smb', joinedDay: 0, monthlyPrice, contractValue: 0, contractEndDay: null, noRenew: false, servedShare: 1 });
  }
}

/** A round as capital.ts books it: pushed, and the founder's share diluted (DESIGN.md 10). */
function raise(s: GameState, day: number, amount: number, shareSold: number, desperate = false): Round {
  const r: Round = { day, amount, shareSold, preMoney: amount / shareSold - amount, postMoney: amount / shareSold, desperate, fund: 'Test Fund' };
  s.rounds.push(r);
  s.founderShare *= 1 - shareSold;
  return r;
}

function act(s: GameState, day: number, action: Action): void {
  s.actions.push({ day, action });
}

const hire = (role: Role): Action => ({ type: 'hireRole', role });
const card = (choiceId: string): Action => ({ type: 'card', choiceId });

function log(s: GameState, day: number, text: string): void {
  s.log.push({ day, text, tone: 'bad' });
}

function addServer(s: GameState, boughtDay: number): void {
  const c = CONFIG.assets.catalogue.server;
  s.assets.push({ id: `a${s.nextId++}`, kind: 'server', cost: c.price, bookValue: c.price, lifeMonths: c.lifeMonths, boughtDay, roomId: null });
}

function addSecondFloor(s: GameState, boughtDay: number): void {
  const c = CONFIG.assets.catalogue.secondFloor;
  s.assets.push({ id: `a${s.nextId++}`, kind: 'secondFloor', cost: c.price, bookValue: c.price, lifeMonths: c.lifeMonths, boughtDay, roomId: null });
  s.floors = 2;
}

function find(list: Takeaway[], title: string): Takeaway | undefined {
  return list.find((t) => t.title === title);
}

function titles(list: Takeaway[]): string[] {
  return list.map((t) => t.title);
}

/** Ten closed months of a small SMB business: churn in months 2 and 3, features reaching 3 in month 3 (index). */
function tenMonths(): MonthSpec[] {
  const customers = [0, 3, 6, 10, 15, 18, 20, 20, 20, 20];
  const features = [0, 1, 2, 3, 4, 5, 5, 6, 6, 7];
  return customers.map((customersEnd, m) => ({ customersEnd, featuresEnd: features[m], churned: m === 2 ? 2 : m === 3 ? 3 : 0 }));
}

// ---------------------------------------------------------------- nothing to say

describe('takeaways: a run with nothing to say', () => {
  it('returns no takeaway for a fresh game', () => {
    expect(takeaways(createGame(1), NO_WAIT)).toEqual([]);
  });

  it('returns no takeaway for a clean finished run: no rounds, no churn, no outage, marketing on time, cash below the idle line', () => {
    const s = game();
    closeMonths(s, months(6, { valueEnd: 300_000, cashEnd: 40_000, featuresEnd: 3 }));
    act(s, 0, hire('product'));
    act(s, 30, hire('marketing')); // features reached 3 at the close of day 30: the marketer came the same day
    s.status = 'sold';
    expect(takeaways(s, NO_WAIT)).toEqual([]);
  });
});

// ---------------------------------------------------------------- raised but unspent

describe('takeaway: raised but unspent (DESIGN 20)', () => {
  it('impact = unspent cash × the share sold; the detail carries the raise, the unspent cash and the pro-rata slice of the company', () => {
    const s = game();
    closeMonths(s, months(3, { valueEnd: 500_000 }));
    raise(s, 60, 100_000, 0.2);
    s.cash = 80_000;
    const t = find(takeaways(s, NO_WAIT), 'Raised but unspent');
    expect(t).toBeDefined();
    expect(t?.impact).toBeCloseTo(80_000 * 0.2, 6);
    expect(t?.detail).toBe(`You raised ${fmtMoney(100_000)} and ended with ${fmtMoney(80_000)} unspent: ${fmtPct(0.2 * 0.8)} of the company sold for cash you never used.`);
  });

  it('two rounds compound the share sold (1 − Π(1 − share)) and add the amounts', () => {
    const s = game();
    closeMonths(s, months(3, { valueEnd: 500_000 }));
    raise(s, 60, 100_000, 0.2);
    raise(s, 200, 100_000, 0.1);
    s.cash = 50_000;
    const sold = 1 - 0.8 * 0.9;
    const t = find(takeaways(s, NO_WAIT), 'Raised but unspent');
    expect(t?.impact).toBeCloseTo(50_000 * sold, 6);
    expect(t?.detail).toContain(`raised ${fmtMoney(200_000)}`);
    expect(t?.detail).toContain(`${fmtPct(sold * 0.25)} of the company`);
  });

  it('counts at most the amount raised as unspent', () => {
    const s = game();
    closeMonths(s, months(3, { valueEnd: 500_000 }));
    raise(s, 60, 100_000, 0.2);
    s.cash = 300_000;
    const t = find(takeaways(s, NO_WAIT), 'Raised but unspent');
    expect(t?.impact).toBeCloseTo(100_000 * 0.2, 6);
    expect(t?.detail).toContain(`${fmtMoney(100_000)} unspent`);
  });

  it('says nothing without a round, or when the cash is gone', () => {
    const s = game();
    closeMonths(s, months(3, { valueEnd: 500_000 }));
    s.cash = 80_000;
    expect(find(takeaways(s, NO_WAIT), 'Raised but unspent')).toBeUndefined();
    raise(s, 60, 100_000, 0.2);
    s.cash = -2_000;
    expect(find(takeaways(s, NO_WAIT), 'Raised but unspent')).toBeUndefined();
  });
});

// ---------------------------------------------------------------- cards left waiting

describe('takeaway: cards left waiting (DESIGN 0 and 20)', () => {
  const WAIT_2: RunExtras = { cardWaitMs: 40_000, practice: false };

  it('months lost = cardWaitMs ÷ (RULES.secondsPerMonth × 1000); a month is worth the stake spread over the months played when that beats the last month\'s move', () => {
    const s = game();
    closeMonths(s, [{ valueEnd: 200_000 }, { valueEnd: 260_000 }]);
    const t = find(takeaways(s, WAIT_2), 'Cards left waiting');
    const monthsLost = 40_000 / (RULES.secondsPerMonth * 1000);
    expect(monthsLost).toBe(2);
    // the last month added 60k; the stake of 260k over 2 months is 130k a month: the larger proxy wins
    expect(t?.impact).toBeCloseTo(2 * 130_000, 6);
    expect(t?.detail).toBe(`Cards waited 40 s: 2 game months lost. A month of your round was worth about ${fmtMoney(130_000)} of stake, so those months cost about ${fmtMoney(260_000)}.`);
  });

  it('the last month\'s move is the proxy when it is the larger: 100k → 400k is 300k a month against a 200k average', () => {
    const s = game();
    closeMonths(s, [{ valueEnd: 100_000 }, { valueEnd: 400_000 }]);
    const t = find(takeaways(s, WAIT_2), 'Cards left waiting');
    expect(t?.impact).toBeCloseTo(2 * 300_000, 6);
    expect(t?.detail).toContain(`worth about ${fmtMoney(300_000)} of stake`);
  });

  it('the proxy is never zeroed by a fall: a negative last month counts by its size, and the stake average carries a small one', () => {
    // a crash: 500k → 100k is a 400k move, larger than the 50k average
    const crash = game();
    closeMonths(crash, [{ valueEnd: 500_000 }, { valueEnd: 100_000 }]);
    expect(find(takeaways(crash, WAIT_2), 'Cards left waiting')?.impact).toBeCloseTo(2 * 400_000, 6);

    // the stake is value × the share at that close: a round in the last month turns the change to −5k, the average of 97.5k carries it
    const s = game();
    closeMonths(s, [{ valueEnd: 200_000 }, { valueEnd: 260_000 }]);
    raise(s, 45, 50_000, 0.25);
    // month 0: 200k × 1; month 1: 260k × 0.75 = 195k → −5k a month; 195k ÷ 2 months = 97.5k
    const t = find(takeaways(s, WAIT_2), 'Cards left waiting');
    expect(t).toBeDefined();
    expect(t?.impact).toBeCloseTo(2 * 97_500, 6);
  });

  it('a round signed on the close day counts from the next close (the book closes before the card is answered)', () => {
    const s = game();
    closeMonths(s, [{ valueEnd: 200_000 }, { valueEnd: 260_000 }]);
    raise(s, 60, 50_000, 0.25);
    // the share at the close of day 60 is still 1: the stake is 260k, 130k a month over two months
    expect(find(takeaways(s, WAIT_2), 'Cards left waiting')?.impact).toBeCloseTo(2 * 130_000, 6);
    // one day earlier the round dilutes that close: 195k of stake, 97.5k a month
    s.rounds[0].day = 59;
    expect(find(takeaways(s, WAIT_2), 'Cards left waiting')?.impact).toBeCloseTo(2 * 97_500, 6);
  });

  it('with one closed month the change is measured from the day-0 value still at the head of valueHistory', () => {
    const s = game();
    const start = s.valueHistory[0];
    expect(start).toBeGreaterThan(100_000);
    // a fall from the day-0 value to 50k: the move (start − 50k) is larger than the 50k average over one month
    closeMonths(s, [{ valueEnd: 50_000 }]);
    const t = find(takeaways(s, { cardWaitMs: 20_000, practice: false }), 'Cards left waiting');
    expect(t?.impact).toBeCloseTo(start - 50_000, 6);
    expect(t?.detail).toContain('Cards waited 20 s: 1 game month lost.');

    // a rise to 300k: the average (300k over one month) beats the move (300k − start)
    const up = game();
    closeMonths(up, [{ valueEnd: 300_000 }]);
    expect(find(takeaways(up, { cardWaitMs: 20_000, practice: false }), 'Cards left waiting')?.impact).toBeCloseTo(300_000, 6);
  });

  it('says nothing with no closed month, with no stake, with no wait, or with a wait under half a second', () => {
    expect(find(takeaways(game(), { cardWaitMs: 20_000, practice: false }), 'Cards left waiting')).toBeUndefined();
    const worthless = game();
    closeMonths(worthless, [{ valueEnd: 0 }, { valueEnd: 0 }]);
    expect(find(takeaways(worthless, WAIT_2), 'Cards left waiting')).toBeUndefined();
    const s = game();
    closeMonths(s, [{ valueEnd: 200_000 }, { valueEnd: 260_000 }]);
    expect(find(takeaways(s, NO_WAIT), 'Cards left waiting')).toBeUndefined();
    expect(find(takeaways(s, { cardWaitMs: 300, practice: false }), 'Cards left waiting')).toBeUndefined();
    expect(find(takeaways(s, { cardWaitMs: Number.NaN, practice: false }), 'Cards left waiting')).toBeUndefined();
  });
});

// ---------------------------------------------------------------- support too late

describe('takeaway: support too late (DESIGN 8 and 20)', () => {
  const C = CONFIG.customers;
  const avoidable = C.churnUnserved / (C.churnBase + C.churnUnserved);

  it('counts the customers churned in the months closed before the first support hire; impact = avoidable churn × average price × months each had left', () => {
    const s = game();
    closeMonths(s, tenMonths());
    expect(s.day).toBe(300);
    addCustomers(s, 20, 400);
    act(s, 150, hire('support'));
    const t = find(takeaways(s, NO_WAIT), 'Support came late');
    // month 2 closed on day 90 with 2 gone, month 3 on day 120 with 3 gone
    const expected = avoidable * 400 * (2 * ((300 - 90) / D) + 3 * ((300 - 120) / D));
    expect(t?.impact).toBeCloseTo(expected, 6);
    expect(t?.detail).toBe(
      `Your first support agent came in month 5 with about 15 customers: 5 customers had already cancelled, about ${Math.round(5 * avoidable)} of them over unanswered tickets. `
      + `At ${fmtMoney(400)} a month each, those would have paid about ${fmtMoney(expected)} by the end of the round.`,
    );
  });

  it('support never hired: every closed month counts and the title says so', () => {
    const s = game();
    const specs = tenMonths();
    specs[7].churned = 1;
    closeMonths(s, specs);
    addCustomers(s, 20, 400);
    const t = find(takeaways(s, NO_WAIT), 'No support');
    const expected = avoidable * 400 * (2 * ((300 - 90) / D) + 3 * ((300 - 120) / D) + 1 * ((300 - 240) / D));
    expect(t?.impact).toBeCloseTo(expected, 6);
    expect(t?.detail).toContain('You never hired support: 6 customers had already cancelled');
    expect(find(takeaways(s, NO_WAIT), 'Support came late')).toBeUndefined();
  });

  it('a hire on a close day comes after that close, so that month still counts; a hire before any churn says nothing', () => {
    // month 4 (closing on day 150, 15 customers) loses 4 more; a hire that day counts them, the hire is still "late" by the threshold
    const specs = tenMonths();
    specs[4].churned = 4;
    const s = game();
    closeMonths(s, specs);
    addCustomers(s, 20, 400);
    act(s, 150, hire('support'));
    const t = find(takeaways(s, NO_WAIT), 'Support came late');
    expect(t?.detail).toContain('came in month 5 with about 15 customers: 9 customers had already cancelled');
    expect(t?.impact).toBeCloseTo(avoidable * 400 * (2 * ((300 - 90) / D) + 3 * ((300 - 120) / D) + 4 * ((300 - 150) / D)), 6);

    const early = game();
    closeMonths(early, tenMonths());
    addCustomers(early, 20, 400);
    act(early, 30, hire('support'));
    expect(find(takeaways(early, NO_WAIT), 'Support came late')).toBeUndefined();
  });

  it('support hired at or under the coach\'s 10 customers is on time, whatever churned before (DESIGN 20: "vs 10")', () => {
    expect(CONFIG.coach.supportCustomers).toBe(10);
    // tenMonths: 6 customers at the close of day 90 and 10 at the close of day 120, with 5 churned by then
    for (const day of [90, 120, 149]) {
      const s = game();
      closeMonths(s, tenMonths());
      addCustomers(s, 20, 400);
      act(s, day, hire('support'));
      expect(titles(takeaways(s, NO_WAIT)), `hired on day ${day}`).not.toContain('Support came late');
    }
    // on the close that takes the count to 15 the same churn becomes a lesson
    const late = game();
    closeMonths(late, tenMonths());
    addCustomers(late, 20, 400);
    act(late, 150, hire('support'));
    expect(find(takeaways(late, NO_WAIT), 'Support came late')?.detail).toContain('5 customers had already cancelled');
  });

  it('the people on the payroll date the hire when the action log does not (the full engine\'s hire action)', () => {
    const s = game();
    closeMonths(s, tenMonths());
    addCustomers(s, 20, 400);
    const founder = s.people[0];
    s.people.push({ ...founder, id: 'p99', name: 'Agent', role: 'support', founder: false, baseSalary: RULES.hire.support.salary, hiredDay: 150 });
    expect(find(takeaways(s, NO_WAIT), 'Support came late')?.detail).toContain('came in month 5');
  });

  it('with no customers left the price is today\'s subscription price', () => {
    const s = game();
    closeMonths(s, tenMonths());
    const t = find(takeaways(s, NO_WAIT), 'No support');
    expect(t?.detail).toContain(`At ${fmtMoney(S.smbPrice(s))} a month each`);
  });
});

// ---------------------------------------------------------------- servers too late

describe('takeaway: servers too late (DESIGN 7, 11 and 20)', () => {
  const [FIX, RIDE] = EVENT_CHOICES.outage;

  it('adds the silent outages from the log and the outage cards from the action log; impact = customers lost × price × months left, plus the fixes', () => {
    const s = game();
    closeMonths(s, months(20, { customersEnd: 60 }));
    expect(s.day).toBe(600);
    addCustomers(s, 50, 500);
    log(s, 240, 'Servers buckled under load. 6 customers left.');
    act(s, 300, card(RIDE));
    log(s, 300, 'You rode out the outage. 8 customers left.');
    act(s, 420, card(FIX));
    const t = find(takeaways(s, NO_WAIT), 'Servers came late');
    const expected = 6 * 500 * ((600 - 240) / D) + 8 * 500 * ((600 - 300) / D) + CONFIG.events.outageFix;
    expect(t?.impact).toBeCloseTo(expected, 6);
    expect(t?.detail).toBe(
      `3 outages while servers were short cost you 14 customers and ${fmtMoney(CONFIG.events.outageFix)} in emergency fixes: about ${fmtMoney(expected)} by the end of the round. `
      + `A server is ${fmtMoney(CONFIG.assets.catalogue.server.price)} and covers ${CONFIG.assets.customersPerServer} customers.`,
    );
  });

  it('an outage card answered with enough servers is bad luck, not a lesson about servers', () => {
    const s = game();
    closeMonths(s, months(20, { customersEnd: 60 }));
    addCustomers(s, 50, 500);
    addServer(s, 100);
    act(s, 300, card(RIDE));
    log(s, 300, 'You rode out the outage. 8 customers left.');
    act(s, 420, card(FIX));
    expect(find(takeaways(s, NO_WAIT), 'Servers came late')).toBeUndefined();
    // a server bought after the card does not count for it
    s.assets[s.assets.length - 1].boughtDay = 500;
    expect(find(takeaways(s, NO_WAIT), 'Servers came late')?.detail).toContain('2 outages');
  });

  it('a ridden-out outage whose log line is gone takes outageLoss of that month\'s customers', () => {
    const s = game();
    closeMonths(s, months(20, { customersEnd: 60 }));
    addCustomers(s, 50, 500);
    act(s, 300, card(RIDE));
    const lost = Math.round(CONFIG.events.outageLoss * 60);
    const t = find(takeaways(s, NO_WAIT), 'Servers came late');
    expect(t?.impact).toBeCloseTo(lost * 500 * ((600 - 300) / D), 6);
    expect(t?.detail).toContain(`1 outage while servers were short cost you ${lost} customers:`);
  });

  it('other card answers are not outages', () => {
    const s = game();
    closeMonths(s, months(20, { customersEnd: 60 }));
    addCustomers(s, 50, 500);
    act(s, 300, card(EVENT_CHOICES.latePayer[0]));
    act(s, 400, card('equity'));
    expect(find(takeaways(s, NO_WAIT), 'Servers came late')).toBeUndefined();
  });
});

// ---------------------------------------------------------------- marketing too late

describe('takeaway: marketing too late (DESIGN 8, 13 and 20)', () => {
  const F = CONFIG.ui.marketingHintFeatures;
  const P = CONFIG.people;
  const output = RULES.hire.marketing.skill * (P.outputMoraleBase + P.morale.base / P.outputMoraleDivisor);
  const visitors = CONFIG.marketing.visitorsPerOutput * output;
  const conversion = CONFIG.product.conversionMax * (1 - Math.exp(-CONFIG.product.conversionK * F));
  const price = CONFIG.customers.smbPrice * (1 + CONFIG.product.pricePerFeature * Math.min(F, CONFIG.product.priceFeatureCap));

  it('months late = from the close where features reached the hint count to the first marketer; impact = months × visitors per marketer × conversion × price', () => {
    expect(F).toBe(3);
    const s = game();
    closeMonths(s, tenMonths()); // features reach 3 in month index 3, closed on day 120
    act(s, 210, hire('marketing'));
    const t = find(takeaways(s, NO_WAIT), 'Marketing came late');
    const customers = 3 * visitors * conversion;
    expect(t?.impact).toBeCloseTo(customers * price, 6);
    expect(t?.detail).toBe(
      `Features reached ${F} in month 4 and your first marketer came in month 7, 3 game months later. A marketer brings about ${Math.round(visitors)} visitors a month and `
      + `${fmtPct(conversion)} of them buy at ${fmtMoney(price)}: about ${Math.round(customers)} customers never signed, worth ${fmtMoney(customers * price)} a month.`,
    );
  });

  it('never hired: the months run to the end of the run and the title says so', () => {
    const s = game();
    closeMonths(s, tenMonths());
    const t = find(takeaways(s, NO_WAIT), 'No marketing');
    expect(t?.impact).toBeCloseTo(6 * visitors * conversion * price, 6);
    expect(t?.detail).toContain('you never hired a marketer: 6 game months without one');
  });

  it('says nothing when the marketer came first, or when features never reached the count', () => {
    const s = game();
    closeMonths(s, tenMonths());
    act(s, 60, hire('marketing'));
    expect(titles(takeaways(s, NO_WAIT))).not.toContain('Marketing came late');

    const few = game();
    closeMonths(few, months(10, { featuresEnd: F - 1 }));
    expect(titles(takeaways(few, NO_WAIT))).not.toContain('No marketing');
  });
});

// ---------------------------------------------------------------- idle cash

describe('takeaway: idle cash (DESIGN 10 and 20)', () => {
  const idle = (cashEnd: number, r = 0.2): MonthSpec => ({ cashEnd, r });

  it('counts the closed months with cash above the line and no hire; impact = the excess × the required return then, per month', () => {
    const s = game();
    closeMonths(s, [idle(100_000), idle(200_000), idle(250_000), idle(250_000), idle(120_000), idle(300_000)]);
    act(s, 95, hire('product')); // month 3 (days 90..119) had a hire
    const t = find(takeaways(s, NO_WAIT), 'Idle cash');
    const excess = (200_000 - IDLE_CASH) + (250_000 - IDLE_CASH) + (300_000 - IDLE_CASH);
    expect(t?.impact).toBeCloseTo((excess * 0.2) / 12, 6);
    expect(t?.detail).toBe(
      `3 months with more than ${fmtMoney(IDLE_CASH)} in the bank and no hire, ${fmtMoney(excess / 3)} above it on average. `
      + `Money in the bank earns nothing while investors wanted ${fmtRate(0.2)} a year: about ${fmtMoney((excess * 0.2) / 12)} of growth not bought.`,
    );
  });

  it('a hire on a close day belongs to the month that starts that day', () => {
    const s = game();
    closeMonths(s, [idle(100_000), idle(200_000), idle(250_000), idle(250_000), idle(120_000), idle(300_000)]);
    act(s, 120, hire('product')); // month 4, not month 3
    const t = find(takeaways(s, NO_WAIT), 'Idle cash');
    expect(t?.detail).toContain('4 months with more than');
    const excess = (200_000 - IDLE_CASH) + 2 * (250_000 - IDLE_CASH) + (300_000 - IDLE_CASH);
    expect(t?.impact).toBeCloseTo((excess * 0.2) / 12, 6);
  });

  it('the required return is never read below the base rate; nothing to say with the cash under the line', () => {
    const s = game();
    closeMonths(s, [idle(250_000, 0)]);
    const t = find(takeaways(s, NO_WAIT), 'Idle cash');
    expect(t?.impact).toBeCloseTo(((250_000 - IDLE_CASH) * CONFIG.valuation.base) / 12, 6);
    expect(t?.detail).toContain(`investors wanted ${fmtRate(CONFIG.valuation.base)} a year`);

    const poor = game();
    closeMonths(poor, [idle(IDLE_CASH), idle(90_000)]);
    expect(find(takeaways(poor, NO_WAIT), 'Idle cash')).toBeUndefined();
  });
});

// ---------------------------------------------------------------- out of cash

describe('takeaway: out of cash (DESIGN 9 and 20)', () => {
  it('names the last month\'s costs, revenue and gap and the final balance; impact = the stake that went to zero', () => {
    const s = game();
    closeMonths(s, [{ valueEnd: 150_000, cashEnd: 20_000 }, { valueEnd: 120_000, cashEnd: 5_000 }, { valueEnd: 100_000, cashEnd: -8_000, revenue: 10_000, salaries: 25_000 }]);
    s.status = 'gameOver';
    const t = find(takeaways(s, NO_WAIT), 'Out of cash');
    expect(t?.impact).toBe(100_000);
    expect(t?.detail).toBe(
      `In the last month costs were ${fmtMoney(25_000)} against ${fmtMoney(10_000)} of revenue, a gap of ${fmtMoney(15_000)}, and the bank balance ended at ${fmtMoney(-8_000)}. `
      + `Running out of cash scores 0: a stake worth ${fmtMoney(100_000)} went with it.`,
    );
  });

  it('the stake is value × the share after the rounds before that close', () => {
    const s = game();
    closeMonths(s, [{ valueEnd: 150_000, cashEnd: 20_000 }, { valueEnd: 100_000, cashEnd: -8_000, revenue: 10_000, salaries: 25_000 }]);
    raise(s, 45, 50_000, 0.25);
    s.status = 'gameOver';
    const t = find(takeaways(s, NO_WAIT), 'Out of cash');
    expect(t?.impact).toBe(75_000);
    expect(t?.detail).toContain(`a stake worth ${fmtMoney(75_000)}`);
  });

  it('profitable on paper: names where the cash went (unpaid invoices, assets); impact is at least the shortfall', () => {
    const s = game();
    closeMonths(s, [{ valueEnd: 0, cashEnd: -5_000, revenue: 30_000, salaries: 20_000, arEnd: 30_000, capex: 40_000 }]);
    s.status = 'gameOver';
    const t = find(takeaways(s, NO_WAIT), 'Out of cash');
    expect(t?.impact).toBe(5_000);
    expect(t?.detail).toContain(`The last month was profitable on paper, ${fmtMoney(30_000)} of revenue against ${fmtMoney(20_000)} of costs, but ${fmtMoney(30_000)} sat in unpaid invoices and ${fmtMoney(40_000)} went into assets, and the bank balance ended at ${fmtMoney(-5_000)}.`);
  });

  it('says nothing for a run the buzzer sold', () => {
    const s = game();
    closeMonths(s, [{ valueEnd: 100_000, cashEnd: -8_000, revenue: 10_000, salaries: 25_000 }]);
    s.status = 'sold';
    expect(find(takeaways(s, NO_WAIT), 'Out of cash')).toBeUndefined();
  });
});

// ---------------------------------------------------------------- ranking

describe('takeaways: the top three by impact', () => {
  it('sorts the candidates by impact and keeps three, every one with a positive impact', () => {
    const s = game();
    const specs = tenMonths();
    specs[8].cashEnd = 400_000;
    specs[9].cashEnd = 400_000;
    specs[8].r = 0.2;
    specs[9].r = 0.2;
    closeMonths(s, specs);
    addCustomers(s, 20, 400);
    raise(s, 60, 100_000, 0.2); // unspent: 80k × 0.2 = 16k
    s.cash = 80_000;
    act(s, 150, hire('support')); // support: ≈ 9.6k
    act(s, 210, hire('marketing')); // marketing: ≈ 3.2k
    // idle: 2 × 250k × 0.2 / 12 ≈ 8.3k
    const list = takeaways(s, NO_WAIT);
    expect(titles(list)).toEqual(['Raised but unspent', 'Support came late', 'Idle cash']);
    expect(list.map((t) => t.impact)).toEqual([...list.map((t) => t.impact)].sort((a, b) => b - a));
    for (const t of list) expect(t.impact).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------- timeline

describe('timeline (DESIGN 20)', () => {
  const { latePayer, outage, press } = EVENT_CHOICES;

  it('one point per closed month: value, the share after the rounds before that close, stake = value × share', () => {
    const s = game();
    closeMonths(s, [{ valueEnd: 200_000 }, { valueEnd: 300_000 }, { valueEnd: 400_000 }]);
    raise(s, 45, 100_000, 0.25);
    raise(s, 90, 50_000, 0.2, true); // on the close day of month 2: after that close
    expect(timeline(s).points).toEqual([
      { month: 0, value: 200_000, share: 1, stake: 200_000 },
      { month: 1, value: 300_000, share: 0.75, stake: 225_000 },
      { month: 2, value: 400_000, share: 0.75, stake: 300_000 },
    ]);
  });

  it('markers from the action log (hires and fires with the role, servers, the demo room, event answers), the rounds and the second-floor asset, sorted by day', () => {
    const s = game();
    closeMonths(s, [{ valueEnd: 200_000 }, { valueEnd: 300_000 }, { valueEnd: 400_000 }]);
    raise(s, 45, 100_000, 0.25);
    raise(s, 90, 50_000, 0.2, true);
    act(s, 0, hire('product'));
    act(s, 20, hire('sales'));
    act(s, 45, card('equity'));
    act(s, 50, { type: 'fireRole', role: 'sales' });
    act(s, 70, { type: 'buyAsset', kind: 'server' });
    act(s, 75, { type: 'buyAsset', kind: 'laptop' });
    act(s, 80, { type: 'buyDemoRoom' });
    act(s, 85, card(latePayer[0]));
    act(s, 86, card(outage[1]));
    act(s, 87, card(press[0]));
    act(s, 90, card('decline'));
    addSecondFloor(s, 88);
    expect(timeline(s).markers).toEqual([
      { day: 0, kind: 'hire', label: 'Hired an engineer' },
      { day: 20, kind: 'hire', label: 'Hired a sales rep' },
      { day: 45, kind: 'round', label: `Round: ${fmtMoney(100_000)} for ${fmtPct(0.25)}` },
      { day: 50, kind: 'fire', label: 'Let a sales rep go' },
      { day: 70, kind: 'server', label: 'Bought a server' },
      { day: 80, kind: 'demo', label: 'Built the demo room' },
      { day: 85, kind: 'event', label: 'Late payer: waited' },
      { day: 86, kind: 'event', label: 'Outage: rode it out' },
      { day: 87, kind: 'event', label: 'Press: PR push' },
      { day: 88, kind: 'upstairs', label: 'Built the second floor' },
      { day: 90, kind: 'round', label: `Lifeline: ${fmtMoney(50_000)} for ${fmtPct(0.2)}` },
    ]);
  });

  it('a second floor bought by hand (the full engine) is one marker, not two', () => {
    const s = game();
    act(s, 88, { type: 'buyAsset', kind: 'secondFloor' });
    addSecondFloor(s, 88);
    expect(timeline(s).markers).toEqual([{ day: 88, kind: 'upstairs', label: 'Built the second floor' }]);
  });

  it('a fresh game has no point and no marker', () => {
    expect(timeline(createGame(1))).toEqual({ points: [], markers: [] });
  });
});

// ---------------------------------------------------------------- purity and the real engine

describe('post-mortem: pure reads', () => {
  it('neither function changes the state', () => {
    const s = game();
    closeMonths(s, tenMonths());
    addCustomers(s, 20, 400);
    raise(s, 60, 100_000, 0.2);
    act(s, 150, hire('support'));
    log(s, 240, 'Servers buckled under load. 6 customers left.');
    s.status = 'sold';
    const before = JSON.stringify(s);
    takeaways(s, { cardWaitMs: 40_000, practice: true });
    timeline(s);
    expect(JSON.stringify(s)).toBe(before);
  });

  it('a real tournament round: one point per closed month, stakes consistent, markers for the hires, at most three takeaways in impact order', () => {
    const s = createGame(20261104);
    expect(dispatch(s, hire('product')).ok).toBe(true);
    let guard = 0;
    while (s.day < RULES.roundMonths! * D && s.status === 'playing' && guard++ < 2000) {
      if (s.card) {
        const choice = s.card.choices.find((c) => c.id === 'equity' && !c.disabled) ?? s.card.choices.find((c) => !c.disabled);
        expect(dispatch(s, card(choice!.id)).ok).toBe(true);
      } else {
        advanceDay(s);
      }
    }
    if (s.status === 'playing') expect(dispatch(s, { type: 'timeUp' }).ok).toBe(true);

    const { points, markers } = timeline(s);
    expect(points).toHaveLength(s.history.length);
    points.forEach((p, i) => {
      expect(p.month).toBe(s.history[i].month);
      expect(p.value).toBe(Math.max(0, s.history[i].valueEnd));
      expect(p.stake).toBeCloseTo(p.value * p.share, 6);
      if (i > 0) expect(p.share).toBeLessThanOrEqual(points[i - 1].share);
    });
    expect(markers[0]).toEqual({ day: 0, kind: 'hire', label: 'Hired an engineer' });
    expect(markers.filter((m) => m.kind === 'round')).toHaveLength(s.rounds.length);
    for (let i = 1; i < markers.length; i++) expect(markers[i].day).toBeGreaterThanOrEqual(markers[i - 1].day);

    const list = takeaways(s, { cardWaitMs: 12_000, practice: false });
    expect(list.length).toBeLessThanOrEqual(3);
    for (let i = 1; i < list.length; i++) expect(list[i].impact).toBeLessThanOrEqual(list[i - 1].impact);
    for (const t of list) {
      expect(t.impact).toBeGreaterThan(0);
      expect(t.title.length).toBeGreaterThan(0);
      expect(t.detail).toMatch(/\$/);
    }
  });
});
