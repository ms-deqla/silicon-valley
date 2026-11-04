/**
 * The tournament layer (DESIGN.md 0): the four actions the published game offers on
 * top of the engine. One fixed hire per department, auto-provisioned; fire the most
 * recent hire; one demo room placed by itself; the buzzer sells the company.
 */
import type { GameState, Person, Result, Role, Verdict } from './types';
import { no, OK } from './types';
import { CONFIG, RULES } from './config';
import { pick } from './rng';
import * as S from './selectors';
import * as rooms from './rooms';
import * as assets from './assets';
import * as staff from './staff';
import * as valuation from './valuation';
import { sellCompany } from './exit';
import { ARCHETYPE_WORD, FIRST_NAMES, JOB_WORD, LAST_NAMES, fmtMoney, roomName } from './names';

/** Non-founder people working in a department. */
export function headcount(state: GameState, role: Role): number {
  return state.people.filter((p) => !p.founder && p.role === role).length;
}

/** Capex a hire into this role would trigger today: a desk when no free desk exists, a laptop when none is spare. */
export function setupCost(state: GameState, role: Role): number {
  const cat = CONFIG.assets.catalogue;
  const desk = S.seatFor(state, role) ? 0 : cat.desk.price;
  const laptop = S.spareLaptops(state) > 0 ? 0 : cat.laptop.price;
  return desk + laptop;
}

/**
 * A room the role may sit in that still has desk space (the garage or one of the department's
 * rooms): capacity only, never the cash for the desk, so the board's caption and the verdict
 * describe the seat a hire would get rather than whether the desk is affordable today. The cash
 * is checked once, in canHireRole; rooms.ensureSeat buys the desk after that.
 */
function roomWithDeskSpaceFor(state: GameState, role: Role): boolean {
  return assets.roomsWithDeskSpace(state).some((r) => S.roomAcceptsRole(r, role));
}

/** Monthly rent a hire into this role would add today (a new small room when no room has a free desk or desk space). */
export function roomRentForHire(state: GameState, role: Role): number {
  if (S.seatFor(state, role)) return 0;
  if (roomWithDeskSpaceFor(state, role)) return 0;
  return rooms.roomRent(role, 'small');
}

export function canHireRole(state: GameState, role: Role): Verdict {
  if (!RULES.roles.includes(role)) return no('Not in this game.');
  const spec = RULES.hire[role];
  const needed = spec.salary + setupCost(state, role);
  if (state.cash < needed) return no(`Not enough cash: ${fmtMoney(needed)} for the first month and the setup.`);
  if (!S.seatFor(state, role) && !roomWithDeskSpaceFor(state, role) && !rooms.autoSpot(state, role)) {
    return no('No space left on the lot.');
  }
  return OK;
}

/** DESIGN.md 0: hire one fixed person into the role, with desk, laptop and room taken care of. */
export function hireRole(state: GameState, role: Role): Person | null {
  const seat = rooms.ensureSeat(state, role);
  if (!seat) return null;
  const spec = RULES.hire[role];
  const first = pick(state.rng, FIRST_NAMES);
  const last = pick(state.rng, LAST_NAMES);
  const p: Person = {
    id: `p${state.nextId++}`,
    name: `${first} ${last}`,
    role,
    archetype: spec.archetype,
    quirk: 'loyal',
    skill: spec.skill,
    baseSalary: spec.salary,
    morale: CONFIG.people.morale.start,
    roomId: seat.id,
    hiredDay: state.day,
    lastRaiseDay: state.day,
    raisePending: false,
    raiseRequestedDay: null,
    raiseGrantedDay: null,
    raiseRefusedDay: null,
    founder: false,
    hasLaptop: false,
  };
  state.people.push(p);
  assets.assignLaptops(state);
  if (!p.hasLaptop && assets.canBuy(state, 'laptop').ok) assets.buy(state, 'laptop');
  state.visuals.push({ t: 'hire', day: state.day, personId: p.id });
  state.log.push({
    day: state.day,
    text: `Hired ${p.name}, ${ARCHETYPE_WORD[p.archetype].toLowerCase()} ${JOB_WORD[role]} at ${fmtMoney(p.baseSalary)}/mo. Sits in the ${roomName(seat.kind)}.`,
    tone: 'good',
  });
  return p;
}

export function canFireRole(state: GameState, role: Role): Verdict {
  if (headcount(state, role) === 0) return no('Nobody to let go.');
  return OK;
}

/**
 * The person fireRole would let go: the most recent hire in the role. state.people is in hire
 * order (hires push, leavers are spliced out), so that is the last match; ids are not compared,
 * as text 'p96' sorts after 'p100'. The board's "−" tooltip names its person from here, so the
 * screen and the sim can never disagree.
 */
export function lastHire(state: GameState, role: Role): Person | null {
  let last: Person | null = null;
  for (const p of state.people) if (!p.founder && p.role === role) last = p;
  return last;
}

/** DESIGN.md 0: fires the most recent hire in the role, with three months' severance (DESIGN.md 6). */
export function fireRole(state: GameState, role: Role): void {
  const last = lastHire(state, role);
  if (last) staff.fire(state, last.id, 'fired');
}

export function canBuyDemoRoom(state: GameState): Verdict {
  if (S.hasDemoRoom(state)) return no('You already have a demo room.');
  if (state.cash < CONFIG.assets.catalogue.demoRoom.price) return no(`Not enough cash (${fmtMoney(CONFIG.assets.catalogue.demoRoom.price)}).`);
  const spot = rooms.autoSpot(state, 'demo');
  if (!spot) return no('No space left on the lot.');
  return rooms.canPlaceRoom(state, 'demo', 'small', spot.floor, spot.x, spot.y);
}

export function buyDemoRoom(state: GameState): void {
  const spot = rooms.autoSpot(state, 'demo');
  if (!spot) return;
  rooms.placeRoom(state, 'demo', 'small', spot.floor, spot.x, spot.y);
}

/** DESIGN.md 0: the buzzer sells the company at today's value; score = value × founder share. */
export function timeUp(state: GameState): Result {
  state.valuation = valuation.computeValuation(state);
  const result = sellCompany(state);
  result.reason = `Time's up. ${state.companyName} sold for ${fmtMoney(result.offer)}; your share is worth ${fmtMoney(result.score)}.`;
  state.log[state.log.length - 1] = { day: state.day, text: result.reason, tone: 'good' };
  return result;
}
