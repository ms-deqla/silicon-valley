/**
 * Headless strategies for the balance harness (scripts/balance.ts) and the
 * cross-cutting tests (test/identities, test/determinism, test/balance).
 *
 * Everything here talks to the sim through its public API (src/sim/index.ts)
 * only, so the strategies can do exactly what a player at the UI can do and
 * nothing more. DESIGN.md section 16 names the five engine strategies (idle,
 * engineerFirst, salesFirst, balanced, reckless) and the tournament ones (tIdle,
 * tPlayer, tTakeAll, tDeclineAll, tAggressive).
 *
 * Two rulesets (RULES in config.ts): the engine strategies play the full engine
 * (every department, raises, quits, loans, ads, all six events), the tournament
 * strategies the published game of DESIGN.md 0 and use nothing but its actions
 * (hireRole, fireRole, servers, buyDemoRoom, card answers). runStrategy switches
 * RULES to the strategy's ruleset for the run and puts the caller's back after.
 *
 * Contract: the harness asks a Strategy once per game day for the actions it
 * wants, dispatches the ones canDispatch accepts (in order, re-checking before
 * each), then advances the day. While a card blocks the clock the strategy is
 * asked again on the same day, so every strategy answers open cards first.
 */
import { ASSET_KINDS, CONFIG, EVENT_TYPES, ROLES, RULES, advanceDay, canDispatch, createGame, dispatch, hintLine, roomRentForHire, selectors as S, setupCost, validSpots } from '../src/sim';
import type { Action, Candidate, Card, CardChoice, CardKind, GameState, MonthBook, Person, Role, RoomSize, Rules } from '../src/sim';

/** Which ruleset a strategy plays under: the full engine (DESIGN.md 1–16) or the published tournament (DESIGN.md 0). */
export type Engine = 'full' | 'tournament';

export type Strategy = { name: string; engine: Engine; act(state: GameState): Action[] };

const D = CONFIG.time.daysPerMonth;

// ---------------------------------------------------------------- rulesets

/** The published ruleset exactly as config.ts declares it, copied at module load before any test setup or run touches RULES. */
const TOURNAMENT_RULES: Rules = JSON.parse(JSON.stringify(RULES)) as Rules;

/** Switch RULES to the full engine: every department, raises, quits, loans, Finance, R&D, the ad budget, all six events (the fields test/setup.ts sets). */
export function applyFullEngine(): void {
  RULES.roles = [...ROLES];
  RULES.raises = true;
  RULES.quits = true;
  RULES.loans = true;
  RULES.finance = true;
  RULES.rnd = true;
  RULES.adBudget = true;
  RULES.founderRole = true;
  RULES.sell = true;
  RULES.events = [...EVENT_TYPES];
}

/** Switch RULES back to the published tournament ruleset (DESIGN.md 0), from the copy taken at module load. */
export function applyTournamentRules(): void {
  Object.assign(RULES, JSON.parse(JSON.stringify(TOURNAMENT_RULES)) as Rules);
}

export function applyEngine(engine: Engine): void {
  if (engine === 'full') applyFullEngine();
  else applyTournamentRules();
}

// ---------------------------------------------------------------- cards

export type KnockWant = 'equity' | 'loan' | 'decline';

export interface CardRules {
  /** What to do with an investor knock (scheduled or desperation). */
  knock(state: GameState, card: Card): KnockWant;
  /** Index into the enabled choices of an event card, in the order DESIGN.md 11 lists them. */
  event(state: GameState, card: Card): number;
}

// Choice ids and labels belong to the capital/events modules; match them by words rather than exact ids.
const RE_LOAN = /loan|debt|borrow|credit/i;
const RE_DECLINE = /decline|refuse|reject|\bpass\b|\bno\b|not now|walk away|later/i;
const RE_EQUITY = /equity|share|stake|round|invest|accept|take|sell/i;
const RE_REPAY = /repay|pay/i;
const RE_ROLL = /roll|extend|renew/i;

const choiceText = (c: CardChoice): string => `${c.id} ${c.label}`;
const enabledChoices = (card: Card): CardChoice[] => card.choices.filter((c) => !c.disabled);

function knockChoice(card: Card, want: KnockWant): CardChoice | undefined {
  const en = enabledChoices(card);
  const loans = en.filter((c) => RE_LOAN.test(choiceText(c)));
  const declines = en.filter((c) => RE_DECLINE.test(choiceText(c)) && !loans.includes(c));
  const equities = en.filter((c) => RE_EQUITY.test(choiceText(c)) && !loans.includes(c) && !declines.includes(c));
  const other = en.filter((c) => !loans.includes(c) && !declines.includes(c));
  switch (want) {
    case 'equity': return equities[0] ?? other[0] ?? en[0];
    // the loan is greyed out without a Finance room or with one outstanding (DESIGN.md 10): fall back to equity
    case 'loan': return loans[0] ?? equities[0] ?? other[0] ?? en[0];
    case 'decline': return declines[0] ?? en[en.length - 1];
  }
}

/** Maturity: repay when the bank lets us, else roll over; never refuse (that is game over, DESIGN.md 10). */
function maturityChoice(card: Card): CardChoice | undefined {
  const en = enabledChoices(card);
  return en.find((c) => RE_REPAY.test(choiceText(c)) && !RE_ROLL.test(choiceText(c)))
    ?? en.find((c) => RE_ROLL.test(choiceText(c)))
    ?? en[0];
}

