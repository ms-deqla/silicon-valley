/**
 * Money modules: valuation (DESIGN.md 10), capital (10), exit (12), hints (13).
 * Other sim modules may still be stubs: these tests build the states they need by hand
 * and only lean on game.ts for the tick order and ledger.ts for the books.
 */
import { describe, expect, it } from 'vitest';
import { CONFIG, advanceDay, advanceTo, canDispatch, createGame, dispatch, ledger, selectors } from '../src/sim';
import type { Card, CardChoice, Customer, GameState, MonthBook, Person, Prospect, Room } from '../src/sim';
import { computeValuation } from '../src/sim/valuation';
import { canPrepay, openKnock } from '../src/sim/capital';
import { canSell, gameOver, scorePreview } from '../src/sim/exit';
import { fmtMoney, fmtPct, hintLine, whyLine } from '../src/sim/hints';

const V = CONFIG.valuation;
const C = CONFIG.capital;
const D = CONFIG.time.daysPerMonth;

// ---------------------------------------------------------------- fixtures

interface MonthSpec {
  revenue?: number;
  fcf?: number;
  capex?: number;
  disposal?: number;
  dep?: number;
}

/** A synthetic closed month for state.history. */
function closedMonth(state: GameState, month: number, o: MonthSpec = {}): MonthBook {
  const b = ledger.newBook(state, month, month * D);
  b.pnl.smbRevenue = o.revenue ?? 0;
  b.cf.capex = o.capex ?? 0;
  b.cf.disposalProceeds = o.disposal ?? 0;
  b.pnl.depreciation = o.dep ?? 0;
  b.fcf = o.fcf ?? 0;
  b.closed = true;
  return b;
}

function person(state: GameState, role: Person['role'], skill: number, salary: number, extra: Partial<Person> = {}): Person {
  return {
    id: `p${state.nextId++}`,
    name: 'Sam',
    role,
    archetype: 'senior',
    quirk: 'loyal',
    skill,
    baseSalary: salary,
    morale: 70,
    roomId: null,
    hiredDay: state.day,
    lastRaiseDay: state.day,
    raisePending: false,
    raiseRequestedDay: null,
    raiseGrantedDay: null,
    raiseRefusedDay: null,
    founder: false,
    hasLaptop: true,
    ...extra,
  };
}

function room(kind: Room['kind'], rent = 0): Room {
  return { id: `room-${kind}`, kind, size: 'small', floor: 0, x: 0, y: 0, w: 2, h: 2, rent, openedDay: 0 };
}

function smb(state: GameState, price = 300): Customer {
  return {
    id: `c${state.nextId++}`,
    kind: 'smb',
    joinedDay: state.day,
    monthlyPrice: price,
    contractValue: 0,
    contractEndDay: null,
    noRenew: false,
    servedShare: 1,
  };
}

function prospect(state: GameState): Prospect {
  return { id: `pr${state.nextId++}`, arrivedDay: state.day, expiresDay: state.day + 45, value: 30_000, repId: null, progress: 0 };
}

function takeLoan(seed = 1): GameState {
  const s = createGame(seed);
  s.rooms.push(room('finance'));
  const card = openKnock(s, false);
  if (!card) throw new Error('no card');
  const v = dispatch(s, { type: 'card', choiceId: 'loan' });
  if (!v.ok) throw new Error(v.reason);
  return s;
}

/**
 * A $100k loan falling due on the first close with $85k in the bank and `n` subscribers, whose
 * month-end billing lands under the open maturity card (game.ts: capital step 8, closeMonth step 10).
 * Every loan taken on a crisis card at a close falls due on a close day, so this is the common case.
 */
function maturityAtClose(n: number): GameState {
  const s = takeLoan();
  if (!s.loan) throw new Error('no loan');
  s.loan.dueDay = D;
  for (let i = 0; i < n; i++) s.customers.push(smb(s));
  for (let i = 0; i < 4; i++) s.assets.push({ id: `srv${i}`, kind: 'server', cost: 20_000, bookValue: 20_000, lifeMonths: 48, boughtDay: 0, roomId: null });
  ledger.recordCapex(s, 65_000); // $85k: short of the principal until the subscribers pay
  // that capex makes the first closed month look like heavy burn; a lifeline offered today keeps
  // the desperation knock (DESIGN.md 10, once per 60 days) from stepping in front of the maturity
  s.schedule.lastDesperationDay = s.day;
  advanceTo(s, D);
  if (s.day !== D || s.card?.kind !== 'maturity') throw new Error('no maturity card at the close');
  return s;
}

/** openKnock against a hand-set company value; r sits at the base rate, so the normal haircut is 10%. */
function knockAt(value: number, desperate: boolean, setup?: (s: GameState) => void): {
  s: GameState; card: Card; amount: number; share: number; preMoney: number; equity: CardChoice; loan: CardChoice;
} {
  const s = createGame(1);
  setup?.(s);
  s.valuation = { ...s.valuation, value, floor: value };
  const card = openKnock(s, desperate);
  if (!card) throw new Error('no card');
  const equity = card.choices.find((c) => c.id === 'equity');
  const loan = card.choices.find((c) => c.id === 'loan');
  if (!equity || !loan) throw new Error('choices missing');
  return { s, card, amount: card.data.amount as number, share: card.data.share as number, preMoney: card.data.preMoney as number, equity, loan };
}

