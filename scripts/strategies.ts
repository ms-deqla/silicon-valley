/**
 * Headless strategies for the balance harness (scripts/balance.ts) and the
 * cross-cutting tests (test/identities, test/determinism, test/balance).
 *
 * Everything here talks to the sim through its public API (src/sim/index.ts)
 * only, so the strategies can do exactly what a player at the UI can do and
 * nothing more. DESIGN.md section 16 names the five scripted strategies.
 *
 * Contract: the harness asks a Strategy once per game day for the actions it
 * wants, dispatches the ones canDispatch accepts (in order, re-checking before
 * each), then advances the day. While a card blocks the clock the strategy is
 * asked again on the same day, so every strategy answers open cards first.
 */
import { ASSET_KINDS, CONFIG, ROLES, advanceDay, canDispatch, createGame, dispatch, selectors as S, validSpots } from '../src/sim';
import type { Action, Candidate, Card, CardChoice, GameState, MonthBook, Person, Role, RoomSize } from '../src/sim';

export type Strategy = { name: string; act(state: GameState): Action[] };

const D = CONFIG.time.daysPerMonth;

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

const roomFull = (state: GameState, roomId: string, max: number): boolean => S.desksIn(state, roomId).length >= max;

/**
 * One step toward one more hire in `role`: hire when a seat exists, else add a
 * desk to a department room with spare capacity, else open a room of `size`.
 * Returns at most one action (DESIGN.md 6: hiring needs a free desk in that role's room or the garage).
 */