/** The card answer a strategy with these rules gives, or null when no card is open / nothing is answerable. */
export function answerCard(state: GameState, rules: CardRules): Action | null {
  const card = state.card;
  if (!card) return null;
  let choice: CardChoice | undefined;
  switch (card.kind) {
    case 'knock':
    case 'desperation':
      choice = knockChoice(card, rules.knock(state, card));
      break;
    case 'maturity':
      choice = maturityChoice(card);
      break;
    case 'event': {
      const en = enabledChoices(card);
      choice = en[Math.max(0, Math.min(rules.event(state, card), en.length - 1))];
      break;
    }
    default:
      choice = enabledChoices(card)[0]; // gameOver / sold: nothing to decide, canDispatch says so
  }
  if (!choice) return null;
  const action: Action = { type: 'card', choiceId: choice.id };
  return canDispatch(state, action).ok ? action : null;
}

// ---------------------------------------------------------------- shared steps

const ok = (state: GameState, action: Action): boolean => canDispatch(state, action).ok;
const okOrNull = (state: GameState, action: Action): Action | null => (ok(state, action) ? action : null);
const monthlyCost = (state: GameState): number => S.monthlyCosts(state).total;

/** Months of cash at today's cost run-rate plus an extra monthly cost (a salary or rent about to be added). */
function runwayWith(state: GameState, extraMonthly = 0): number {
  const c = monthlyCost(state) + extraMonthly;
  return c <= 0 ? Number.POSITIVE_INFINITY : state.cash / c;
}

/** Today's net burn: costs minus subscription income, the run-rate the HUD's runway reads before any close (selectors.monthlyBurn). */
function netBurn(state: GameState): number {
  let smb = 0;
  for (const c of state.customers) if (c.kind === 'smb') smb += c.monthlyPrice;
  return monthlyCost(state) - smb;
}

/** Months of cash after adding `extraMonthly` of cost at today's net burn; infinite while the company stays cash-positive. */
function runwayAfter(state: GameState, extraMonthly = 0): number {
  const b = netBurn(state) + extraMonthly;
  return b <= 0 ? Number.POSITIVE_INFINITY : state.cash / b;
}

/** Hired staff in a role (the founder is not counted even while playing that role). */
const hired = (state: GameState, role: Role): number => S.peopleIn(state, role).filter((p) => !p.founder).length;

/** The first valid placement for a room of this kind and size, floor 0 first. */
function firstSpot(state: GameState, kind: Role | 'demo', size: RoomSize): Action | null {
  const floors: (0 | 1)[] = state.floors === 2 ? [0, 1] : [0];
  for (const floor of floors) {
    for (const spot of validSpots(state, kind, size, floor)) {
      const action: Action = { type: 'placeRoom', kind, size, floor, x: spot.x, y: spot.y };
      if (ok(state, action)) return action;
    }
  }
  return null;
}

type Chooser = (cands: Candidate[]) => Candidate | undefined;
/** Array.prototype.sort is stable, so ties keep the sim's candidate order and stay deterministic. */
const bySalary: Chooser = (c) => [...c].sort((a, b) => a.salary - b.salary)[0];
const byValue: Chooser = (c) => [...c].sort((a, b) => b.skill / b.salary - a.skill / a.salary)[0];
const SENIORITY: Record<Candidate['archetype'], number> = { junior: 0, mid: 1, senior: 2, star: 3 };
const bySeniority: Chooser = (c) => [...c].sort((a, b) => SENIORITY[b.archetype] - SENIORITY[a.archetype] || b.skill - a.skill)[0];
/** The cheapest junior on the board this month, if any (candidates refresh at month end). */
const cheapestJunior: Chooser = (c) => bySalary(c.filter((x) => x.archetype === 'junior'));

const roomFull = (state: GameState, roomId: string, max: number): boolean => S.desksIn(state, roomId).length >= max;

/**
 * One step toward one more hire in `role`: hire when a seat exists, else add a desk (to the
 * garage first when `garage` is set: DESIGN.md 5, the garage seats two of any role rent-free),
 * else to a department room with spare capacity, else open a room of `size`.
 * Returns at most one action (DESIGN.md 6: hiring needs a free desk in that role's room or the garage).
 */
function hireStep(state: GameState, role: Role, choose: Chooser, size: RoomSize, affordable: (c: Candidate) => boolean, garage = false): Action | null {
  const cand = choose(state.candidates[role].filter(affordable));
  if (!cand) return null;
  const hire: Action = { type: 'hire', candidateId: cand.id };
  if (ok(state, hire)) return hire;
  if (garage) {
    for (const g of S.roomsOf(state, 'garage')) {
      if (roomFull(state, g.id, S.roomMaxDesks(g))) continue;
      const desk: Action = { type: 'buyAsset', kind: 'desk', roomId: g.id };
      if (ok(state, desk)) return desk;
    }
  }
  const rooms = S.roomsOf(state, role);
  for (const room of rooms) {
    if (roomFull(state, room.id, S.roomMaxDesks(room))) continue;
    const desk: Action = { type: 'buyAsset', kind: 'desk', roomId: room.id };
    if (ok(state, desk)) return desk;
  }
  if (rooms.every((room) => roomFull(state, room.id, S.roomMaxDesks(room)))) return firstSpot(state, role, size);
  return null;
}

/**
 * Open a `size` room for `role` when its rent plus the cheapest candidate's salary (the hire that
 * follows) still leaves `runway` months in the bank by the `months` measure (cost run-rate by
 * default, net burn for the balanced player). Null when the room exists already.
 */
function roomStep(state: GameState, role: Role, size: RoomSize, runway: number, months: (state: GameState, extra: number) => number = runwayWith): Action | null {
  if (S.hasRoom(state, role)) return null;
  const cheapest = bySalary(state.candidates[role]);
  const salary = cheapest ? cheapest.salary : CONFIG.people.salaries.junior;
  if (months(state, CONFIG.rooms.size[size].rent + salary) <= runway) return null;
  return firstSpot(state, role, size);
}

