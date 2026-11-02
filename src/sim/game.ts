/**
 * The clock and the dispatcher. DESIGN.md section 14 is the prose form of this file.
 * Sub-systems live in their own modules; this file only orders them.
 */
import { CONFIG } from './config';
import { chance, randInt, seedRng } from './rng';
import * as L from './ledger';
import * as S from './selectors';
import * as staff from './staff';
import * as rooms from './rooms';
import * as assets from './assets';
import * as product from './product';
import * as customers from './customers';
import * as valuation from './valuation';
import * as capital from './capital';
import * as events from './events';
import * as exit from './exit';
import { no, OK, ROLES } from './types';
import type { Action, ActionRecord, Candidate, GameState, Person, Role, Room, Verdict } from './types';

const D = CONFIG.time.daysPerMonth;

export interface CreateOptions {
  companyName?: string;
}

export function createGame(seed: number, opts: CreateOptions = {}): GameState {
  const emptyCandidates = {} as Record<Role, Candidate[]>;
  for (const r of ROLES) emptyCandidates[r] = [];

  const state: GameState = {
    version: 1,
    seed,
    rng: seedRng(seed),
    day: 0,
    status: 'playing',
    companyName: opts.companyName ?? CONFIG.start.companyName,
    cash: CONFIG.start.cash,
    founderShare: 1,
    loan: null,
    rounds: [],
    founderRole: 'product',
    people: [],
    candidates: emptyCandidates,
    nextId: 1,
    rooms: [],
    floors: 1,
    assets: [],
    customers: [],
    invoices: [],
    prospects: [],
    features: 0,
    featurePoints: 0,
    tier: 1,
    researchPoints: 0,
    adBudget: 0,
    ticketsServedShare: 1,
    book: null as unknown as GameState['book'],
    history: [],
    valuation: null as unknown as GameState['valuation'],
    valueHistory: [],
    effects: {
      competitorUntilFeatures: null,
      pressUntilDay: 0,
      pressMult: 1,
      recessionUntilDay: 0,
      priceCutUntilDay: 0,
      salaryCutUntilDay: 0,
    },
    schedule: {
      nextKnockDay: 0,
      nextEventDay: 0,
      lastDesperationDay: -100000,
      crisisKnockGiven: false,
      pendingSolvencyCheck: false,
    },
    financeUnlocked: false,
    card: null,
    log: [],
    visuals: [],
    actions: [],
    result: null,
  };

  // the garage
  const g = CONFIG.grid.garage;
  const garage: Room = {
    id: 'garage', kind: 'garage', size: 'small', floor: 0, x: g.x, y: g.y, w: g.w, h: g.h,
    rent: CONFIG.rooms.garage.rent, openedDay: 0,
  };
  state.rooms.push(garage);

  // one desk, one laptop
  const deskCfg = CONFIG.assets.catalogue.desk;
  state.assets.push({ id: `a${state.nextId++}`, kind: 'desk', cost: deskCfg.price, bookValue: deskCfg.price, lifeMonths: deskCfg.lifeMonths, boughtDay: 0, roomId: 'garage' });
  const lapCfg = CONFIG.assets.catalogue.laptop;
  state.assets.push({ id: `a${state.nextId++}`, kind: 'laptop', cost: lapCfg.price, bookValue: lapCfg.price, lifeMonths: lapCfg.lifeMonths, boughtDay: 0, roomId: null });

  // you
  const founder: Person = {
    id: `p${state.nextId++}`,
    name: CONFIG.start.founderName,
    role: 'product',
    archetype: 'mid',
    quirk: 'loyal',
    skill: CONFIG.start.founderSkill,
    baseSalary: 0,
    morale: CONFIG.people.morale.start,
    roomId: 'garage',
    hiredDay: 0,
    lastRaiseDay: 0,
    raisePending: false,
    raiseRequestedDay: null,
    raiseGrantedDay: null,
    raiseRefusedDay: null,
    founder: true,
    hasLaptop: true,
  };
  state.people.push(founder);

  state.schedule.nextKnockDay = randInt(state.rng, CONFIG.capital.firstKnockDay[0], CONFIG.capital.firstKnockDay[1]);
  state.schedule.nextEventDay = randInt(state.rng, CONFIG.events.firstDay[0], CONFIG.events.firstDay[1]);

  staff.refreshCandidates(state);
  state.book = L.newBook(state, 0, 0);
  state.valuation = valuation.computeValuation(state);
  state.valueHistory = [state.valuation.value];
  state.log.push({ day: 0, text: `${state.companyName} starts in a garage with $${(CONFIG.start.cash / 1000).toFixed(0)}k.`, tone: 'info' });
  return state;
}

