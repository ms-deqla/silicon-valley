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

/** Monthly rent a hire into this role would add today (a new small room when no room has a free desk or desk space). */
export function roomRentForHire(state: GameState, role: Role): number {
  if (S.seatFor(state, role)) return 0;
  if (state.rooms.some((r) => r.kind === role && assets.canBuy(state, 'desk', r.id).ok)) return 0;
  return rooms.roomRent(role, 'small');
}

export function canHireRole(state: GameState, role: Role): Verdict {
  if (!RULES.roles.includes(role)) return no('Not in this game.');
  const spec = RULES.hire[role];
  const needed = spec.salary + setupCost(state, role);
  if (state.cash < needed) return no(`Not enough cash: ${fmtMoney(needed)} for the first month and the setup.`);
  if (!S.seatFor(state, role) && !state.rooms.some((r) => r.kind === role && assets.canBuy(state, 'desk', r.id).ok) && !rooms.autoSpot(state, role)) {
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

/** Fires the most recent hire in the role with three months' severance (DESIGN.md 6). */
export function fireRole(state: GameState, role: Role): void {
  const people = state.people.filter((p) => !p.founder && p.role === role);
  if (people.length === 0) return;
  people.sort((a, b) => b.hiredDay - a.hiredDay || (b.id > a.id ? 1 : -1));
  staff.fire(state, people[0].id, 'fired');
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