/** Everyone works at 50% without a laptop (DESIGN.md 6); buy one when nobody has a spare to hand out. */
function laptopStep(state: GameState): Action | null {
  if (!state.people.some((p) => !p.hasLaptop)) return null;
  if (S.spareLaptops(state) > 0) return null;
  return okOrNull(state, { type: 'buyAsset', kind: 'laptop' });
}

function raiseSteps(state: GameState, grant: (state: GameState, p: Person) => boolean): Action[] {
  const out: Action[] = [];
  for (const p of state.people) {
    if (!p.raisePending) continue;
    const action: Action = { type: 'raise', personId: p.id, grant: grant(state, p) };
    if (ok(state, action)) out.push(action);
  }
  return out;
}

/** A server when short (DESIGN.md 7), as long as `keepMonths` of costs stay in the bank afterwards. */
function serverStep(state: GameState, keepMonths: number): Action | null {
  if (S.serversShort(state) <= 0) return null;
  const action: Action = { type: 'buyAsset', kind: 'server' };
  if (!ok(state, action)) return null;
  const after = state.cash - CONFIG.assets.catalogue.server.price;
  return after / Math.max(1, monthlyCost(state)) >= keepMonths ? action : null;
}

function adStep(state: GameState, amount: number): Action | null {
  if (!S.hasRoom(state, 'marketing') || state.adBudget === amount) return null;
  return okOrNull(state, { type: 'setAdBudget', amount });
}

/** The founder works in `role` (DESIGN.md 6: a free generalist assignable to product or sales). */
function founderStep(state: GameState, role: 'product' | 'sales'): Action | null {
  if (state.founderRole === role) return null;
  return okOrNull(state, { type: 'founderRole', role });
}

/** Has an enterprise deal ever been signed? The first invoice is issued at the first signing (DESIGN.md 8). */
const firstDealSigned = (state: GameState): boolean => state.invoices.length > 0;

/**
 * Event answers a sensible human gives (DESIGN.md 11): pay for the fix or the PR push only when two
 * months of costs stay in the bank afterwards; wait for a late payer; out-build a competitor; keep a
 * poached senior; hold the line in a recession (morale is worth more than 10% of salaries).
 */
function sensibleEvent(state: GameState, card: Card): number {
  const cushion = monthlyCost(state) * 2;
  switch (card.eventType) {
    case 'outage': return state.cash - CONFIG.events.outageFix > cushion ? 0 : 1;
    case 'press': return state.cash - CONFIG.events.prPush > cushion ? 0 : 1;
    case 'recession': return 1;
    default: return 0;
  }
}

// ---------------------------------------------------------------- the five strategies

/** Never acts: the founder codes alone in the garage. Declines investors; picks the no-cash event option. */
export const idle: Strategy = {
  name: 'idle',
  engine: 'full',
  act(state) {
    const card = answerCard(state, {
      knock: () => 'decline',
      // "Wait" costs nothing for the late payer; for every other event the second option is the one without a bill (DESIGN.md 11)
      event: (_s, c) => (c.eventType === 'latePayer' ? 0 : 1),
    });
    return card ? [card] : [];
  },
};

/** Tunables of the engineer-first and sales-first strategies (strategy taste, not sim rules). */
export const FOCUSED = {
  /** months of costs that must stay covered after a hire or a room */
  buildRunway: 3,
  /** engineer-first: the founder moves to sales once this many features exist */
  sellFromFeatures: 3,
  /** engineer-first: a support agent from this many customers */
  supportFromCustomers: 30,
  /** engineer-first: takes this many knocks (scheduled or desperation), then declines */
  knocksTaken: 2,
  /** sales-first: the junior engineer is hired from this day (month 2) */
  engineerFromDay: CONFIG.time.daysPerMonth,
};

/**
 * A product person: a small product room with one engineer, desks and laptops for everyone, the
 * founder codes until three features exist and then sells, the first two knocks of any kind are
 * taken, a support agent arrives at thirty customers. No marketing, ever.
 */
export const engineerFirst: Strategy = {
  name: 'engineerFirst',
  engine: 'full',
  act(state) {
    const card = answerCard(state, {
      knock: (s) => (s.rounds.length < FOCUSED.knocksTaken ? 'equity' : 'decline'),
      event: sensibleEvent,
    });
    if (card) return [card];
    const out: Action[] = [];
    const push = (a: Action | null): void => { if (a) out.push(a); };
    const afford = (c: Candidate): boolean => runwayWith(state, c.salary) > FOCUSED.buildRunway;

    push(founderStep(state, state.features >= FOCUSED.sellFromFeatures ? 'sales' : 'product'));
    push(laptopStep(state));
    out.push(...raiseSteps(state, (s) => runwayWith(s) > FOCUSED.buildRunway));
    push(serverStep(state, 1.5));

    const build = (): Action | null => {
      if (!S.hasRoom(state, 'product')) return roomStep(state, 'product', 'small', FOCUSED.buildRunway);
      if (hired(state, 'product') < 1) return hireStep(state, 'product', byValue, 'small', afford);
      if (state.customers.length >= FOCUSED.supportFromCustomers && hired(state, 'support') < 1) {
        return hireStep(state, 'support', byValue, 'small', afford);
      }
      return null;
    };
    push(build());
    return out;
  },
};

/**
 * A sales person: the founder sells from day 1 and keeps the product moving with one junior
 * engineer at the second garage desk from month 2; after the first signed deal a small sales
 * room and a rep; every knock taken.
 */