function hireStep(state: GameState, role: Role, choose: Chooser, size: RoomSize, affordable: (c: Candidate) => boolean): Action | null {
  const cand = choose(state.candidates[role].filter(affordable));
  if (!cand) return null;
  const hire: Action = { type: 'hire', candidateId: cand.id };
  if (ok(state, hire)) return hire;
  const rooms = S.roomsOf(state, role);
  for (const room of rooms) {
    if (roomFull(state, room.id, S.roomMaxDesks(room))) continue;
    const desk: Action = { type: 'buyAsset', kind: 'desk', roomId: room.id };
    if (ok(state, desk)) return desk;
  }
  if (rooms.every((room) => roomFull(state, room.id, S.roomMaxDesks(room)))) return firstSpot(state, role, size);
  return null;
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

// ---------------------------------------------------------------- the five strategies

/** Never acts: the founder codes alone in the garage. Declines investors; picks the no-cash event option. */
export const idle: Strategy = {
  name: 'idle',
  act(state) {
    const card = answerCard(state, {
      knock: () => 'decline',
      // "Wait" costs nothing for the late payer; for every other event the second option is the one without a bill (DESIGN.md 11)
      event: (_s, c) => (c.eventType === 'latePayer' ? 0 : 1),
    });
    return card ? [card] : [];
  },
};

/** A small product room, then the cheapest engineer whenever three months of costs are covered. First equity knock accepted. */
export const engineerFirst: Strategy = {
  name: 'engineerFirst',
  act(state) {
    const card = answerCard(state, {
      knock: (s) => (s.rounds.length === 0 ? 'equity' : 'decline'),
      event: () => 0,
    });
    if (card) return [card];
    const out: Action[] = [];
    const push = (a: Action | null): void => { if (a) out.push(a); };
    if (!S.hasRoom(state, 'product')) {
      push(firstSpot(state, 'product', 'small'));
      return out;
    }
    push(laptopStep(state));
    out.push(...raiseSteps(state, (s) => runwayWith(s) > 3));
    push(hireStep(state, 'product', bySalary, 'small', (c) => runwayWith(state, c.salary) > 3));
    return out;
  },
};

/** Founder on sales from day 1; a rep as soon as possible, then support, then more of whichever is thinner. */
export const salesFirst: Strategy = {
  name: 'salesFirst',
  act(state) {
    const card = answerCard(state, {
      knock: (s) => (runwayWith(s) < 6 ? 'equity' : 'decline'),
      event: () => 0,
    });
    if (card) return [card];
    const out: Action[] = [];
    const push = (a: Action | null): void => { if (a) out.push(a); };
    if (state.founderRole !== 'sales') push(okOrNull(state, { type: 'founderRole', role: 'sales' }));
    push(laptopStep(state));
    out.push(...raiseSteps(state, (s) => runwayWith(s) > 3));
    const afford = (months: number) => (c: Candidate): boolean => runwayWith(state, c.salary) > months;
    if (hired(state, 'sales') === 0) push(hireStep(state, 'sales', bySalary, 'small', afford(3)));
    else if (hired(state, 'support') === 0) push(hireStep(state, 'support', bySalary, 'small', afford(3)));
    else if (runwayWith(state) > 6) {
      const role: Role = hired(state, 'sales') <= hired(state, 'support') ? 'sales' : 'support';
      push(hireStep(state, role, byValue, 'small', afford(6)));
    }
    return out;
  },
};

/** Tunables of the balanced strategy (strategy taste, not sim rules). */
export const BALANCED = {
  adBudget: 5_000,
  coffeeCash: 60_000,
  rndCash: 150_000,
  /** months of costs that must stay covered after a hire or a room */
  buildRunway: 3,
  growRunway: 6,
  supportServedMin: 0.85,
};

function balancedEvent(state: GameState, card: Card): number {
  const cushion = monthlyCost(state) * 2;
  switch (card.eventType) {
    case 'outage': return state.cash - CONFIG.events.outageFix > cushion ? 0 : 1; // emergency fix when affordable
    case 'press': return state.cash - CONFIG.events.prPush > cushion ? 0 : 1; // PR push when affordable
    case 'recession': return 1; // hold the line: morale is worth more than 10% of salaries
    default: return 0; // wait / out-build / counter-offer
  }
}

/**
 * Product room + engineer, then marketing with $5k ads, then sales, then support,
 * servers when short, coffee once cash > $60k, equity knocks taken, finance room
 * once unlocked, nothing ever sold. Growth after that is demand-led.
 */
export const balanced: Strategy = {
  name: 'balanced',
  act(state) {
    const card = answerCard(state, { knock: () => 'equity', event: balancedEvent });
    if (card) return [card];
    const out: Action[] = [];
    const push = (a: Action | null): void => { if (a) out.push(a); };
    const afford = (months: number) => (c: Candidate): boolean => runwayWith(state, c.salary) > months;

    // maintenance that can share a day with a build step
    push(laptopStep(state));
    out.push(...raiseSteps(state, (s) => runwayWith(s) > BALANCED.buildRunway));
    push(adStep(state, runwayWith(state, BALANCED.adBudget - state.adBudget) > BALANCED.buildRunway ? BALANCED.adBudget : 0));
    push(serverStep(state, 1.5));
    if (!S.hasCoffee(state) && state.cash > BALANCED.coffeeCash) push(okOrNull(state, { type: 'buyAsset', kind: 'coffee' }));

    // one build step per day, in order
    const build = (): Action | null => {
      if (!S.hasRoom(state, 'product')) return firstSpot(state, 'product', 'small');
      if (hired(state, 'product') < 1) return hireStep(state, 'product', byValue, 'small', afford(BALANCED.buildRunway));
      if (!S.hasRoom(state, 'marketing')) {
        return runwayWith(state, CONFIG.rooms.size.small.rent) > BALANCED.buildRunway ? firstSpot(state, 'marketing', 'small') : null;
      }
      if (hired(state, 'marketing') < 1) return hireStep(state, 'marketing', byValue, 'small', afford(BALANCED.buildRunway));
      if (hired(state, 'sales') < 1) return hireStep(state, 'sales', byValue, 'small', afford(BALANCED.buildRunway));
      if (hired(state, 'support') < 1) return hireStep(state, 'support', byValue, 'small', afford(BALANCED.buildRunway));
      if (state.financeUnlocked && !S.hasRoom(state, 'finance')) {
        return runwayWith(state, CONFIG.rooms.size.small.rent) > BALANCED.buildRunway ? firstSpot(state, 'finance', 'small') : null;
      }
      if (state.financeUnlocked && hired(state, 'finance') < 1) return hireStep(state, 'finance', bySalary, 'small', afford(BALANCED.buildRunway + 1));
      // growth, demand-led
      if (runwayWith(state) <= BALANCED.growRunway) return null;
      const grow = afford(BALANCED.growRunway);
      if (S.servedShareNow(state) < BALANCED.supportServedMin) return hireStep(state, 'support', byValue, 'small', grow);
      if (state.prospects.length > S.salesCapacityPerMonth(state)) return hireStep(state, 'sales', byValue, 'small', grow);
      if (hired(state, 'product') < 3) return hireStep(state, 'product', byValue, 'small', grow);
      if (hired(state, 'marketing') < 2 && runwayWith(state) > BALANCED.growRunway * 1.5) return hireStep(state, 'marketing', byValue, 'small', afford(BALANCED.growRunway * 1.5));
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

export const strategyList: readonly Strategy[] = [idle, engineerFirst, salesFirst, balanced, reckless];
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

export interface RunResult {
  state: GameState;
  trace: MonthTrace[];
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

/**
 * Play `months` months of a fresh game with `strategy`. Returns the final state
 * (status playing, gameOver or sold) and one trace row per closed month.
 * Throws when the clock stalls, i.e. a card stays unanswered.
 */
export function runStrategy(seed: number, strategy: Strategy, months: number, opts: RunOptions = {}): RunResult {
  const state = createGame(seed);
  const trace: MonthTrace[] = [];
  const targetDay = months * D;
  const stallLimit = opts.stallLimit ?? 8;
  let stalls = 0;
  while (state.status === 'playing' && state.day < targetDay) {
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
  return { state, trace };
}