// ---------------------------------------------------------------- the clock

/** One game day. Does nothing while a card is open or after the game ended. */
export function advanceDay(state: GameState): void {
  if (state.status !== 'playing' || state.card) return;
  state.day += 1;
  accrueDaily(state);
  staff.dailyStaff(state);
  product.dailyProduct(state);
  customers.dailyCustomers(state);
  events.dailyEffects(state);
  capital.dailyCapital(state);
  if (!state.card) events.dailyEvents(state);
  if (state.day % D === 0) closeMonth(state);
}

function accrueDaily(state: GameState): void {
  const costs = S.monthlyCosts(state);
  L.accrueSalary(state, costs.salaries / D);
  L.accrueRent(state, costs.rent / D);
  L.accrueMarketing(state, costs.marketing / D);
  L.accrueInterest(state, costs.interest / D);
}

export function closeMonth(state: GameState): void {
  customers.monthlyCustomers(state);
  assets.bookMonthlyDepreciation(state);
  staff.monthlyStaff(state);

  const closed = L.closeBook(state);
  state.history.push(closed);
  state.book = L.newBook(state, closed.month + 1, state.day);
  state.valuation = valuation.computeValuation(state);
  closed.valueEnd = state.valuation.value;
  closed.requiredReturnEnd = state.valuation.r;
  state.valueHistory.push(state.valuation.value);
  if (state.valueHistory.length > CONFIG.valuation.historyMonths) state.valueHistory.shift();
  state.visuals.push({ t: 'close', day: state.day, month: closed.month });

  // DESIGN.md 14 step 7: servers short → silent outage risk, rolled after the book is finalised
  // and valued, so the customers it costs are churn in the new month, not the one just closed.
  const short = S.serversShort(state);
  if (short > 0) {
    const p = 1 - Math.pow(1 - CONFIG.assets.outageChancePerMissingServer, short);
    if (chance(state.rng, p)) {
      const lost = customers.loseCustomers(state, CONFIG.assets.outageChurn, 'outage');
      state.visuals.push({ t: 'outage', day: state.day });
      state.log.push({ day: state.day, text: `Servers buckled under load. ${lost} customers left.`, tone: 'bad' });
    }
  }

  if (state.log.length > CONFIG.ui.logLength) state.log.splice(0, state.log.length - CONFIG.ui.logLength);
  solvencyCheck(state);
}

/**
 * Cash below zero at a close: one last desperation knock in this crisis, then game over.
 * Deferred while another card is open; re-run after that card resolves.
 */
export function solvencyCheck(state: GameState): void {
  if (state.status !== 'playing') return;
  if (state.cash >= 0) {
    state.schedule.crisisKnockGiven = false;
    state.schedule.pendingSolvencyCheck = false;
    return;
  }
  if (state.card) {
    state.schedule.pendingSolvencyCheck = true;
    return;
  }
  if (!state.schedule.crisisKnockGiven) {
    const card = capital.openKnock(state, true);
    if (card) {
      state.schedule.crisisKnockGiven = true;
      state.schedule.pendingSolvencyCheck = true;
      return;
    }
  }
  state.schedule.pendingSolvencyCheck = false;
  exit.gameOver(state, 'The bank balance went below zero at month end.');
}

// ---------------------------------------------------------------- actions