export const salesFirst: Strategy = {
  name: 'salesFirst',
  engine: 'full',
  act(state) {
    const card = answerCard(state, { knock: () => 'equity', event: sensibleEvent });
    if (card) return [card];
    const out: Action[] = [];
    const push = (a: Action | null): void => { if (a) out.push(a); };
    const afford = (c: Candidate): boolean => runwayWith(state, c.salary) > FOCUSED.buildRunway;

    push(founderStep(state, 'sales'));
    push(laptopStep(state));
    out.push(...raiseSteps(state, (s) => runwayWith(s) > FOCUSED.buildRunway));
    push(serverStep(state, 1.5));

    const build = (): Action | null => {
      if (hired(state, 'product') < 1) {
        return state.day >= FOCUSED.engineerFromDay ? hireStep(state, 'product', cheapestJunior, 'small', afford, true) : null;
      }
      if (!firstDealSigned(state)) return null;
      if (!S.hasRoom(state, 'sales')) return roomStep(state, 'sales', 'small', FOCUSED.buildRunway);
      if (hired(state, 'sales') < 1) return hireStep(state, 'sales', byValue, 'small', afford);
      return null;
    };
    push(build());
    return out;
  },
};

/** Tunables of the balanced strategy (strategy taste, not sim rules). */
export const BALANCED = {
  adBudget: 5_000,
  coffeeCash: 60_000,
  rndCash: 150_000,
  /** months of runway (cash ÷ net burn, as the HUD reads it) that must remain after a hire, a room or the ad budget */
  buildRunway: 5,
  /** the first rep is hired at this runway while prospects wait (a deal in the lobby is worth a thinner cushion) */
  repRunway: 4,
  /** with this many prospects waiting, no rep and a round in the bank, the rep comes before the marketing room */
  repBeforeMarketingProspects: 2,
  growRunway: 6,
  supportServedMin: 0.85,
  /** the first support agent from this many customers (tickets exist: DESIGN.md 8) */
  supportFromCustomers: 10,
  /** the founder pitches waiting prospects from this many features (close probability needs features) */
  sellFromFeatures: 3,
  /** a scheduled knock is taken while burning with less than this many months of runway... */
  raiseBelowRunway: 12,
  /** ...or with less than this many months of costs in the bank; a desperation knock is always taken */
  raiseBelowCostMonths: 6,
};

/**
 * DESIGN.md 10: a desperation knock means the runway is under two months, so the money is taken.
 * A scheduled knock is taken while the company burns with under a year of runway or holds under
 * six months of costs; a profitable company with cash in the bank keeps its equity.
 */
function balancedKnock(state: GameState, card: Card): KnockWant {
  if (card.kind === 'desperation') return 'equity';
  const runway = S.runwayMonths(state);
  if (runway !== null && runway < BALANCED.raiseBelowRunway) return 'equity';
  if (runwayWith(state) < BALANCED.raiseBelowCostMonths) return 'equity';
  return 'decline';
}

/**
 * A junior engineer at the second garage desk on day 1 (no rent until the first money comes in),
 * marketing with $5k of ads once rent and a marketer leave five months of runway (in practice
 * after the first knock); the first rep comes before marketing once a round is in the bank and
 * two prospects queue in the lobby (at a four-month cushion: a deal in the lobby is worth the
 * bet), else after the marketer; the founder pitches while more prospects wait than the hired
 * reps can work; support from ten customers, finance once unlocked, servers when short, coffee
 * once cash > $60k, nothing ever sold. Growth after that is demand-led. Every spend is gated on
 * the runway the HUD shows (cash ÷ net burn), the number a careful founder watches. Knocks per
 * balancedKnock; events per sensibleEvent.
 */
export const balanced: Strategy = {
  name: 'balanced',
  engine: 'full',
  act(state) {
    const card = answerCard(state, { knock: balancedKnock, event: sensibleEvent });
    if (card) return [card];
    const out: Action[] = [];
    const push = (a: Action | null): void => { if (a) out.push(a); };
    const afford = (months: number) => (c: Candidate): boolean => runwayAfter(state, c.salary) > months;

    // the founder sells while more prospects wait than the hired reps can work in a month (none hired: any
    // prospect; DESIGN.md 8: a rep works output × 0.5 deals a month), else codes
    let repCapacity = 0;
    for (const p of S.peopleIn(state, 'sales')) if (!p.founder) repCapacity += CONFIG.customers.dealsPerRepOutput * S.outputOf(state, p);
    const pitch = state.prospects.length > repCapacity && state.features >= BALANCED.sellFromFeatures;
    push(founderStep(state, pitch ? 'sales' : 'product'));

    // maintenance that can share a day with a build step
    push(laptopStep(state));
    out.push(...raiseSteps(state, (s) => runwayAfter(s) > BALANCED.buildRunway));
    push(adStep(state, runwayAfter(state, BALANCED.adBudget - state.adBudget) > BALANCED.buildRunway ? BALANCED.adBudget : 0));
    push(serverStep(state, 1.5));
    if (!S.hasCoffee(state) && state.cash > BALANCED.coffeeCash) push(okOrNull(state, { type: 'buyAsset', kind: 'coffee' }));

    // one build step per day, in order
    const build = (): Action | null => {
      if (hired(state, 'product') < 1) return hireStep(state, 'product', bySalary, 'small', afford(BALANCED.buildRunway), true);
      // the first rep: before marketing once a round is in the bank and prospects queue, else after the marketer
      const repWanted = hired(state, 'sales') < 1 && state.prospects.length > 0;
      if (repWanted && state.rounds.length > 0 && state.prospects.length >= BALANCED.repBeforeMarketingProspects) {
        return hireStep(state, 'sales', byValue, 'small', afford(BALANCED.repRunway));
      }
      if (!S.hasRoom(state, 'marketing')) return roomStep(state, 'marketing', 'small', BALANCED.buildRunway, runwayAfter);
      if (hired(state, 'marketing') < 1) return hireStep(state, 'marketing', bySalary, 'small', afford(BALANCED.buildRunway));
      if (repWanted) return hireStep(state, 'sales', byValue, 'small', afford(BALANCED.repRunway));
      if (hired(state, 'support') < 1 && state.customers.length >= BALANCED.supportFromCustomers) {
        return hireStep(state, 'support', byValue, 'small', afford(BALANCED.buildRunway));
      }
      if (state.financeUnlocked && !S.hasRoom(state, 'finance')) return roomStep(state, 'finance', 'small', BALANCED.buildRunway, runwayAfter);
      if (state.financeUnlocked && hired(state, 'finance') < 1) return hireStep(state, 'finance', bySalary, 'small', afford(BALANCED.buildRunway + 1));
      // growth, demand-led
      if (runwayAfter(state) <= BALANCED.growRunway) return null;
      const grow = afford(BALANCED.growRunway);
      if (S.servedShareNow(state) < BALANCED.supportServedMin) return hireStep(state, 'support', byValue, 'small', grow);
      if (state.prospects.length > S.salesCapacityPerMonth(state)) return hireStep(state, 'sales', byValue, 'small', grow);
      if (hired(state, 'product') < 3) return hireStep(state, 'product', byValue, 'small', grow);
      if (hired(state, 'marketing') < 2 && runwayAfter(state) > BALANCED.growRunway * 1.5) return hireStep(state, 'marketing', byValue, 'small', afford(BALANCED.growRunway * 1.5));
      if (hired(state, 'rnd') < 1 && state.cash > BALANCED.rndCash) return hireStep(state, 'rnd', byValue, 'small', afford(BALANCED.growRunway * 2));
      return null;
    };
    push(build());
    return out;
  },
};