/** Advance to a day, answering every knock on the way (the first one with `first`, the rest declined). */
function runTo(state: GameState, day: number, first = 'decline'): void {
  let answered = false;
  let guard = 0;
  while (state.status === 'playing' && guard++ < 1000) {
    advanceTo(state, day);
    if (state.card) {
      const card = state.card;
      let choiceId: string;
      if (card.kind === 'knock' || card.kind === 'desperation') {
        choiceId = answered ? 'decline' : first;
        answered = true;
      } else {
        // someone else's card (an event): take the last enabled choice, the one that usually costs no cash
        const enabled = card.choices.filter((c) => !c.disabled);
        choiceId = enabled[enabled.length - 1].id;
      }
      const v = dispatch(state, { type: 'card', choiceId });
      if (!v.ok) throw new Error(`cannot answer ${card.kind} card: ${v.reason}`);
    } else if (state.day >= day) {
      break;
    }
  }
}

// ---------------------------------------------------------------- valuation

describe('valuation', () => {
  it('founder alone at start is worth about $200k: cash + 0.6 × assets + acqui-hire', () => {
    const s = createGame(1);
    const v = s.valuation;
    const expectedFloor = CONFIG.start.cash + V.assetRecovery * ledger.assetsAtBook(s) + CONFIG.start.founderSkill * V.acquihirePerSkill;
    expect(v.floor).toBeCloseTo(expectedFloor, 6);
    expect(v.value).toBeCloseTo(expectedFloor, 6);
    expect(v.value).toBeGreaterThan(195_000);
    expect(v.value).toBeLessThan(210_000);
    expect(v.dcf).toBe(0);
    expect(v.r).toBeCloseTo(V.base, 10);
    expect(v.premia).toEqual({ base: V.base, burn: 0, rnd: 0, leverage: 0, concentration: 0, recession: 0 });
    expect(v.growth).toBe(0);
    expect(v.runRate).toBe(0);
    expect(v.runwayMonths).toBeNull();
  });

  it('burn premium: negative run-rate with a short runway raises r', () => {
    const s = createGame(1);
    s.history.push(closedMonth(s, 0, { fcf: -10_000 }));
    const v = computeValuation(s);
    const runway = CONFIG.start.cash / 10_000; // 5 months
    expect(v.runRate).toBeCloseTo(-10_000, 6);
    expect(v.runwayMonths).toBeCloseTo(runway, 6);
    expect(v.premia.burn).toBeCloseTo(V.burnMax * (1 - runway / V.burnRunwayMonths), 10);
    expect(v.r).toBeGreaterThan(V.base);
  });

  it('burn premium is zero when the run-rate is not negative', () => {
    const s = createGame(1);
    s.history.push(closedMonth(s, 0, { fcf: 5_000 }));
    expect(computeValuation(s).premia.burn).toBe(0);
  });

  it('burn premium keys on the FCF run-rate, not the DCF base: a capex-heavy month still counts as burn', () => {
    // DESIGN.md 10: "if FCF run-rate < 0". Operating cash flow after maintenance capex (the DCF base) is
    // +$5k a month here, but the servers bought in month 3 leave the company burning with 3 months of cash.
    const s = createGame(1);
    s.history.push(closedMonth(s, 0, { fcf: 5_000 }));
    s.history.push(closedMonth(s, 1, { fcf: 5_000 }));
    s.history.push(closedMonth(s, 2, { fcf: -15_000, capex: 20_000 }));
    ledger.recordCapex(s, CONFIG.start.cash - 5_000); // $5k left in the bank
    const v = computeValuation(s);
    const runway = 5_000 / -((5_000 + 5_000 - 15_000) / 3); // 3 months
    expect(v.runRate).toBeCloseTo(5_000, 6);
    expect(selectors.runwayMonths(s)).toBeCloseTo(runway, 6);
    expect(v.runwayMonths).toBeCloseTo(runway, 6);
    expect(v.premia.burn).toBeCloseTo(V.burnMax * (1 - runway / V.burnRunwayMonths), 10); // 0.1125
    expect(v.r).toBeCloseTo(V.base + V.burnMax * (1 - runway / V.burnRunwayMonths), 10);
    expect(v.r).toBeGreaterThan(V.base);
  });

  it('R&D premium: researcher salaries as a share of costs', () => {
    const s = createGame(1);
    s.people.push(person(s, 'rnd', 4, 11_000));
    const v = computeValuation(s);
    expect(selectors.rndCostShare(s)).toBeCloseTo(1, 10);
    expect(v.premia.rnd).toBeCloseTo(V.rndMax, 10);
    expect(v.r).toBeGreaterThan(V.base);
  });

  it('leverage premium: debt over debt plus last value', () => {
    const s = createGame(1);
    const last = s.valuation.value;
    s.loan = { id: 'l', principal: 100_000, annualRate: 0.04, startDay: 0, dueDay: 1080, rolledOver: false };
    const v = computeValuation(s);
    expect(v.premia.leverage).toBeCloseTo((100_000 / (100_000 + last)) * V.leverageMax, 10);
    expect(v.r).toBeGreaterThan(V.base);
    expect(v.floor).toBeCloseTo(last - 100_000, 6); // debt comes off the floor
  });

  it('concentration premium: one customer is 100% of revenue', () => {
    const s = createGame(1);
    s.customers.push(smb(s));
    const v = computeValuation(s);
    expect(v.premia.concentration).toBeCloseTo(V.concentrationMax, 10);
    expect(v.r).toBeGreaterThan(V.base);
  });

  it('recession premium while a recession is active', () => {
    const s = createGame(1);
    s.effects.recessionUntilDay = s.day + 100;
    const v = computeValuation(s);
    expect(v.premia.recession).toBe(V.recession);
    expect(v.r).toBeCloseTo(V.base + V.recession, 10);
  });

  it('a higher r lowers value with the same history', () => {
    const s = createGame(1);
    for (let m = 0; m < 3; m++) s.history.push(closedMonth(s, m, { revenue: 30_000, fcf: 20_000 }));
    const v1 = computeValuation(s);
    expect(v1.runRate).toBeCloseTo(20_000, 6);
    expect(v1.dcf).toBeGreaterThan(60 * 20_000); // annuity plus terminal value
    expect(v1.dcf).toBeLessThan(200 * 20_000);
    expect(v1.value).toBeCloseTo(v1.dcf + s.cash, 6); // DCF route beats the floor
    expect(v1.value).toBeGreaterThan(v1.floor);

    s.effects.recessionUntilDay = s.day + 100;
    const v2 = computeValuation(s);
    expect(v2.runRate).toBeCloseTo(v1.runRate, 6);
    expect(v2.r).toBeGreaterThan(v1.r);
    expect(v2.value).toBeLessThan(v1.value);
  });

  it('run-rate adds back capex and takes out disposal proceeds and depreciation', () => {
    const s = createGame(1);
    s.history.push(closedMonth(s, 0, { fcf: 1_000, capex: 20_000, disposal: 2_000, dep: 500 }));
    expect(computeValuation(s).runRate).toBeCloseTo(1_000 + 20_000 - 2_000 - 500, 6);
  });

  it('growth compares smoothed revenues across the window, scaled by trust, and is clamped', () => {
    const n = V.growthSmoothMonths;
    const avg = (base: number, rate: number, from: number): number => {
      let sum = 0;
      for (let m = from; m < from + n; m++) sum += base * Math.pow(rate, m);
      return sum / n;
    };
    const build = (base: number, rate: number, months: number): ReturnType<typeof createGame> => {
      const g = createGame(1);
      for (let m = 0; m < months; m++) g.history.push(closedMonth(g, m, { revenue: base * Math.pow(rate, m), fcf: 1_000 }));
      return g;
    };

    // too little history for a window → 0
    expect(computeValuation(build(10_000, 1.5, n + V.growthMinLagMonths - 1)).growth).toBe(0);

    // a material base over a full window at +10%/month → clamped to growthMax
    expect(computeValuation(build(20_000, 1.1, n + V.growthWindowMonths + 1)).growth).toBeCloseTo(V.growthMax, 10);

    // the same growth on a tiny base is barely trusted
    const tinyMonths = n + V.growthWindowMonths + 1;
    const tinyLast = avg(500, 1.1, tinyMonths - n);
    expect(computeValuation(build(500, 1.1, tinyMonths)).growth).toBeCloseTo(0.1 * (tinyLast / V.growthTrustRevenue), 6);

    // a short window is trusted in proportion to its length
    const shortMonths = n + 4;
    const shortLast = avg(10_000, 1.03, shortMonths - n);
    const expectedShort = 0.03 * Math.min(1, shortLast / V.growthTrustRevenue) * (4 / V.growthWindowMonths);
    expect(computeValuation(build(10_000, 1.03, shortMonths)).growth).toBeCloseTo(expectedShort, 6);

    // falling revenue is negative, clamped at growthMin
    expect(computeValuation(build(200_000, 0.8, n + V.growthWindowMonths + 1)).growth).toBeCloseTo(V.growthMin, 10);
  });

  it('negative flows fall back to the floor, never below zero', () => {
    const s = createGame(1);
    for (let m = 0; m < 3; m++) s.history.push(closedMonth(s, m, { fcf: -5_000 }));
    const v = computeValuation(s);
    expect(v.dcf).toBeLessThan(0);
    expect(v.value).toBeCloseTo(v.floor, 6);
    expect(v.value).toBeGreaterThanOrEqual(0);
  });

  it('floor counts receivables at 90%', () => {
    const s = createGame(1);
    ledger.bookEnterpriseDeal(s, 'cust', 30_000, 90);
    const v = computeValuation(s);
    const expected = s.cash + V.arRecovery * 30_000 + V.assetRecovery * ledger.assetsAtBook(s) + CONFIG.start.founderSkill * V.acquihirePerSkill;
    expect(v.floor).toBeCloseTo(expected, 6);
  });
});