export function canDispatch(state: GameState, action: Action): Verdict {
  if (state.status !== 'playing') return no('The game is over.');
  if (action.type === 'card') {
    if (!state.card) return no('No card is open.');
    const c = state.card.choices.find((ch) => ch.id === action.choiceId);
    if (!c) return no('Unknown choice.');
    if (c.disabled) return no(c.reason ?? 'Not available.');
    return OK;
  }
  if (action.type === 'debug') return OK;
  if (state.card) return no('Answer the card first.');
  switch (action.type) {
    case 'hire': return staff.canHire(state, action.candidateId);
    case 'fire': return staff.canFire(state, action.personId);
    case 'raise': return staff.canRaise(state, action.personId);
    case 'founderRole': return staff.canSetFounderRole(state, action.role);
    case 'placeRoom': return rooms.canPlaceRoom(state, action.kind, action.size, action.floor, action.x, action.y);
    case 'closeRoom': return rooms.canCloseRoom(state, action.roomId);
    case 'buyAsset': return assets.canBuy(state, action.kind, action.roomId);
    case 'sellAsset': return assets.canSell(state, action.assetId);
    case 'setAdBudget': {
      if (!S.hasRoom(state, 'marketing')) return no('Open a Marketing room first.');
      if (action.amount < 0 || action.amount > CONFIG.marketing.adMax) return no('Budget out of range.');
      return OK;
    }
    case 'prepayLoan': return capital.canPrepay(state);
    case 'sell': return exit.canSell(state);
  }
}

export function dispatch(state: GameState, action: Action): Verdict {
  const v = canDispatch(state, action);
  if (!v.ok) return v;
  state.actions.push({ day: state.day, action });
  switch (action.type) {
    case 'hire': staff.hire(state, action.candidateId); break;
    case 'fire': staff.fire(state, action.personId, 'fired'); break;
    case 'raise': staff.resolveRaise(state, action.personId, action.grant); break;
    case 'founderRole': staff.setFounderRole(state, action.role); break;
    case 'placeRoom': rooms.placeRoom(state, action.kind, action.size, action.floor, action.x, action.y); break;
    case 'closeRoom': rooms.closeRoom(state, action.roomId); break;
    case 'buyAsset': assets.buy(state, action.kind, action.roomId); break;
    case 'sellAsset': assets.sell(state, action.assetId); break;
    case 'setAdBudget': {
      const step = CONFIG.marketing.adStep;
      state.adBudget = Math.max(0, Math.min(CONFIG.marketing.adMax, Math.round(action.amount / step) * step));
      break;
    }
    case 'card': resolveCard(state, action.choiceId); break;
    case 'prepayLoan': capital.prepayLoan(state); break;
    case 'sell': exit.sellCompany(state); break;
    case 'debug': debugOp(state, action.op); break;
  }
  return OK;
}

function resolveCard(state: GameState, choiceId: string): void {
  const card = state.card;
  if (!card) return;
  if (card.kind === 'event') events.resolveEventCard(state, card, choiceId);
  else if (card.kind === 'knock' || card.kind === 'desperation' || card.kind === 'maturity') capital.resolveCapitalCard(state, card, choiceId);
  if (state.card === card) state.card = null;
  if (state.schedule.pendingSolvencyCheck) solvencyCheck(state);
}

function debugOp(state: GameState, op: Extract<Action, { type: 'debug' }>['op']): void {
  switch (op) {
    case 'cash':
      // a rich uncle: cash in, no dilution, booked as financing so the identities hold
      L.recordEquity(state, 100_000);
      state.log.push({ day: state.day, text: 'Debug: +$100k.', tone: 'info' });
      break;
    case 'knock':
      if (!state.card) capital.openKnock(state, false);
      break;
    case 'event':
      if (!state.card) events.openEvent(state);
      break;
    case 'feature':
      product.shipFeature(state);
      break;
    case 'tenCustomers':
      customers.addCustomersDebug(state, 10);
      break;
  }
}

// ---------------------------------------------------------------- replay

/** Advance until the given day (no-op if a card blocks the clock). */
export function advanceTo(state: GameState, day: number): void {
  let guard = 0;
  while (state.day < day && state.status === 'playing' && !state.card && guard++ < 100000) advanceDay(state);
}

/** Rebuild a state from seed + action log. Same inputs → identical state. */
export function replay(seed: number, actions: ActionRecord[], opts: CreateOptions = {}): GameState {
  const state = createGame(seed, opts);
  for (const rec of actions) {
    advanceTo(state, rec.day);
    dispatch(state, rec.action);
  }
  return state;
}