/** Tunables of the reckless strategy (strategy taste, not sim rules). */
export const RECKLESS = {
  /** a senior is "affordable" with this many months of their salary in the bank */
  salaryCover: 2,
};

/** Large rooms, seniors in every department as fast as cash allows, demo room early, max ads, no investors. */
export const reckless: Strategy = {
  name: 'reckless',
  engine: 'full',
  act(state) {
    const card = answerCard(state, { knock: () => 'decline', event: () => 0 });
    if (card) return [card];
    const out: Action[] = [];
    const push = (a: Action | null): void => { if (a) out.push(a); };
    push(laptopStep(state));
    out.push(...raiseSteps(state, () => true));
    push(adStep(state, CONFIG.marketing.adMax));
    push(serverStep(state, 0));
    if (!S.hasCoffee(state)) push(okOrNull(state, { type: 'buyAsset', kind: 'coffee' }));
    // demo room early: as soon as there is a sales room and the price leaves a month of costs in the bank
    if (!S.hasDemoRoom(state) && S.hasRoom(state, 'sales') && state.cash >= CONFIG.assets.catalogue.demoRoom.price + monthlyCost(state)) {
      push(firstSpot(state, 'demo', 'small'));
    }
    // seniors (or stars) in every department, one step a day: the large room opens the day a senior is affordable
    const senior = (c: Candidate): boolean => c.archetype === 'senior' || c.archetype === 'star';
    for (const role of ROLES) {
      const cand = bySeniority(state.candidates[role].filter(senior));
      if (!cand || state.cash < cand.salary * RECKLESS.salaryCover) continue;
      const step = hireStep(state, role, bySeniority, 'large', senior);
      if (step) { out.push(step); break; }
    }
    // out of floor space with departments still missing → the second floor
    if (state.floors === 1 && ROLES.some((r) => !S.hasRoom(state, r)) && !firstSpot(state, 'product', 'large')) {
      push(okOrNull(state, { type: 'buyAsset', kind: 'secondFloor' }));
    }
    return out;
  },
};

/** The five engine strategies of DESIGN.md 16; they play the full engine (`pnpm balance --full`). */
export const engineStrategies: readonly Strategy[] = [idle, engineerFirst, salesFirst, balanced, reckless];

// ---------------------------------------------------------------- the tournament strategies (DESIGN.md 0 and 16)

/** Tunables of the tournament strategies (strategy taste, not sim rules). */
export const TOURNAMENT = {
  /** the first support agent from this many customers (tickets exist: DESIGN.md 8) */
  supportFromCustomers: 10,
  /** a rep, a marketer or an agent is hired only when the cash left after the setup covers this many months of the cost run-rate the hire creates */
  hireCoverMonths: 3,
  /** the marketer is hired once the hint line points at Marketing (DESIGN.md 13: "Open Marketing"), under the cash rule; matched by this word */
  marketingHint: /marketing/i,
  /** the demo room once the bank holds more than this */
  demoRoomCash: 100_000,
  /** a server is bought when servers are short and this many months of costs stay in the bank afterwards */
  serverKeepMonths: 1,
  /** tPlayer: investor knocks taken, then every later scheduled knock declined; a lifeline (desperation knock) is always taken */
  knocksTaken: 2,
  /** tDeclineAll plans for no round: its hires need this many months of cover instead of hireCoverMonths */
  unfundedCoverMonths: 6,
};

/** The department's fixed hire (DESIGN.md 0: desk, laptop and room come by themselves) when cash and the lot allow it. */
const hireRoleStep = (state: GameState, role: Role): Action | null => okOrNull(state, { type: 'hireRole', role });

/**
 * DESIGN.md 16's careful human: a hire only when the cash left after its setup (desk, laptop) covers
 * hireCoverMonths of the new cost run-rate, i.e. today's costs plus the salary and the rent of the
 * room the hire would open (both as the board shows them: tournament.setupCost / roomRentForHire).
 */