// ---------------------------------------------------------------- capital

describe('capital: knocks and equity', () => {
  it('knock offer maths for a profitable company', () => {
    const s = createGame(1);
    const value = s.valuation.value;
    const card = openKnock(s, false);
    expect(card).not.toBeNull();
    if (!card) return;
    expect(s.card).toBe(card);
    expect(card.kind).toBe('knock');
    expect(card.title).toBe('An investor knocks');
    expect(card.speaker).toMatch(/^A partner at /);
    expect(card.quote).toBeTruthy();
    expect(card.body).toContain('$100k');

    const amount = Math.max(C.offerValueShare * value, C.offerMinProfitable);
    expect(card.data.amount).toBe(Math.round(amount / C.offerRound) * C.offerRound);
    const preMoney = value * (1 - C.haircutBase); // riskIndex 0 at the base rate
    expect(card.data.preMoney).toBeCloseTo(preMoney, 6);
    expect(card.data.share).toBeCloseTo(100_000 / (preMoney + 100_000), 10);
    expect(card.data.loanRate).toBeCloseTo(C.loanBaseRate, 10);

    const ids = card.choices.map((c) => c.id);
    expect(ids).toEqual(['equity', 'loan', 'decline']);
    expect(card.choices[0].detail).toBe(`$100k for ${((100_000 / (preMoney + 100_000)) * 100).toFixed(0)}%`);
    expect(card.choices[1].disabled).toBe(true);
    expect(card.choices[1].reason).toBe('Open a Finance room to borrow');
    expect(card.choices[2].detail).toBe('Costs nothing');
    expect(s.schedule.nextKnockDay).toBeGreaterThanOrEqual(s.day + C.knockEveryDays[0]);
    expect(s.schedule.nextKnockDay).toBeLessThanOrEqual(s.day + C.knockEveryDays[1]);
    expect(openKnock(s, false)).toBeNull(); // one card at a time
  });

  it('offer for a burning company is 6 months of burn, min $50k', () => {
    const s = createGame(1);
    s.people.push(person(s, 'product', 3, 20_000)); // burn $20k/month before any close
    const card = openKnock(s, false);
    if (!card) throw new Error('no card');
    const burn = selectors.monthlyBurn(s);
    expect(burn).toBeCloseTo(20_000, 6);
    const expected = Math.max(C.offerBurnMonths * burn, C.offerValueShare * s.valuation.value, C.offerMin);
    expect(card.data.amount).toBe(Math.round(expected / C.offerRound) * C.offerRound);
  });

  it('equity: share maths and founder share after two rounds', () => {
    const s = createGame(1);
    const card1 = openKnock(s, false);
    if (!card1) throw new Error('no card');
    const share1 = card1.data.share as number;
    const amount1 = card1.data.amount as number;
    expect(dispatch(s, { type: 'card', choiceId: 'equity' }).ok).toBe(true);
    expect(s.card).toBeNull();
    expect(s.cash).toBe(CONFIG.start.cash + amount1);
    expect(s.book.fin.equityIn).toBe(amount1);
    expect(s.founderShare).toBeCloseTo(1 - share1, 10);
    expect(s.rounds).toHaveLength(1);
    expect(s.rounds[0]).toMatchObject({ day: s.day, amount: amount1, shareSold: share1, desperate: false });
    expect(s.rounds[0].postMoney).toBeCloseTo(s.rounds[0].preMoney + amount1, 6);
    expect(s.visuals.some((v) => v.t === 'toast' && v.tone === 'good')).toBe(true);
    expect(s.log.at(-1)?.tone).toBe('good');

    expect(dispatch(s, { type: 'debug', op: 'knock' }).ok).toBe(true);
    const card2 = s.card;
    if (!card2) throw new Error('no second card');
    const share2 = card2.data.share as number;
    const amount2 = card2.data.amount as number;
    expect(dispatch(s, { type: 'card', choiceId: 'equity' }).ok).toBe(true);
    expect(s.founderShare).toBeCloseTo((1 - share1) * (1 - share2), 10);
    expect(s.rounds).toHaveLength(2);
    expect(s.cash).toBe(CONFIG.start.cash + amount1 + amount2);
  });

  it('declining costs nothing', () => {
    const s = createGame(1);
    openKnock(s, false);
    expect(dispatch(s, { type: 'card', choiceId: 'decline' }).ok).toBe(true);
    expect(s.card).toBeNull();
    expect(s.cash).toBe(CONFIG.start.cash);
    expect(s.founderShare).toBe(1);
    expect(s.rounds).toHaveLength(0);
  });

  it('desperation knock uses the 50% haircut and stamps the cooldown', () => {
    const s = createGame(1);
    const card = openKnock(s, true);
    if (!card) throw new Error('no card');
    expect(card.kind).toBe('desperation');
    expect(card.title).toBe('A lifeline, at a price');
    expect(card.data.preMoney).toBeCloseTo(s.valuation.value * (1 - C.desperationHaircut), 6);
    expect(s.schedule.lastDesperationDay).toBe(s.day);
    expect(dispatch(s, { type: 'card', choiceId: 'equity' }).ok).toBe(true);
    expect(s.rounds[0].desperate).toBe(true);
  });

  it('one round never sells more than 40%: rounding to $10k never pushes the share past the cap', () => {
    // DESIGN.md 10: "the amount is cut to fit". Each of the first four used to round the cut amount back up over 40%.
    const cases: [number, boolean][] = [[45_000, true], [60_000, false], [100_000, false], [135_366, true], [310_000, false], [1_000_000, false]];
    for (const [value, desperate] of cases) {
      const { amount, share, preMoney, equity } = knockAt(value, desperate);
      const label = `value ${value}${desperate ? ', desperate' : ''}`;
      expect(preMoney, label).toBeCloseTo(value * (1 - (desperate ? C.desperationHaircut : C.haircutBase)), 6);
      expect(equity.disabled, label).toBeFalsy();
      expect(amount % C.offerRound, label).toBe(0);
      expect(amount, label).toBeGreaterThanOrEqual(C.offerRound);
      expect(share, label).toBeLessThanOrEqual(C.maxShareSold);
      expect(share, label).toBeCloseTo(amount / (preMoney + amount), 12);
      expect(equity.detail, label).toBe(`${fmtMoney(amount)} for ${fmtPct(share)}`);
    }
    // desperate at $45k: $22.5k of pre-money carries $15k at 40%, so one $10k step, not the $20k (47%) rounding gave
    const a = knockAt(45_000, true);
    expect(a.amount).toBe(10_000);
    expect(a.share).toBeCloseTo(10_000 / 32_500, 10);
    // the repo's own random run: pre-money $67,683 carries $45,122, so $40k, not $50k for 42.5%
    const b = knockAt(67_683 / (1 - C.desperationHaircut), true);
    expect(b.preMoney).toBeCloseTo(67_683, 6);
    expect(b.amount).toBe(40_000);
    expect(b.share).toBeLessThan(C.maxShareSold);
    // exactly on the cap: $90k of pre-money carries $60k, and 60 / 150 is 40% on the nose
    const c = knockAt(100_000, false);
    expect(c.amount).toBe(60_000);
    expect(c.share).toBeCloseTo(C.maxShareSold, 12);
    expect(c.share).toBeLessThanOrEqual(C.maxShareSold);
    // the cap is not binding here: the plain $100k minimum for a profitable company
    const d = knockAt(1_000_000, false);
    expect(d.amount).toBe(C.offerMinProfitable);
  });

  it('too little value to carry one $10k step inside the cap: no stake, no loan, the founder keeps everything', () => {
    // DESIGN.md 10: a company with no operations can only raise against its floor. Under $15k of pre-money
    // not even $10k fits inside 40%, so the $10k minimum must not win (it used to sell 99.99% for $10k).
    const cases: [number, boolean][] = [[0, true], [0, false], [10_000, true], [25_000, true], [14_000, false]];
    for (const [value, desperate] of cases) {
      const { s, card, amount, share, equity, loan } = knockAt(value, desperate, (st) => st.rooms.push(room('finance')));
      const label = `value ${value}${desperate ? ', desperate' : ''}`;
      expect(amount, label).toBe(0);
      expect(share, label).toBe(0);
      expect(equity.disabled, label).toBe(true);
      expect(equity.reason, label).toMatch(/worth too little/);
      expect(loan.disabled, label).toBe(true);
      expect(loan.reason, label).toMatch(/worth too little/);
      expect(card.choices.map((ch) => ch.id), label).toEqual(['equity', 'loan', 'decline']);
      expect(card.choices[2].disabled, label).toBeFalsy();
      expect(card.body, label).toMatch(/nothing to put money against|too little/);
      expect(s.schedule.nextKnockDay, label).toBeGreaterThanOrEqual(s.day + C.knockEveryDays[0]);
      expect(canDispatch(s, { type: 'card', choiceId: 'equity' }).ok, label).toBe(false);
      expect(canDispatch(s, { type: 'card', choiceId: 'loan' }).ok, label).toBe(false);
      expect(dispatch(s, { type: 'card', choiceId: 'decline' }).ok, label).toBe(true);
      expect(s.card, label).toBeNull();
      expect(s.founderShare, label).toBe(1);
      expect(s.rounds, label).toHaveLength(0);
      expect(s.loan, label).toBeNull();
    }
  });

  it('a leveraged company under water gets a lifeline that offers nothing, not the whole company for $10k', () => {
    // founder alone, $400k owed, −$10k in the bank: floor −$258k, operating 0, value 0
    const s = createGame(1);
    s.rooms.push(room('finance'));
    s.loan = { id: 'l', principal: 400_000, annualRate: 0.04, startDay: 0, dueDay: 1080, rolledOver: false };
    ledger.recordCapex(s, CONFIG.start.cash + 10_000);
    s.valuation = computeValuation(s);
    expect(s.valuation.floor).toBeLessThan(0);
    expect(s.valuation.value).toBe(0);
    const card = openKnock(s, true);
    if (!card) throw new Error('no card');
    expect(card.kind).toBe('desperation');
    expect(card.data.amount).toBe(0);
    expect(card.data.share).toBe(0);
    expect(card.choices.find((c) => c.id === 'equity')?.disabled).toBe(true);
    expect(dispatch(s, { type: 'card', choiceId: 'equity' }).ok).toBe(false);
    expect(dispatch(s, { type: 'card', choiceId: 'decline' }).ok).toBe(true);
    expect(s.founderShare).toBe(1);
    expect(s.rounds).toHaveLength(0);
    expect(s.cash).toBe(-10_000);
  });

  it('desperation knock fires when runway < 2 months and respects the cooldown', () => {
    const s = createGame(1);
    s.schedule.knocks = 1; // DESIGN.md 10: no lifeline before investors have knocked once on their own schedule
    s.people.push(person(s, 'product', 3, 28_000)); // runway 50/28 ≈ 1.8 months
    expect(selectors.runwayMonths(s)).toBeLessThan(C.desperationRunwayMonths);
    advanceDay(s);
    expect(s.day).toBe(1);
    expect(s.card?.kind).toBe('desperation');
    expect(s.schedule.lastDesperationDay).toBe(1);
    expect(dispatch(s, { type: 'card', choiceId: 'decline' }).ok).toBe(true);
    // stop before the day-60 close: cash goes negative there and game.ts opens its own crisis lifeline
    advanceTo(s, C.desperationCooldownDays - 1);
    expect(s.day).toBe(C.desperationCooldownDays - 1);
    expect(s.card).toBeNull(); // no second lifeline inside the cooldown
  });

  it('the scheduled knock opens on nextKnockDay and reschedules', () => {
    const s = createGame(7);
    const d = s.schedule.nextKnockDay;
    expect(d).toBeGreaterThanOrEqual(C.firstKnockDay[0]);
    expect(d).toBeLessThanOrEqual(C.firstKnockDay[1]);
    advanceTo(s, d + 5);
    expect(s.day).toBe(d);
    expect(s.card?.kind).toBe('knock');
    expect(s.schedule.nextKnockDay).toBeGreaterThanOrEqual(d + C.knockEveryDays[0]);
    expect(s.schedule.nextKnockDay).toBeLessThanOrEqual(d + C.knockEveryDays[1]);
  });

  it('is deterministic: same seed, same knock', () => {
    const a = createGame(11);
    const b = createGame(11);
    advanceTo(a, 400);
    advanceTo(b, 400);
    expect(a.card).not.toBeNull();
    expect(JSON.stringify(a.card)).toBe(JSON.stringify(b.card));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('capital: loans', () => {
  it('loan choice needs a Finance room and no loan outstanding', () => {
    const s = createGame(1);
    s.rooms.push(room('finance'));
    const card = openKnock(s, false);
    if (!card) throw new Error('no card');
    const loanChoice = card.choices.find((c) => c.id === 'loan');
    expect(loanChoice?.disabled).toBeFalsy();
    expect(loanChoice?.detail).toBe(`$100k at ${(C.loanBaseRate * 100).toFixed(1)}% a year, due in ${C.loanTermMonths} months`);
    expect(dispatch(s, { type: 'card', choiceId: 'loan' }).ok).toBe(true);

    const again = openKnock(s, false);
    const second = again?.choices.find((c) => c.id === 'loan');
    expect(second?.disabled).toBe(true);
    expect(second?.reason).toBe('One loan at a time');
    expect(canDispatch(s, { type: 'card', choiceId: 'loan' }).ok).toBe(false);
  });

  it('creates the loan through the ledger and accrues interest daily through advanceDay', () => {
    const s = takeLoan();
    expect(s.loan).not.toBeNull();
    if (!s.loan) return;
    expect(s.loan.principal).toBe(100_000);
    expect(s.loan.annualRate).toBeCloseTo(C.loanBaseRate, 10);
    expect(s.loan.startDay).toBe(0);
    expect(s.loan.dueDay).toBe(C.loanTermMonths * D);
    expect(s.loan.rolledOver).toBe(false);
    expect(s.cash).toBe(CONFIG.start.cash + 100_000);
    expect(s.book.fin.loanIn).toBe(100_000);
    expect(s.founderShare).toBe(1);

    advanceDay(s);
    const dailyInterest = (100_000 * C.loanBaseRate) / 12 / D;
    expect(s.book.pnl.interest).toBeCloseTo(dailyInterest, 6);
    expect(s.book.cf.interest).toBeCloseTo(dailyInterest, 6);
    expect(s.cash).toBeCloseTo(CONFIG.start.cash + 100_000 - dailyInterest, 6);

    advanceTo(s, D);
    expect(ledger.checkIdentities(s.history[0])).toEqual([]);
    expect(s.history[0].pnl.interest).toBeCloseTo(dailyInterest * D, 4);
  });

  it('maturity: repaid automatically when the cash is there', () => {
    const s = takeLoan();
    if (!s.loan) throw new Error('no loan');
    s.loan.dueDay = s.day + 1;
    advanceDay(s);
    expect(s.loan).toBeNull();
    expect(s.card).toBeNull();
    expect(s.book.fin.loanRepaid).toBe(100_000);
    expect(s.visuals.some((v) => v.t === 'toast' && v.text.includes('repaid'))).toBe(true);
    expect(s.log.some((l) => l.text.includes('repaid'))).toBe(true);
  });

  it('maturity: one rollover at +3%, then default is game over', () => {
    const s = takeLoan();
    if (!s.loan) throw new Error('no loan');
    ledger.recordCapex(s, 140_000); // cash now $10k < principal
    s.loan.dueDay = s.day + 1;
    advanceDay(s);
    expect(s.card?.kind).toBe('maturity');
    const rollover = s.card?.choices.find((c) => c.id === 'rollover');
    expect(rollover?.disabled).toBeFalsy();
    expect(s.card?.choices.map((c) => c.id)).toEqual(['repay', 'rollover', 'default']);
    // not a close day: nothing can land under the card, so there is no repaying $100k with $10k
    expect(s.card?.choices[0].disabled).toBe(true);
    expect(s.card?.choices[0].reason).toContain('$10k');
    expect(canDispatch(s, { type: 'card', choiceId: 'repay' }).ok).toBe(false);
    expect(s.card?.body).not.toContain('before this month');

    const oldDue = s.loan.dueDay;
    const oldRate = s.loan.annualRate;
    expect(dispatch(s, { type: 'card', choiceId: 'rollover' }).ok).toBe(true);
    expect(s.card).toBeNull();
    expect(s.status).toBe('playing');
    expect(s.loan.dueDay).toBe(oldDue + C.rolloverMonths * D);
    expect(s.loan.annualRate).toBeCloseTo(oldRate + C.rolloverPremium, 10);
    expect(s.loan.rolledOver).toBe(true);
    expect(s.loan.principal).toBe(100_000);

    s.loan.dueDay = s.day + 1;
    advanceDay(s);
    expect(s.card?.kind).toBe('maturity');
    const second = s.card?.choices.find((c) => c.id === 'rollover');
    expect(second?.disabled).toBe(true);
    expect(second?.reason).toBeTruthy();
    expect(canDispatch(s, { type: 'card', choiceId: 'rollover' }).ok).toBe(false);
    expect(dispatch(s, { type: 'card', choiceId: 'default' }).ok).toBe(true);
    expect(s.status).toBe('gameOver');
    expect(s.card).toBeNull();
    expect(s.result).toMatchObject({ kind: 'gameOver', score: 0, debt: 100_000 });
    expect(s.result?.reason).toMatch(/loan/i);
    const day = s.day;
    advanceDay(s);
    expect(s.day).toBe(day); // the clock stops
  });

  for (const choiceId of ['repay', 'rollover', 'default']) {
    it(`maturity on a close day: the billing landed under the card, so '${choiceId}' repays the loan`, () => {
      // DESIGN.md 10 keys the maturity on the cash; the card opened with $85k but the close billed $60k under it
      const s = maturityAtClose(200);
      expect(s.history, 'the close ran under the open card').toHaveLength(1);
      expect(s.cash, 'and the billing covered the principal').toBeGreaterThanOrEqual(100_000);
      expect(s.card?.body).toContain("before this month's subscriptions are billed");
      expect(s.card?.body).toContain('$85k');
      expect(s.card?.choices.map((c) => c.id)).toEqual(['repay', 'rollover', 'default']);
      expect(s.card?.choices[0].disabled).toBeFalsy();
      expect(canDispatch(s, { type: 'card', choiceId: 'repay' }).ok).toBe(true);
      const before = s.cash;
      expect(dispatch(s, { type: 'card', choiceId }).ok).toBe(true);
      expect(s.card).toBeNull();
      expect(s.status).toBe('playing');
      expect(s.loan).toBeNull();
      expect(s.cash).toBe(before - 100_000);
      expect(s.book.fin.loanRepaid).toBe(100_000);
      expect(s.log.at(-1)?.text).toMatch(/repaid/i);
      expect(s.visuals.some((v) => v.t === 'toast' && v.text.includes('repaid'))).toBe(true);
      // the repayment sits in the new month, and the books still reconcile at the next close
      advanceTo(s, 2 * D);
      expect(s.history).toHaveLength(2);
      expect(s.history[0].debtEnd).toBe(100_000);
      expect(s.history[1].fin.loanRepaid).toBe(100_000);
      expect(s.history[1].debtEnd).toBe(0);
      for (const b of s.history) expect(ledger.checkIdentities(b), `month ${b.month}`).toEqual([]);
    });
  }

  it("maturity on a close day: when the billing falls short, Repay gets the bank's answer: one rollover, then the call", () => {
    const s = maturityAtClose(20); // about $6k of billing: still short
    expect(s.history).toHaveLength(1);
    expect(s.cash).toBeLessThan(100_000);
    expect(dispatch(s, { type: 'card', choiceId: 'repay' }).ok).toBe(true);
    expect(s.status).toBe('playing');
    expect(s.loan?.rolledOver).toBe(true);
    expect(s.loan?.dueDay).toBe(D + C.rolloverMonths * D);
    expect(s.loan?.annualRate).toBeCloseTo(C.loanBaseRate + C.rolloverPremium, 10);
    expect(s.book.fin.loanRepaid).toBe(0);
    expect(s.log.at(-1)?.text).toMatch(/did not cover/);

    // the second maturity, on a close day again, with the cash still short: the bank calls it in
    if (!s.loan) throw new Error('no loan');
    s.loan.dueDay = 2 * D;
    advanceTo(s, 2 * D);
    expect(s.card?.kind).toBe('maturity');
    expect(s.history).toHaveLength(2);
    expect(s.cash).toBeLessThan(100_000);
    expect(s.card?.choices.find((c) => c.id === 'rollover')?.disabled).toBe(true);
    expect(s.card?.choices.find((c) => c.id === 'repay')?.disabled).toBeFalsy();
    expect(dispatch(s, { type: 'card', choiceId: 'repay' }).ok).toBe(true);
    expect(s.status).toBe('gameOver');
    expect(s.result).toMatchObject({ kind: 'gameOver', score: 0, debt: 100_000 });
    expect(s.result?.reason).toMatch(/billing/);
  });

  it('prepay: any time the cash covers the principal, no penalty', () => {
    const s = createGame(1);
    expect(canPrepay(s).ok).toBe(false);
    expect(canDispatch(s, { type: 'prepayLoan' }).ok).toBe(false);

    const t = takeLoan();
    expect(canPrepay(t).ok).toBe(true);
    expect(dispatch(t, { type: 'prepayLoan' }).ok).toBe(true);
    expect(t.loan).toBeNull();
    expect(t.cash).toBe(CONFIG.start.cash);
    expect(t.book.fin.loanRepaid).toBe(100_000);
    expect(t.book.fin.loanIn).toBe(100_000);
    expect(canPrepay(t).ok).toBe(false);

    const u = takeLoan();
    ledger.recordCapex(u, 140_000);
    const v = canPrepay(u);
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('$100k');
  });
});

// ---------------------------------------------------------------- exit

describe('exit', () => {
  it('cannot sell before day 720', () => {
    const s = createGame(1);
    const v = canSell(s);
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('You can sell from the start of year 3');
    expect(dispatch(s, { type: 'sell' }).ok).toBe(false);
    expect(s.status).toBe('playing');
    expect(scorePreview(s)).toEqual({
      offer: s.valuation.value,
      founderShare: 1,
      debt: 0,
      score: s.valuation.value,
      sellFromDay: CONFIG.exit.sellFromDay,
    });
  });

  it('sell from day 720: offer = value, score = offer × founder share', () => {
    const s = createGame(3);
    runTo(s, CONFIG.exit.sellFromDay, 'equity'); // first knock: take the money, then decline the rest
    expect(s.status).toBe('playing');
    expect(s.day).toBeGreaterThanOrEqual(CONFIG.exit.sellFromDay);
    expect(s.founderShare).toBeLessThan(1);
    expect(s.rounds).toHaveLength(1);
    expect(canSell(s).ok).toBe(true);

    const preview = scorePreview(s);
    expect(preview.offer).toBe(s.valuation.value);
    expect(preview.score).toBeCloseTo(s.valuation.value * s.founderShare, 6);

    expect(dispatch(s, { type: 'sell' }).ok).toBe(true);
    expect(s.status).toBe('sold');
    expect(s.result).toMatchObject({ kind: 'sold', day: s.day, offer: preview.offer, founderShare: preview.founderShare, debt: 0 });
    expect(s.result?.score).toBeCloseTo(preview.score, 6);
    expect(s.log.at(-1)?.tone).toBe('good');
    const day = s.day;
    advanceDay(s);
    expect(s.day).toBe(day);
    expect(dispatch(s, { type: 'sell' }).ok).toBe(false);
  });

  it('game over fills the debt, scores zero and logs', () => {
    const s = takeLoan();
    const result = gameOver(s, 'test reason');
    expect(s.status).toBe('gameOver');
    expect(s.result).toBe(result);
    expect(result).toMatchObject({ kind: 'gameOver', offer: 0, score: 0, debt: 100_000, founderShare: 1, reason: 'test reason' });
    expect(s.log.at(-1)?.tone).toBe('bad');
    expect(s.log.at(-1)?.text).toContain('test reason');
  });
});

// ---------------------------------------------------------------- hints

describe('why line', () => {
  it('agrees when nothing has happened', () => {
    expect(whyLine(createGame(1))).toBe('Profit and cash agree this month.');
  });

  it('picks receivables when a deal is booked', () => {
    const s = createGame(1);
    ledger.bookEnterpriseDeal(s, 'cust', 30_000, 90);
    expect(whyLine(s)).toBe('Profit up, cash down: $30k is owed to you.');
  });

  it('names collections of old invoices', () => {
    const s = createGame(1);
    const inv = ledger.bookEnterpriseDeal(s, 'cust', 30_000, 90);
    advanceTo(s, D); // new book: the invoice is now "old"
    ledger.collectInvoice(s, inv);
    expect(whyLine(s)).toBe('Cash up, profit flat: $30k of old invoices got paid.');
  });

  it('names a write-off, not a collection', () => {
    const s = createGame(1);
    const inv = ledger.bookEnterpriseDeal(s, 'cust', 30_000, 90);
    advanceTo(s, D);
    ledger.writeOffInvoice(s, inv);
    expect(whyLine(s)).toBe('$30k written off: profit took the hit, cash never had it.');
  });

  it('names capex against its monthly depreciation', () => {
    const s = createGame(1);
    advanceTo(s, D);
    ledger.recordCapex(s, 20_000);
    s.assets.push({ id: 'srv', kind: 'server', cost: 20_000, bookValue: 20_000, lifeMonths: 48, boughtDay: s.day, roomId: null });
    expect(whyLine(s)).toBe('Cash down $20k on assets; profit only sees $417 a month of it.');
  });

  it('names financing', () => {
    const s = createGame(1);
    dispatch(s, { type: 'debug', op: 'cash' });
    expect(whyLine(s)).toBe('$100k came in from investors: cash up, profit untouched.');

    const t = takeLoan();
    expect(whyLine(t)).toBe('$100k came in from the bank: cash up, profit untouched.');
    dispatch(t, { type: 'prepayLoan' });
    expect(whyLine(t)).toBe('Profit and cash agree this month.');
  });

  it('picks the largest item', () => {
    const s = createGame(1);
    ledger.bookEnterpriseDeal(s, 'cust', 30_000, 90);
    dispatch(s, { type: 'debug', op: 'cash' });
    expect(whyLine(s)).toBe('$100k came in from investors: cash up, profit untouched.');
  });

  it('ignores items under $1k', () => {
    const s = createGame(1);
    ledger.bookEnterpriseDeal(s, 'cust', 900, 90);
    expect(whyLine(s)).toBe('Profit and cash agree this month.');
  });
});

describe('hint line', () => {
  it('follows the priority order, first match wins', () => {
    const s = createGame(1);
    expect(hintLine(s)).toBe('Ship a feature: nobody buys an empty product.');

    s.features = 1;
    s.prospects.push(prospect(s));
    expect(selectors.salesCapacityPerMonth(s)).toBe(0);
    expect(hintLine(s)).toBe('An enterprise prospect is waiting in the lobby. Put yourself on sales or hire a rep.');

    s.founderRole = 'sales';
    expect(hintLine(s)).toBe('Nothing owed and nothing bought yet, so the bars agree. Sign an enterprise deal and watch them split.');

    const founder = s.people[0];
    founder.hasLaptop = false;
    expect(hintLine(s)).toBe('You have no laptop and work at half speed.');
    founder.hasLaptop = true;

    const rep = person(s, 'sales', 3, 7_000, { name: 'Ada', hasLaptop: false });
    s.people.push(rep);
    expect(hintLine(s)).toBe('Ada has no laptop and works at half speed.');
    rep.hasLaptop = true;

    for (let i = 0; i < CONFIG.assets.customersPerServer; i++) s.customers.push(smb(s));
    expect(selectors.serversShort(s)).toBe(1);
    expect(hintLine(s)).toBe('Servers are short: outage risk every month.');
    s.assets.push({ id: 'srv', kind: 'server', cost: 20_000, bookValue: 20_000, lifeMonths: 48, boughtDay: 0, roomId: null });
    s.customers.length = 0; // the runway step below assumes no subscription income

    rep.baseSalary = 20_000;
    const runway = selectors.runwayMonths(s);
    expect(runway).not.toBeNull();
    expect(runway).toBeLessThan(3);
    expect(hintLine(s)).toBe(`Runway: ${runway?.toFixed(1)} months. Cut costs; investors knock on their own schedule.`);
    rep.baseSalary = 7_000;

    rep.raisePending = true;
    expect(hintLine(s)).toBe('Ada is asking for a raise.');
    rep.raisePending = false;

    ledger.bookEnterpriseDeal(s, 'cust', 30_000, 90);
    expect(s.financeUnlocked).toBe(true);
    expect(hintLine(s)).toBe('$30k is owed to you. A Finance room gets you paid faster.');
    s.rooms.push(room('finance'));

    s.features = 3;
    expect(hintLine(s)).toBe('Visitors are a trickle. Open Marketing.');
    s.rooms.push(room('marketing'));

    s.ticketsServedShare = 0.5;
    expect(hintLine(s)).toBe('Support is swamped: customers are churning.');
    s.ticketsServedShare = 1;

    s.day = CONFIG.exit.sellFromDay;
    expect(hintLine(s)).toBe(`You can sell any time. Today's offer: ${fmtMoney(s.valuation.value)}.`);
    s.day = 0;

    expect(hintLine(s)).toBe('Watch Profit and Cash flow disagree, then open Books to see why.');

    openKnock(s, false);
    expect(hintLine(s)).toBe('');
    s.card = null;
    s.status = 'gameOver';
    expect(hintLine(s)).toBe('');
  });
});

describe('money formatting', () => {
  it('formats k and M', () => {
    expect(fmtMoney(0)).toBe('$0');
    expect(fmtMoney(500)).toBe('$500');
    expect(fmtMoney(30_000)).toBe('$30k');
    expect(fmtMoney(184_000)).toBe('$184k');
    expect(fmtMoney(999_600)).toBe('$1M');
    expect(fmtMoney(1_250_000)).toBe('$1.3M');
    expect(fmtMoney(2_000_000)).toBe('$2M');
    expect(fmtMoney(12_400_000)).toBe('$12M');
    expect(fmtMoney(-15_000)).toBe('−$15k');
  });
});