function canCoverHire(state: GameState, role: Role, coverMonths: number): boolean {
  const after = state.cash - setupCost(state, role);
  const runRate = monthlyCost(state) + RULES.hire[role].salary + roomRentForHire(state, role);
  return after >= coverMonths * runRate;
}

/** One engineer, hired on the first day the strategy acts (day 0). */
const firstEngineer = (state: GameState): Action | null => (hired(state, 'product') < 1 ? hireRoleStep(state, 'product') : null);

/** An engineer every month cash allows: one hire per calendar month, no catch-up for a month that could not afford one. */
function engineerEveryMonth(state: GameState): Action | null {
  const month = S.monthIndex(state.day);
  const hiredThisMonth = state.people.some((p) => !p.founder && p.role === 'product' && S.monthIndex(p.hiredDay) === month);
  return hiredThisMonth ? null : hireRoleStep(state, 'product');
}

/**
 * The tournament player's other moves (DESIGN.md 16): a rep when a prospect waits, none is hired and
 * the cash covers three months of the new run-rate; a marketer once the hint line says "Open
 * Marketing" (the game's own advice, DESIGN.md 13) under the same cash rule; support from ten
 * customers under the same cash rule. One hire a day, in that order (the hint itself puts the
 * waiting prospect before marketing). A server whenever servers are short and the cash allows (a
 * month of costs stays in the bank); the demo room once cash tops $100k; the assets can share the day.
 */
function tournamentSteps(state: GameState, coverMonths: number): Action[] {
  const out: Action[] = [];
  const push = (a: Action | null): void => { if (a) out.push(a); };
  push(serverStep(state, TOURNAMENT.serverKeepMonths));
  if (!S.hasDemoRoom(state) && state.cash > TOURNAMENT.demoRoomCash) push(okOrNull(state, { type: 'buyDemoRoom' }));
  if (state.prospects.length > 0 && hired(state, 'sales') < 1) {
    if (canCoverHire(state, 'sales', coverMonths)) push(hireRoleStep(state, 'sales'));
  } else if (hired(state, 'marketing') < 1 && TOURNAMENT.marketingHint.test(hintLine(state))) {
    if (canCoverHire(state, 'marketing', coverMonths)) push(hireRoleStep(state, 'marketing'));
  } else if (state.customers.length >= TOURNAMENT.supportFromCustomers && hired(state, 'support') < 1 && canCoverHire(state, 'support', coverMonths)) {
    push(hireRoleStep(state, 'support'));
  }
  return out;
}

/**
 * A tournament strategy: nothing but the tournament actions, servers and card answers (DESIGN.md 0).
 * `engineers` is its engineering policy, `knock` its answer to investors, `coverMonths` the cash
 * cover its hires need; events per sensibleEvent (the tournament only has the late payer, press and
 * outage: wait, and pay for the push or the fix when two months of costs stay in the bank).
 */
function tournamentStrategy(name: string, knock: CardRules['knock'], engineers: (state: GameState) => Action | null, coverMonths = (): number => TOURNAMENT.hireCoverMonths): Strategy {
  return {
    name,
    engine: 'tournament',
    act(state) {
      const card = answerCard(state, { knock, event: sensibleEvent });
      if (card) return [card];
      const out: Action[] = [];
      const engineer = engineers(state);
      if (engineer) out.push(engineer);
      out.push(...tournamentSteps(state, coverMonths()));
      return out;
    },
  };
}

/** The idle founder under tournament rules: never acts, declines investors, picks the no-cash event option. */
export const tIdle: Strategy = {
  name: 'tIdle',
  engine: 'tournament',
  act(state) {
    const card = answerCard(state, { knock: () => 'decline', event: (_s, c) => (c.eventType === 'latePayer' ? 0 : 1) });
    return card ? [card] : [];
  },
};

/**
 * DESIGN.md 16: a careful human who follows the game's own advice. A scheduled knock is taken while
 * fewer than knocksTaken rounds are in the bank and declined after; a lifeline (DESIGN.md 10: the
 * desperation knock at under two months of runway) is always taken, since declining it is the end
 * of the company and no careful founder picks that at a card.
 */
function playerKnock(state: GameState, card: Card): KnockWant {
  if (card.kind === 'desperation') return 'equity';
  return state.rounds.length < TOURNAMENT.knocksTaken ? 'equity' : 'decline';
}

/**
 * DESIGN.md 16's scripted tournament player, a plausible careful human who follows the hint line: an
 * engineer on day 0; a rep only when a prospect waits and the cash covers three months of the new cost
 * run-rate; a marketer once the hint says "Open Marketing", under the same cash rule; support from ten
 * customers under the same cash rule; a server when short and the cash allows; the demo room once cash
 * tops $100k; the first two investor knocks taken, every later scheduled knock declined, every lifeline
 * taken.
 */
export const tPlayer: Strategy = tournamentStrategy('tPlayer', playerKnock, firstEngineer);

/** tPlayer, but every knock is taken. */
export const tTakeAll: Strategy = tournamentStrategy('tTakeAll', () => 'equity', firstEngineer);

/** tPlayer's moves for a founder who plans for no round (unfundedCoverMonths of cover per hire), every knock declined. */
export const tDeclineAll: Strategy = tournamentStrategy('tDeclineAll', () => 'decline', firstEngineer, () => TOURNAMENT.unfundedCoverMonths);

/** An engineer every month cash allows on top of tPlayer's other moves, every knock taken. */
export const tAggressive: Strategy = tournamentStrategy('tAggressive', () => 'equity', engineerEveryMonth);

/** The tournament strategies of DESIGN.md 16; they play the published rules (`pnpm balance`). */
export const tournamentStrategies: readonly Strategy[] = [tIdle, tPlayer, tTakeAll, tDeclineAll, tAggressive];

export const strategyList: readonly Strategy[] = [...engineStrategies, ...tournamentStrategies];
export const STRATEGIES: Readonly<Record<string, Strategy>> = Object.fromEntries(strategyList.map((s) => [s.name, s]));

// ---------------------------------------------------------------- random-but-valid policy (tests)

/** mulberry32: a tiny PRNG for the policy's own dice, so the sim's state.rng is never touched by the test driver. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Per-day probabilities of each random move. */
export interface RandomPolicyOptions {
  hire?: number;
  room?: number;
  closeRoom?: number;
  buy?: number;
  sellAsset?: number;
  adBudget?: number;
  fire?: number;
  raise?: number;
  founderRole?: number;
  prepay?: number;
  sellCompany?: number;
  /** spend (hire / room) only while cash covers this many months of costs; keeps runs alive longer */
  spendRunway?: number;
}

const RANDOM_DEFAULTS: Required<RandomPolicyOptions> = {
  hire: 0.03, room: 0.012, closeRoom: 0.003, buy: 0.03, sellAsset: 0.01, adBudget: 0.02, fire: 0.008,
  raise: 0.1, founderRole: 0.004, prepay: 0.01, sellCompany: 0.0004, spendRunway: 2,
};

/**
 * A random-but-valid player: each day, with small probability, hire a random
 * candidate, place a random valid room, buy a random asset, sell a random asset,
 * set the ad budget, fire someone, answer raises and cards at random — every
 * action checked with canDispatch before it is emitted. Deterministic given
 * `policySeed` and the sequence of states it sees.
 */
export function randomStrategy(policySeed: number, options: RandomPolicyOptions = {}): Strategy {
  const p = { ...RANDOM_DEFAULTS, ...options };
  const rnd = mulberry32(policySeed);
  const pick = <T>(arr: readonly T[]): T | undefined => (arr.length ? arr[Math.floor(rnd() * arr.length)] : undefined);
  const roomKinds: readonly (Role | 'demo')[] = [...ROLES, 'demo'];
  const sizes: readonly RoomSize[] = ['small', 'large'];
  const adSteps = Math.floor(CONFIG.marketing.adMax / CONFIG.marketing.adStep);
  return {
    name: 'random',
    engine: 'full',
    act(state) {
      const out: Action[] = [];
      const consider = (a: Action): void => { if (ok(state, a)) out.push(a); };
      if (state.card) {
        const choice = pick(enabledChoices(state.card));
        if (choice) consider({ type: 'card', choiceId: choice.id });
        return out; // nothing else dispatches while a card is open
      }
      const canSpend = runwayWith(state) > p.spendRunway;
      if (rnd() < p.hire && canSpend) {
        const role = pick(ROLES);
        const cand = role ? pick(state.candidates[role]) : undefined;
        if (cand) {
          const hire: Action = { type: 'hire', candidateId: cand.id };
          if (ok(state, hire)) out.push(hire);
          else {
            // no seat for them: a desk in a random room that takes the role is the valid move toward that hire
            const room = pick(state.rooms.filter((r) => S.roomAcceptsRole(r, cand.role)));
            if (room) consider({ type: 'buyAsset', kind: 'desk', roomId: room.id });
          }
        }
      }
      if (rnd() < p.room && canSpend) {
        const kind = pick(roomKinds) ?? 'product';
        const size = pick(sizes) ?? 'small';
        const floor: 0 | 1 = state.floors === 2 && rnd() < 0.5 ? 1 : 0;
        const spot = pick(validSpots(state, kind, size, floor));
        if (spot) consider({ type: 'placeRoom', kind, size, floor, x: spot.x, y: spot.y });
      }
      if (rnd() < p.closeRoom) {
        const room = pick(state.rooms);
        if (room) consider({ type: 'closeRoom', roomId: room.id });
      }
      if (rnd() < p.buy) {
        const kind = pick(ASSET_KINDS) ?? 'laptop';
        const room = kind === 'desk' ? pick(state.rooms) : undefined;
        consider(room ? { type: 'buyAsset', kind, roomId: room.id } : { type: 'buyAsset', kind });
      }
      if (rnd() < p.sellAsset) {
        const asset = pick(state.assets);
        if (asset) consider({ type: 'sellAsset', assetId: asset.id });
      }
      if (rnd() < p.adBudget) consider({ type: 'setAdBudget', amount: Math.floor(rnd() * (adSteps + 1)) * CONFIG.marketing.adStep });
      if (rnd() < p.fire) {
        const victim = pick(state.people.filter((x) => !x.founder));
        if (victim) consider({ type: 'fire', personId: victim.id });
      }
      for (const person of state.people) {
        if (person.raisePending && rnd() < p.raise) consider({ type: 'raise', personId: person.id, grant: rnd() < 0.5 });
      }
      if (rnd() < p.founderRole) consider({ type: 'founderRole', role: state.founderRole === 'product' ? 'sales' : 'product' });
      if (rnd() < p.prepay) consider({ type: 'prepayLoan' });
      if (rnd() < p.sellCompany) consider({ type: 'sell' });
      return out;
    },
  };
}

// ---------------------------------------------------------------- the harness

export interface MonthTrace {
  /** 0-based month index of the closed book */
  month: number;
  /** day of the close */
  day: number;
  cash: number;
  profit: number;
  fcf: number;
  value: number;
  founderShare: number;
  /** offer × founder share, the score a Sell on that day would give (DESIGN.md 12) */
  score: number;
  customers: number;
  people: number;
  features: number;
  debt: number;
}

export interface RunOptions {
  /** Empty state.visuals every day, as the UI would; off by default so a run compares equal to its replay. */
  drainVisuals?: boolean;
  /** Called right after a month closes, before the strategy acts again. */
  onClose?: (state: GameState, book: MonthBook) => void;
  /** Called after every advanceDay (also on a day the clock did not move because a card was open). */
  onDay?: (state: GameState) => void;
  /** Iterations in a row without the clock moving before the run is declared stalled (a card nobody answers). */
  stallLimit?: number;
}

/** Pacing milestones of one run (DESIGN.md 16): the day each first happened, and the cards seen. */
export interface Pacing {
  /** day the first feature shipped; null when it never did */
  firstFeatureDay: number | null;
  /** day the first paying customer (SMB or enterprise) appeared */
  firstCustomerDay: number | null;
  /** day the first enterprise prospect stood in the lobby */
  firstProspectDay: number | null;
  /** day the first enterprise deal was signed (its invoice issued) */
  firstDealDay: number | null;
  /** day the first investor card of any kind opened, and which kind it was */
  firstKnockDay: number | null;
  firstKnockKind: 'knock' | 'desperation' | null;
  /** cards seen, by kind */
  cards: Record<CardKind, number>;
  /** the day every card opened, in order (the stretches between them are the pacing of the round) */
  cardDays: number[];
}

export interface RunResult {
  state: GameState;
  trace: MonthTrace[];
  pacing: Pacing;
}

function traceOf(state: GameState, book: MonthBook): MonthTrace {
  return {
    month: book.month,
    day: state.day,
    cash: book.cashEnd,
    profit: book.profit,
    fcf: book.fcf,
    value: book.valueEnd,
    founderShare: state.founderShare,
    score: book.valueEnd * state.founderShare,
    customers: book.customersEnd,
    people: state.people.length,
    features: book.featuresEnd,
    debt: book.debtEnd,
  };
}

function newPacing(): Pacing {
  return {
    firstFeatureDay: null,
    firstCustomerDay: null,
    firstProspectDay: null,
    firstDealDay: null,
    firstKnockDay: null,
    firstKnockKind: null,
    cards: { knock: 0, desperation: 0, maturity: 0, event: 0, gameOver: 0, sold: 0 },
    cardDays: [],
  };
}

/** Record the milestones visible in the state right now; `seenCards` keeps each card counted once. */
function observePacing(state: GameState, pacing: Pacing, seenCards: Set<string>): void {
  if (pacing.firstFeatureDay === null && state.features > 0) pacing.firstFeatureDay = state.day;
  if (pacing.firstCustomerDay === null && state.customers.length > 0) pacing.firstCustomerDay = state.day;
  if (pacing.firstProspectDay === null && state.prospects.length > 0) pacing.firstProspectDay = state.day;
  if (pacing.firstDealDay === null && firstDealSigned(state)) pacing.firstDealDay = state.day;
  const card = state.card;
  if (card && !seenCards.has(card.id)) {
    seenCards.add(card.id);
    pacing.cards[card.kind] += 1;
    if (card.kind === 'knock' || card.kind === 'desperation' || card.kind === 'event' || card.kind === 'maturity') pacing.cardDays.push(card.createdDay);
    if (pacing.firstKnockDay === null && (card.kind === 'knock' || card.kind === 'desperation')) {
      pacing.firstKnockDay = card.createdDay;
      pacing.firstKnockKind = card.kind;
    }
  }
}

/**
 * Play `months` months of a fresh game with `strategy` under the strategy's own ruleset (the full
 * engine or the tournament rules); the caller's RULES are put back afterwards. Returns the final
 * state (status playing, gameOver or sold), one trace row per closed month and the pacing
 * milestones. Throws when the clock stalls, i.e. a card stays unanswered.
 */
export function runStrategy(seed: number, strategy: Strategy, months: number, opts: RunOptions = {}): RunResult {
  const callerRules = JSON.parse(JSON.stringify(RULES)) as Rules;
  applyEngine(strategy.engine);
  try {
    return play(seed, strategy, months, opts);
  } finally {
    Object.assign(RULES, callerRules);
  }
}

function play(seed: number, strategy: Strategy, months: number, opts: RunOptions): RunResult {
  const state = createGame(seed);
  const trace: MonthTrace[] = [];
  const pacing = newPacing();
  const seenCards = new Set<string>();
  const targetDay = months * D;
  const stallLimit = opts.stallLimit ?? 8;
  let stalls = 0;
  while (state.status === 'playing' && state.day < targetDay) {
    // a card opened by yesterday's tick, or by the answer to the previous card, is open now
    observePacing(state, pacing, seenCards);
    const dayBefore = state.day;
    const closedBefore = state.history.length;
    for (const action of strategy.act(state)) {
      if (state.status !== 'playing') break;
      if (canDispatch(state, action).ok) dispatch(state, action);
    }
    advanceDay(state);
    for (let i = closedBefore; i < state.history.length; i++) {
      const book = state.history[i];
      trace.push(traceOf(state, book));
      opts.onClose?.(state, book);
    }
    opts.onDay?.(state);
    if (opts.drainVisuals) state.visuals.length = 0;
    if (state.day === dayBefore) {
      stalls += 1;
      if (stalls > stallLimit) {
        const card = state.card ? `${state.card.kind} "${state.card.title}" [${state.card.choices.map((c) => `${c.id}${c.disabled ? '(off)' : ''}`).join(', ')}]` : 'none';
        throw new Error(`${strategy.name}: clock stalled on day ${state.day} (seed ${seed}); open card: ${card}`);
      }
    } else {
      stalls = 0;
    }
  }
  observePacing(state, pacing, seenCards);
  return { state, trace, pacing };
}
