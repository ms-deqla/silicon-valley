/**
 * DESIGN.md 0: the tournament layer on top of the engine. The four tournament actions
 * (hireRole with its auto-provisioned room, desk and laptop; fireRole; buyDemoRoom; timeUp),
 * the mechanics RULES switches off (loans on knock cards, raises and quits, the dropped
 * events, the ad budget, Finance and R&D), and a scripted 30-month round whose books
 * reconcile at every close and whose action log replays to the identical state.
 *
 * test/setup.ts switches the full engine on for the suite; every test here plays the
 * published ruleset, so beforeEach puts it back. Tests that contrast with the full engine
 * call useFullEngine() themselves.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { CONFIG, EVENT_TYPES, RULES, advanceDay, advanceTo, canDispatch, createGame, dispatch, hintLine, ledger, replay, selectors as S } from '../src/sim';
import type { Action, ActionRecord, Customer, EventType, GameState, Person, Role, RoomKind } from '../src/sim';
import * as tournament from '../src/sim/tournament';
import * as events from '../src/sim/events';
import { openKnock } from '../src/sim/capital';
import { computeValuation } from '../src/sim/valuation';
import { fmtMoney } from '../src/sim/names';
import { useFullEngine, useTournamentRules } from './setup';

const D = CONFIG.time.daysPerMonth;
const A = CONFIG.assets.catalogue;
const SMALL = CONFIG.rooms.size.small;
const FAR = 1_000_000;
/** the round: 30 game months (DESIGN.md 0) */
const ROUND_MONTHS = 30;
/** what the tournament screen can dispatch (DESIGN.md 0) */
const TOURNAMENT_ACTIONS: ReadonlySet<Action['type']> = new Set<Action['type']>(['hireRole', 'fireRole', 'buyAsset', 'buyDemoRoom', 'card', 'timeUp']);

beforeEach(() => {
  useTournamentRules();
});

// ---------------------------------------------------------------- helpers

/** A fresh game with the scheduled knock and event pushed away, so only the tested action moves anything. */
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

/** +$100k per call through the ledger (booked as financing), so the books still reconcile at the close. */
function fund(s: GameState, times: number): void {
  for (let i = 0; i < times; i++) act(s, { type: 'debug', op: 'cash' });
}

const hire = (role: Role): Action => ({ type: 'hireRole', role });
const fire = (role: Role): Action => ({ type: 'fireRole', role });
const staff = (s: GameState): Person[] => s.people.filter((p) => !p.founder);
const roomsOf = (s: GameState, kind: RoomKind) => S.roomsOf(s, kind);
const choiceIds = (s: GameState): string[] => s.card?.choices.map((c) => c.id) ?? [];

/** A readable pointer at the first byte where two snapshots diverge. */
function firstDifference(a: string, b: string): string {
  if (a === b) return 'identical';
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  const lo = Math.max(0, i - 80);
  return `snapshots differ at byte ${i} of ${a.length}/${b.length}:\n  live:   …${a.slice(lo, i + 80)}…\n  replay: …${b.slice(lo, i + 80)}…`;
}

// ---------------------------------------------------------------- hireRole

describe('hireRole (DESIGN 0: one fixed hire per department, auto-provisioned)', () => {
  it('on day 0 the first engineer takes the garage\'s spare desk (desk and laptop as capex, no room, no rent); the second opens a small Product room on the lowest free row and the lobby, and the rent starts', () => {
    const s = game();
    const spec = RULES.hire.product;
    expect(S.hasRoom(s, 'lobby')).toBe(false);
    // the garage desk is the founder's and the only laptop is theirs: the hire needs both, but no room
    // (DESIGN.md 5/6: the garage seats anyone, so its spare desk comes before a room and its rent)
    expect(tournament.setupCost(s, 'product')).toBe(A.desk.price + A.laptop.price);
    expect(tournament.roomRentForHire(s, 'product')).toBe(0);
    expect(canDispatch(s, hire('product'))).toEqual({ ok: true });

    act(s, hire('product'));

    expect(s.rooms.map((r) => r.kind)).toEqual(['garage']);
    expect(S.hasRoom(s, 'lobby')).toBe(false);
    expect(s.visuals.filter((v) => v.t === 'room')).toHaveLength(0);
    expect(S.desksIn(s, 'garage')).toHaveLength(CONFIG.rooms.garage.maxDesks);
    expect(S.freeSeatsIn(s, 'garage')).toBe(0);
    expect(S.laptopsOwned(s)).toBe(2);
    expect(s.book.cf.capex).toBe(A.desk.price + A.laptop.price);
    expect(s.cash).toBe(CONFIG.start.cash - A.desk.price - A.laptop.price);
    // DESIGN.md 9: profit sees capex only as depreciation at the close
    expect(s.book.pnl.depreciation).toBe(0);
    expect(ledger.profitOf(s.book)).toBe(0);

    const [p] = staff(s);
    expect(p).toMatchObject({
      role: 'product', archetype: spec.archetype, skill: spec.skill, baseSalary: spec.salary,
      roomId: 'garage', hasLaptop: true, hiredDay: 0, founder: false, raisePending: false,
    });
    expect(tournament.headcount(s, 'product')).toBe(1);
    expect(s.visuals.some((v) => v.t === 'hire' && v.personId === p.id)).toBe(true);
    expect(s.actions).toEqual([{ day: 0, action: hire('product') }]);
    expect(S.monthlyRent(s)).toBe(0);
    expect(S.monthlySalaries(s)).toBe(spec.salary);

    // the garage is full: the second engineer needs a room, and the board can say so before the hire
    expect(tournament.setupCost(s, 'product')).toBe(A.desk.price + A.laptop.price);
    expect(tournament.roomRentForHire(s, 'product')).toBe(SMALL.rent);
    expect(canDispatch(s, hire('product'))).toEqual({ ok: true });

    act(s, hire('product'));

    const [room] = roomsOf(s, 'product');
    expect(room).toMatchObject({ size: 'small', floor: 0, w: SMALL.w, h: SMALL.h, rent: SMALL.rent, openedDay: 0 });
    // DESIGN.md 5: the garage (0,6) and the lobby (2,6) hold the bottom row; the lowest free 2×2 spot is beside them
    expect(room.y + room.h).toBe(CONFIG.grid.h);
    expect(room.x).toBe(CONFIG.grid.lobby.x + CONFIG.grid.lobby.w);
    expect(s.rooms.map((r) => r.kind).sort()).toEqual(['garage', 'lobby', 'product']);
    expect(roomsOf(s, 'lobby')[0].rent).toBe(0);
    expect(s.visuals.filter((v) => v.t === 'room' && v.op === 'open')).toHaveLength(2);

    expect(S.desksIn(s, room.id)).toHaveLength(1);
    expect(S.laptopsOwned(s)).toBe(3);
    expect(s.book.cf.capex).toBe(2 * (A.desk.price + A.laptop.price));
    expect(s.cash).toBe(CONFIG.start.cash - 2 * (A.desk.price + A.laptop.price));
    expect(s.book.pnl.depreciation).toBe(0);
    expect(ledger.profitOf(s.book)).toBe(0);

    const [, q] = staff(s);
    expect(q).toMatchObject({
      role: 'product', archetype: spec.archetype, skill: spec.skill, baseSalary: spec.salary,
      roomId: room.id, hasLaptop: true, hiredDay: 0, founder: false, raisePending: false,
    });
    expect(tournament.headcount(s, 'product')).toBe(2);
    expect(s.visuals.some((v) => v.t === 'hire' && v.personId === q.id)).toBe(true);
    expect(s.actions).toEqual([{ day: 0, action: hire('product') }, { day: 0, action: hire('product') }]);

    // rent and the salaries accrue from the next day on (DESIGN.md 9: 1/30 a day in both bars)
    expect(S.monthlyRent(s)).toBe(room.rent);
    expect(S.monthlySalaries(s)).toBe(2 * spec.salary);
    advanceDay(s);
    expect(s.book.pnl.rent).toBeCloseTo(room.rent / D, 6);
    expect(s.book.cf.rent).toBeCloseTo(room.rent / D, 6);
    expect(s.book.pnl.salaries).toBeCloseTo((2 * spec.salary) / D, 6);
    expect(s.book.cf.salaries).toBeCloseTo((2 * spec.salary) / D, 6);
  });

  it('every department gets its own fixed person at its own salary: the first in the garage, the second in the department\'s own room', () => {
    for (const role of RULES.roles) {
      const s = game();
      act(s, hire(role));
      const [p] = staff(s);
      expect(p.role).toBe(role);
      expect(p.baseSalary).toBe(RULES.hire[role].salary);
      expect(p.skill).toBe(RULES.hire[role].skill);
      expect(p.archetype).toBe(RULES.hire[role].archetype);
      // DESIGN.md 5/6: the garage seats anyone, so the first hire of any role sits there and no room opens
      expect(p.roomId).toBe('garage');
      expect(roomsOf(s, role)).toHaveLength(0);
      expect(S.monthlyRent(s)).toBe(0);

      act(s, hire(role));
      const [, q] = staff(s);
      expect(q).toMatchObject({ role, baseSalary: RULES.hire[role].salary, skill: RULES.hire[role].skill, archetype: RULES.hire[role].archetype });
      expect(roomsOf(s, role)).toHaveLength(1);
      expect(q.roomId).toBe(roomsOf(s, role)[0].id);
      expect(S.monthlyRent(s)).toBe(SMALL.rent);
    }
  });

  it('the third hire into the same department reuses the room the second opened and adds a desk', () => {
    const s = game();
    act(s, hire('product')); // the garage's spare desk
    act(s, hire('product')); // the garage is full: the Product room opens
    act(s, hire('product')); // a second desk in that room
    const rooms = roomsOf(s, 'product');
    expect(rooms).toHaveLength(1);
    expect(S.desksIn(s, rooms[0].id)).toHaveLength(2);
    expect(staff(s).map((p) => p.roomId)).toEqual(['garage', rooms[0].id, rooms[0].id]);
    expect(staff(s).every((p) => p.hasLaptop)).toBe(true);
    expect(S.laptopsOwned(s)).toBe(4);
    expect(s.book.cf.capex).toBe(3 * (A.desk.price + A.laptop.price));
    expect(S.monthlyRent(s)).toBe(SMALL.rent);
  });

  it('a sixth engineer opens a second room on the next lowest free row (the garage seats one, the first room four)', () => {
    const s = game();
    // DESIGN.md 5: the garage's spare desk first, then the small room fills its four desks
    const seatsBeforeSecondRoom = CONFIG.rooms.garage.maxDesks - 1 + SMALL.maxDesks;
    for (let i = 0; i < seatsBeforeSecondRoom; i++) act(s, hire('product'));
    const [first] = roomsOf(s, 'product');
    expect(roomsOf(s, 'product')).toHaveLength(1);
    expect(S.desksIn(s, first.id)).toHaveLength(SMALL.maxDesks);
    expect(S.freeSeatsIn(s, first.id)).toBe(0);
    expect(S.freeSeatsIn(s, 'garage')).toBe(0);

    act(s, hire('product'));
    const rooms = roomsOf(s, 'product');
    expect(rooms).toHaveLength(2);
    const second = rooms[1];
    // row 5 is blocked by the garage, the lobby and the first room, so the next free 2×2 spot starts on row 4, at the left
    expect(second).toMatchObject({ x: 0, y: CONFIG.grid.garage.y - SMALL.h, floor: 0, size: 'small', rent: SMALL.rent });
    expect(S.desksIn(s, second.id)).toHaveLength(1);
    expect(staff(s)[seatsBeforeSecondRoom].roomId).toBe(second.id);
    expect(S.monthlyRent(s)).toBe(2 * SMALL.rent);
    expect(s.book.cf.capex).toBe((seatsBeforeSecondRoom + 1) * (A.desk.price + A.laptop.price));
  });

  it('refuses with a reason: not enough cash, a department outside the game, no space left on the lot', () => {
    const s = game();
    const needed = RULES.hire.product.salary + tournament.setupCost(s, 'product');
    s.cash = needed - 1;
    expect(canDispatch(s, hire('product'))).toEqual({ ok: false, reason: `Not enough cash: ${fmtMoney(needed)} for the first month and the setup.` });
    expect(dispatch(s, hire('product')).ok).toBe(false);
    expect(staff(s)).toHaveLength(0);
    expect(s.rooms).toHaveLength(1);
    expect(s.actions).toHaveLength(0);
    s.cash = needed;
    expect(canDispatch(s, hire('product'))).toEqual({ ok: true });

    // DESIGN.md 0: Finance and R&D stay in the engine
    for (const role of ['finance', 'rnd'] as const) {
      expect(RULES.roles).not.toContain(role);
      expect(canDispatch(s, hire(role))).toEqual({ ok: false, reason: 'Not in this game.' });
      expect(dispatch(s, hire(role)).ok).toBe(false);
    }
    expect(s.people).toHaveLength(1);

    // the lot: the garage's spare desk, then 40 free cells → ten small rooms → forty engineers, then nowhere to put a desk
    s.cash = 100_000_000;
    const freeCells = CONFIG.grid.w * CONFIG.grid.h - CONFIG.grid.garage.w * CONFIG.grid.garage.h - CONFIG.grid.lobby.w * CONFIG.grid.lobby.h;
    const seats = CONFIG.rooms.garage.maxDesks - 1 + (freeCells / (SMALL.w * SMALL.h)) * SMALL.maxDesks;
    let n = 0;
    while (canDispatch(s, hire('product')).ok) {
      act(s, hire('product'));
      n += 1;
    }
    expect(n).toBe(seats);
    expect(roomsOf(s, 'product')).toHaveLength(freeCells / (SMALL.w * SMALL.h));
    expect(canDispatch(s, hire('product'))).toEqual({ ok: false, reason: 'No space left on the lot.' });
    expect(canDispatch(s, { type: 'buyDemoRoom' })).toEqual({ ok: false, reason: 'No space left on the lot.' });
  });

  it('setupCost and roomRentForHire describe the seat the hire would get whatever the cash: short of cash, the garage\'s spare desk is still a desk, not a room', () => {
    const s = game();
    s.cash = 500;
    expect(tournament.setupCost(s, 'product')).toBe(A.desk.price + A.laptop.price);
    expect(tournament.roomRentForHire(s, 'product')).toBe(0);
    const needed = RULES.hire.product.salary + A.desk.price + A.laptop.price;
    expect(canDispatch(s, hire('product'))).toEqual({ ok: false, reason: `Not enough cash: ${fmtMoney(needed)} for the first month and the setup.` });

    // the same hire with the cash: the garage desk, no room, no rent, as the caption said
    s.cash = needed;
    expect(tournament.roomRentForHire(s, 'product')).toBe(0);
    act(s, hire('product'));
    expect(s.rooms.map((r) => r.kind)).toEqual(['garage']);
    expect(S.monthlyRent(s)).toBe(0);
    expect(staff(s)[0].roomId).toBe('garage');

    // the garage is full now: the next engineer needs a room, with or without the money for it
    s.cash = 500;
    expect(tournament.roomRentForHire(s, 'product')).toBe(SMALL.rent);
    expect(canDispatch(s, hire('product')).ok).toBe(false);
    s.cash = 1_000_000;
    expect(tournament.roomRentForHire(s, 'product')).toBe(SMALL.rent);
    expect(canDispatch(s, hire('product'))).toEqual({ ok: true });
  });

  it('under the full engine Finance (once unlocked, DESIGN 8) and R&D are departments like any other', () => {
    useFullEngine();
    const s = game();
    s.financeUnlocked = true;
    expect(canDispatch(s, hire('finance'))).toEqual({ ok: true });
    expect(canDispatch(s, hire('rnd'))).toEqual({ ok: true });
    act(s, hire('finance')); // the garage's spare desk (DESIGN.md 5/6)
    act(s, hire('rnd')); // the garage is full: an R&D room
    act(s, hire('finance')); // and a Finance room
    expect(staff(s).map((p) => p.role)).toEqual(['finance', 'rnd', 'finance']);
    expect(staff(s).map((p) => p.baseSalary)).toEqual([RULES.hire.finance.salary, RULES.hire.rnd.salary, RULES.hire.finance.salary]);
    expect(roomsOf(s, 'finance')).toHaveLength(1);
    expect(roomsOf(s, 'rnd')).toHaveLength(1);
    expect(staff(s).map((p) => p.roomId)).toEqual(['garage', roomsOf(s, 'rnd')[0].id, roomsOf(s, 'finance')[0].id]);
  });
});

// ---------------------------------------------------------------- fireRole

describe('fireRole (DESIGN 0: the most recent hire leaves with three months of severance)', () => {
  it('removes the most recent hire, pays the severance through the ledger and frees the desk and the laptop', () => {
    const s = game();
    act(s, hire('product')); // day 0: the garage's spare desk (DESIGN.md 5/6)
    advanceTo(s, 3);
    act(s, hire('product')); // day 3: the garage is full, the Product room opens
    advanceTo(s, 5);
    act(s, hire('product')); // day 5: a second desk in that room
    const [first, second, third] = staff(s);
    expect(second.hiredDay).toBe(3);
    expect(third.hiredDay).toBe(5);
    const [room] = roomsOf(s, 'product');
    expect(S.desksIn(s, room.id)).toHaveLength(2);
    const cash = s.cash;
    const capex = s.book.cf.capex;
    expect(canDispatch(s, fire('product'))).toEqual({ ok: true });

    act(s, fire('product'));

    const severance = RULES.hire.product.salary * CONFIG.people.severanceMonths;
    expect(staff(s).map((p) => p.id)).toEqual([first.id, second.id]);
    expect(s.book.pnl.severance).toBe(severance);
    expect(s.book.cf.severance).toBe(severance);
    expect(s.cash).toBe(cash - severance);
    expect(S.desksIn(s, room.id)).toHaveLength(2);
    expect(S.occupantsOf(s, room.id)).toHaveLength(1);
    expect(S.freeSeatsIn(s, room.id)).toBe(1);
    expect(S.freeSeatsIn(s, 'garage')).toBe(0);
    expect(S.spareLaptops(s)).toBe(1);
    expect(s.visuals.some((v) => v.t === 'leave' && v.personId === third.id && v.reason === 'fired')).toBe(true);
    expect(s.actions[s.actions.length - 1]).toEqual({ day: 5, action: fire('product') });

    // the next hire takes the freed desk and the spare laptop: no capex, no new room
    expect(tournament.setupCost(s, 'product')).toBe(0);
    expect(tournament.roomRentForHire(s, 'product')).toBe(0);
    act(s, hire('product'));
    expect(s.book.cf.capex).toBe(capex);
    expect(roomsOf(s, 'product')).toHaveLength(1);
    expect(staff(s)).toHaveLength(3);
    expect(staff(s)[2]).toMatchObject({ roomId: room.id, hasLaptop: true, hiredDay: 5 });
    expect(S.spareLaptops(s)).toBe(0);

    // the books reconcile at the close with the severance in them (DESIGN.md 9)
    advanceTo(s, D);
    expect(s.history).toHaveLength(1);
    expect(s.history[0].pnl.severance).toBe(severance);
    expect(ledger.checkIdentities(s.history[0])).toEqual([]);
  });

  it('fires one person per action, newest first, in that department only', () => {
    const s = game();
    act(s, hire('sales'));
    advanceTo(s, 3);
    act(s, hire('product'));
    advanceTo(s, 6);
    act(s, hire('sales'));
    const [rep1, eng, rep2] = staff(s);
    act(s, fire('sales'));
    expect(staff(s).map((p) => p.id)).toEqual([rep1.id, eng.id]);
    expect(rep2.id).not.toBe(rep1.id);
    act(s, fire('sales'));
    expect(staff(s).map((p) => p.id)).toEqual([eng.id]);
    expect(tournament.headcount(s, 'sales')).toBe(0);
    expect(canDispatch(s, fire('sales'))).toEqual({ ok: false, reason: 'Nobody to let go.' });
    expect(dispatch(s, fire('sales')).ok).toBe(false);
    expect(s.book.cf.severance).toBe(2 * RULES.hire.sales.salary * CONFIG.people.severanceMonths);
    // the empty room stays, rent and all (DESIGN.md 0 has no room closing)
    expect(roomsOf(s, 'sales')).toHaveLength(1);
    expect(S.monthlyRent(s)).toBe(2 * SMALL.rent);
  });

  it('of two hires on the same day the later one leaves, even when their ids straddle a power of ten (hire order, not id text)', () => {
    const s = game();
    s.nextId = 95;
    act(s, hire('product')); // the garage's spare desk
    act(s, hire('product')); // the Product room: its id has one digit more
    const [first, second] = staff(s);
    expect(first.hiredDay).toBe(second.hiredDay);
    expect(Number(second.id.slice(1))).toBeGreaterThan(Number(first.id.slice(1)));
    expect(second.id < first.id).toBe(true); // as text the later id sorts first: the case this test is about
    const [room] = roomsOf(s, 'product');
    expect(first.roomId).toBe('garage');
    expect(second.roomId).toBe(room.id);
    // the board's "−" tooltip names the person from the same function, so it can never disagree with the sim
    expect(tournament.lastHire(s, 'product')).toBe(second);

    act(s, fire('product'));

    expect(staff(s).map((p) => p.id)).toEqual([first.id]);
    expect(tournament.lastHire(s, 'product')).toBe(first);
    expect(s.visuals.some((v) => v.t === 'leave' && v.personId === second.id && v.reason === 'fired')).toBe(true);
    expect(s.visuals.some((v) => v.t === 'leave' && v.personId === first.id)).toBe(false);
    // the Product room's desk is the one freed, not the garage's: the next hire reuses it, no capex, no new room
    expect(S.freeSeatsIn(s, 'garage')).toBe(0);
    expect(S.freeSeatsIn(s, room.id)).toBe(1);
    expect(tournament.setupCost(s, 'product')).toBe(0);
    expect(tournament.roomRentForHire(s, 'product')).toBe(0);
    const capex = s.book.cf.capex;
    act(s, hire('product'));
    expect(s.book.cf.capex).toBe(capex);
    expect(roomsOf(s, 'product')).toHaveLength(1);
    expect(staff(s)[1].roomId).toBe(room.id);
  });

  it('refuses when nobody works in the department and never touches the founder', () => {
    const s = game();
    expect(tournament.lastHire(s, 'product')).toBeNull();
    expect(canDispatch(s, fire('product'))).toEqual({ ok: false, reason: 'Nobody to let go.' });
    expect(dispatch(s, fire('product')).ok).toBe(false);
    expect(s.people).toHaveLength(1);
    expect(s.people[0].founder).toBe(true);
    expect(s.book.cf.severance).toBe(0);
  });
});

// ---------------------------------------------------------------- buyDemoRoom

describe('buyDemoRoom (DESIGN 0: one demo room, placed by itself)', () => {
  it('places one demo room as capex, no rent, and refuses a second', () => {
    const s = game();
    fund(s, 1);
    const cash = s.cash;
    expect(cash).toBeGreaterThan(A.demoRoom.price);
    const dealBefore = S.enterpriseDealValue(s);
    expect(canDispatch(s, { type: 'buyDemoRoom' })).toEqual({ ok: true });

    act(s, { type: 'buyDemoRoom' });

    const [room] = roomsOf(s, 'demo');
    expect(room).toMatchObject({ kind: 'demo', floor: 0, w: CONFIG.rooms.demo.w, h: CONFIG.rooms.demo.h, rent: 0 });
    expect(roomsOf(s, 'demo')).toHaveLength(1);
    const [asset] = S.assetsOfKind(s, 'demoRoom');
    expect(asset).toMatchObject({ kind: 'demoRoom', cost: A.demoRoom.price, bookValue: A.demoRoom.price, roomId: room.id });
    expect(S.hasDemoRoom(s)).toBe(true);
    expect(s.book.cf.capex).toBe(A.demoRoom.price);
    expect(s.cash).toBe(cash - A.demoRoom.price);
    expect(S.monthlyRent(s)).toBe(0);
    // DESIGN.md 7: enterprise deals ×1.3
    expect(S.enterpriseDealValue(s)).toBeCloseTo(dealBefore * CONFIG.assets.demoRoomMult, 6);
    expect(s.actions[s.actions.length - 1]).toEqual({ day: 0, action: { type: 'buyDemoRoom' } });

    expect(canDispatch(s, { type: 'buyDemoRoom' })).toEqual({ ok: false, reason: 'You already have a demo room.' });
    expect(dispatch(s, { type: 'buyDemoRoom' }).ok).toBe(false);
    expect(roomsOf(s, 'demo')).toHaveLength(1);
    expect(S.assetsOfKind(s, 'demoRoom')).toHaveLength(1);
    expect(s.book.cf.capex).toBe(A.demoRoom.price);

    // it depreciates like any asset and the close reconciles
    advanceTo(s, D);
    expect(s.history[0].pnl.depreciation).toBeGreaterThanOrEqual(A.demoRoom.price / A.demoRoom.lifeMonths - 0.01);
    expect(ledger.checkIdentities(s.history[0])).toEqual([]);
  });

  it('needs the cash', () => {
    const s = game();
    s.cash = A.demoRoom.price - 1;
    expect(canDispatch(s, { type: 'buyDemoRoom' })).toEqual({ ok: false, reason: `Not enough cash (${fmtMoney(A.demoRoom.price)}).` });
    expect(dispatch(s, { type: 'buyDemoRoom' }).ok).toBe(false);
    expect(roomsOf(s, 'demo')).toHaveLength(0);
    s.cash = A.demoRoom.price;
    expect(canDispatch(s, { type: 'buyDemoRoom' })).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------- timeUp

describe('timeUp (DESIGN 0: the buzzer sells the company)', () => {
  it('sells at the recomputed value with score = value × founder share and a reason starting "Time\'s up"', () => {
    const s = game();
    advanceTo(s, 4 * D);
    // an equity round first, so the share is below one
    act(s, { type: 'debug', op: 'knock' });
    expect(s.card?.kind).toBe('knock');
    expect(canDispatch(s, { type: 'card', choiceId: 'equity' })).toEqual({ ok: true });
    act(s, { type: 'card', choiceId: 'equity' });
    expect(s.founderShare).toBeLessThan(1);
    expect(s.founderShare).toBeGreaterThan(0);

    // $100k lands; the HUD value is only recomputed at a close, so the buzzer must recompute it
    const stale = s.valuation.value;
    act(s, { type: 'debug', op: 'cash' });
    expect(s.valuation.value).toBe(stale);
    const fresh = computeValuation(s).value;
    expect(fresh).toBeGreaterThan(stale);

    act(s, { type: 'timeUp' });

    expect(s.status).toBe('sold');
    const r = s.result;
    expect(r).not.toBeNull();
    if (!r) return;
    expect(r.kind).toBe('sold');
    expect(r.day).toBe(s.day);
    expect(r.offer).toBe(fresh);
    expect(s.valuation.value).toBe(fresh);
    expect(r.founderShare).toBe(s.founderShare);
    expect(r.score).toBe(r.offer * s.founderShare);
    expect(r.score).toBeLessThan(r.offer);
    expect(r.debt).toBe(0);
    expect(r.reason.startsWith("Time's up")).toBe(true);
    expect(r.reason).toContain(s.companyName);
    expect(s.log[s.log.length - 1]).toEqual({ day: s.day, text: r.reason, tone: 'good' });
    expect(s.actions[s.actions.length - 1]).toEqual({ day: s.day, action: { type: 'timeUp' } });

    // the game is over: nothing dispatches and the clock stands still
    expect(canDispatch(s, { type: 'timeUp' })).toEqual({ ok: false, reason: 'The game is over.' });
    expect(canDispatch(s, hire('product'))).toEqual({ ok: false, reason: 'The game is over.' });
    const day = s.day;
    advanceDay(s);
    expect(s.day).toBe(day);
  });

  it('on day 0 the founder alone sells for the floor and keeps every dollar', () => {
    const s = game();
    act(s, { type: 'timeUp' });
    const r = s.result;
    expect(r).not.toBeNull();
    if (!r) return;
    expect(r.offer).toBe(s.valuation.value);
    expect(r.offer).toBe(s.valuation.floor);
    expect(r.founderShare).toBe(1);
    expect(r.score).toBe(r.offer);
    expect(r.reason.startsWith("Time's up")).toBe(true);
  });
});

// ---------------------------------------------------------------- what RULES switches off

describe('the published ruleset (DESIGN 0: switched off)', () => {
  it('investor cards offer equity or nothing: no loan choice on scheduled or desperation knocks', () => {
    const s = game();
    act(s, { type: 'debug', op: 'knock' });
    expect(s.card?.kind).toBe('knock');
    expect(choiceIds(s)).toEqual(['equity', 'decline']);
    expect(canDispatch(s, { type: 'card', choiceId: 'loan' })).toEqual({ ok: false, reason: 'Unknown choice.' });
    act(s, { type: 'card', choiceId: 'decline' });
    expect(s.card).toBeNull();
    expect(s.loan).toBeNull();

    const desperate = openKnock(s, true);
    expect(desperate?.kind).toBe('desperation');
    expect(desperate?.choices.map((c) => c.id)).toEqual(['equity', 'decline']);
    act(s, { type: 'card', choiceId: 'decline' });

    // the full engine puts the loan on the card (greyed out without a Finance room, DESIGN.md 10)
    useFullEngine();
    const f = game();
    act(f, { type: 'debug', op: 'knock' });
    expect(choiceIds(f)).toEqual(['equity', 'loan', 'decline']);
  });

  /** 24 months with everyone's morale forced to zero every day, a raise long overdue and the quirk that quits soonest. */
  function lowMoraleRun(months: number): { s: GameState; raiseAsked: boolean; minPeople: number } {
    const s = game(5);
    fund(s, 10); // nobody runs out of money: the people are what is tested
    act(s, hire('product'));
    act(s, hire('sales'));
    for (const p of staff(s)) {
      p.quirk = 'mercenary';
      p.lastRaiseDay = -CONFIG.people.raiseEveryMonths * D;
    }
    let raiseAsked = false;
    let minPeople = s.people.length;
    for (let day = 0; day < months * D; day++) {
      for (const p of staff(s)) p.morale = 0;
      advanceDay(s);
      expect(s.card, `day ${s.day}`).toBeNull();
      raiseAsked = raiseAsked || s.people.some((p) => p.raisePending);
      minPeople = Math.min(minPeople, s.people.length);
    }
    return { s, raiseAsked, minPeople };
  }

  it('monthlyStaff never asks for a raise and nobody quits: 24 months at zero morale', () => {
    const { s, raiseAsked, minPeople } = lowMoraleRun(24);
    expect(s.status).toBe('playing');
    expect(s.history).toHaveLength(24);
    expect(raiseAsked).toBe(false);
    expect(minPeople).toBe(3);
    expect(staff(s)).toHaveLength(2);
    expect(staff(s).every((p) => p.morale < CONFIG.people.morale.quitBelow)).toBe(true);
    expect(staff(s).every((p) => p.baseSalary === RULES.hire[p.role].salary)).toBe(true);
    expect(s.visuals.some((v) => v.t === 'leave')).toBe(false);
    expect(s.visuals.some((v) => v.t === 'toast' && /raise|quit/i.test(v.text))).toBe(false);
    expect(s.log.some((l) => /raise|quit/i.test(l.text))).toBe(false);
    for (const b of s.history) expect(ledger.checkIdentities(b), `month ${b.month}`).toEqual([]);
  });

  it('(control) the full engine asks for the overdue raise at the first close', () => {
    useFullEngine();
    const { s, raiseAsked } = lowMoraleRun(2);
    expect(raiseAsked).toBe(true);
    expect(s.log.some((l) => /asking for a raise/.test(l.text))).toBe(true);
  });

  it('only the late payer, press and outage can fire; the competitor, poaching and the recession are off', () => {
    const s = game();
    // a company of every event's minimum size, a senior to poach, an open enterprise invoice to pay late
    act(s, { type: 'debug', op: 'tenCustomers' });
    act(s, { type: 'debug', op: 'tenCustomers' });
    expect(s.customers.length).toBeGreaterThanOrEqual(Math.max(...Object.values(CONFIG.events.minCustomers)));
    const senior: Person = {
      id: `p${s.nextId++}`, name: 'Senior Dev', role: 'product', archetype: 'senior', quirk: 'mercenary', skill: 4.5,
      baseSalary: CONFIG.people.salaries.senior, morale: CONFIG.people.morale.start, roomId: 'garage', hiredDay: 0, lastRaiseDay: 0,
      raisePending: false, raiseRequestedDay: null, raiseGrantedDay: null, raiseRefusedDay: null, founder: false, hasLaptop: true,
    };
    s.people.push(senior);
    const customer: Customer = {
      id: `c${s.nextId++}`, kind: 'enterprise', joinedDay: 0, monthlyPrice: 30_000 / 12, contractValue: 30_000,
      contractEndDay: 12 * D, noRenew: false, servedShare: 1,
    };
    s.customers.push(customer);
    ledger.bookEnterpriseDeal(s, customer.id, customer.contractValue, CONFIG.finance.terms);
    expect(events.poachTargets(s)).toHaveLength(1);
    expect(events.latePayerTarget(s)).not.toBeNull();

    const E = CONFIG.events;
    expect([...RULES.events].sort()).toEqual(['latePayer', 'outage', 'press']);
    expect(events.eventWeights(s)).toEqual({
      latePayer: E.weights.latePayer, outage: E.weights.outage, press: E.weights.press, competitor: 0, poach: 0, recession: 0,
    });
    expect(events.eligibleEvents(s)).toEqual(['latePayer', 'outage', 'press']);
    for (const t of ['competitor', 'poach', 'recession'] as const) {
      expect(events.openEvent(s, t), t).toBeNull();
      expect(s.card).toBeNull();
    }
    for (const t of ['latePayer', 'outage', 'press'] as const) {
      const card = events.openEvent(s, t);
      expect(card?.eventType, t).toBe(t);
      s.card = null;
    }

    // the full engine tells all six stories from the same state
    useFullEngine();
    const w = events.eventWeights(s);
    for (const t of EVENT_TYPES) expect(w[t], t).toBeGreaterThan(0);
  });

  it('the ad budget and the Finance and R&D rooms are refused, with the full engine as the control', () => {
    const s = game();
    // two marketers: the first sits in the garage (DESIGN.md 5/6), the second opens the Marketing room the ad budget would need
    act(s, hire('marketing'));
    expect(S.hasRoom(s, 'marketing')).toBe(false);
    act(s, hire('marketing'));
    expect(S.hasRoom(s, 'marketing')).toBe(true);
    const ads: Action = { type: 'setAdBudget', amount: CONFIG.marketing.adStep };
    expect(canDispatch(s, ads)).toEqual({ ok: false, reason: 'Not in this game.' });
    expect(dispatch(s, ads).ok).toBe(false);
    expect(s.adBudget).toBe(0);
    expect(S.monthlyAdSpend(s)).toBe(0);
    expect(s.actions).toHaveLength(2);

    s.financeUnlocked = true;
    const spot = { size: 'small', floor: 0, x: 0, y: 0 } as const;
    expect(canDispatch(s, { type: 'placeRoom', kind: 'finance', ...spot })).toEqual({ ok: false, reason: 'Not in this game.' });
    expect(canDispatch(s, { type: 'placeRoom', kind: 'rnd', ...spot })).toEqual({ ok: false, reason: 'Not in this game.' });
    expect(dispatch(s, { type: 'placeRoom', kind: 'finance', ...spot }).ok).toBe(false);
    expect(roomsOf(s, 'finance')).toHaveLength(0);
    // the spot itself is fine: the gate is the ruleset, not the lot
    expect(canDispatch(s, { type: 'placeRoom', kind: 'product', ...spot })).toEqual({ ok: true });

    useFullEngine();
    expect(canDispatch(s, ads)).toEqual({ ok: true });
    expect(canDispatch(s, { type: 'placeRoom', kind: 'finance', ...spot })).toEqual({ ok: true });
    expect(canDispatch(s, { type: 'placeRoom', kind: 'rnd', ...spot })).toEqual({ ok: true });
  });

  it('the founder-role switch and an early sale are refused, the hint line never suggests them or a Finance room, and investors never mention a loan; the full engine is the control', () => {
    const s = game();
    act(s, hire('product'));
    s.features = 1;
    const waiting = (): void => {
      s.prospects.push({ id: `pr${s.nextId++}`, arrivedDay: s.day, expiresDay: s.day + CONFIG.customers.prospectWaitDays, value: 30_000, repId: null, progress: 0 });
    };
    waiting();
    expect(S.salesCapacityPerMonth(s)).toBe(0);
    const toSales: Action = { type: 'founderRole', role: 'sales' };
    expect(canDispatch(s, toSales)).toEqual({ ok: false, reason: 'Not in this game.' });
    expect(dispatch(s, toSales).ok).toBe(false);
    expect(s.founderRole).toBe('product');
    expect(hintLine(s)).toBe('An enterprise prospect is waiting in the lobby. Hire a sales rep.');
    s.prospects.length = 0;

    // DESIGN.md 0: only the buzzer sells, even past the engine's day 720
    s.day = CONFIG.exit.sellFromDay;
    expect(canDispatch(s, { type: 'sell' })).toEqual({ ok: false, reason: 'Not in this game.' });
    expect(dispatch(s, { type: 'sell' }).ok).toBe(false);
    expect(s.status).toBe('playing');
    expect(hintLine(s)).not.toMatch(/sell any time/);

    // an open invoice unlocks Finance in the engine; the tournament has no Finance room to suggest
    ledger.bookEnterpriseDeal(s, 'cust', 30_000, CONFIG.finance.terms);
    expect(s.financeUnlocked).toBe(true);
    expect(hintLine(s)).not.toMatch(/Finance room/);

    act(s, { type: 'debug', op: 'knock' });
    expect(s.card?.kind).toBe('knock');
    expect(s.card?.body).not.toMatch(/loan|lend/i);
    expect(s.log[s.log.length - 1].text).not.toMatch(/loan/i);
    act(s, { type: 'card', choiceId: 'decline' });
    expect(s.actions.filter((a) => a.action.type !== 'card' && a.action.type !== 'debug').map((a) => a.action.type)).toEqual(['hireRole']);

    useFullEngine();
    expect(canDispatch(s, toSales)).toEqual({ ok: true });
    expect(canDispatch(s, { type: 'sell' })).toEqual({ ok: true });
    waiting();
    expect(hintLine(s)).toBe('An enterprise prospect is waiting in the lobby. Put yourself on sales or hire a rep.');
    act(s, { type: 'debug', op: 'knock' });
    expect(s.card?.body).toMatch(/lend it at/);
    expect(s.log[s.log.length - 1].text).toMatch(/or a loan at/);
  });
});

// ---------------------------------------------------------------- the last month of the round

describe('the last month of the round (DESIGN 0: no scheduled knock opens in the last 30 game days; lifelines still do)', () => {
  const ROUND_DAYS = ROUND_MONTHS * D;
  /** the first day on which fewer than lastKnockDays remain before the nominal end */
  const firstBlackoutDay = ROUND_DAYS - RULES.lastKnockDays + 1;

  it('without a projected end the nominal round counts: a knock due with 30 days left opens, one due a day later never does', () => {
    const s = game();
    expect(s.schedule.roundEndDay).toBeNull();
    s.schedule.nextKnockDay = firstBlackoutDay - 1;
    advanceTo(s, ROUND_DAYS);
    expect(s.day).toBe(firstBlackoutDay - 1);
    expect(s.card?.kind).toBe('knock');
    act(s, { type: 'card', choiceId: 'decline' });
    expect(s.schedule.knocks).toBe(1);

    s.schedule.nextKnockDay = firstBlackoutDay;
    advanceTo(s, ROUND_DAYS);
    expect(s.day).toBe(ROUND_DAYS);
    expect(s.card).toBeNull();
    expect(s.schedule.knocks).toBe(1);
    expect(s.status).toBe('playing');
  });

  it('with the end the shell projects (open cards cost game months) the last 30 days are the last 30 the player gets', () => {
    // two game months went to open cards: the buzzer rings on day 840, not 900
    const end = ROUND_DAYS - 2 * D;

    // due 5 days before the real end (65 before the nominal one): never opens
    const s = game();
    s.schedule.roundEndDay = end;
    s.schedule.nextKnockDay = end - 5;
    advanceTo(s, end);
    expect(s.day).toBe(end);
    expect(s.card).toBeNull();
    expect(s.schedule.knocks).toBe(0);

    // due with exactly 30 days left before the real end: opens
    const t = game();
    t.schedule.roundEndDay = end;
    t.schedule.nextKnockDay = end - RULES.lastKnockDays;
    advanceTo(t, end);
    expect(t.day).toBe(end - RULES.lastKnockDays);
    expect(t.card?.kind).toBe('knock');
  });

  it('a lifeline still opens inside the blackout', () => {
    const s = game();
    act(s, hire('product'));
    // the shell projects a short round: from day 11 on fewer than 30 days remain
    const end = RULES.lastKnockDays + 10;
    s.schedule.roundEndDay = end;
    s.schedule.nextKnockDay = 15;
    advanceTo(s, 20);
    expect(s.day).toBe(20);
    expect(s.card).toBeNull();
    expect(s.schedule.knocks).toBe(0);

    // DESIGN.md 10: the lifeline comes only after investors knocked once on their own schedule
    s.schedule.knocks = 1;
    s.schedule.nextKnockDay = FAR;
    s.cash = RULES.hire.product.salary; // one month of runway: under the two the lifeline needs
    advanceDay(s);
    expect(s.card?.kind).toBe('desperation');
    expect(s.day).toBe(21);
  });
});

// ---------------------------------------------------------------- a scripted round

/**
 * A tournament round played by a script through the public API: hires in all four departments,
 * a marketer let go, servers when short, the demo room, every knock taken, every event answered
 * with its first choice, the buzzer at the end. Only tournament actions (DESIGN.md 0).
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
  if (month >= 9 && count('marketing') > 0) out.push(fire('marketing'));
  if (s.customers.length >= 10 && count('support') < 1 && s.cash > 40_000) out.push(hire('support'));
  if (S.serversShort(s) > 0) out.push({ type: 'buyAsset', kind: 'server' });
  if (!S.hasDemoRoom(s) && s.cash > 90_000) out.push({ type: 'buyDemoRoom' });
  if (month >= 12 && count('product') < 2 && s.cash > 80_000) out.push(hire('product'));
  return out;
}

interface Round {
  s: GameState;
  /** event stories told during the round */
  stories: Set<EventType>;
  /** choice ids seen on investor cards */
  knockChoices: Set<string>;
}

function playRound(seed: number): Round {
  const s = createGame(seed);
  const stories = new Set<EventType>();
  const knockChoices = new Set<string>();
  let stalls = 0;
  while (s.status === 'playing' && s.day < ROUND_MONTHS * D) {
    const card = s.card;
    if (card?.kind === 'event' && card.eventType) stories.add(card.eventType);
    if (card && (card.kind === 'knock' || card.kind === 'desperation')) for (const c of card.choices) knockChoices.add(c.id);
    for (const a of plan(s)) if (canDispatch(s, a).ok) dispatch(s, a);
    const before = s.day;
    advanceDay(s);
    stalls = s.day === before ? stalls + 1 : 0;
    expect(stalls, `the clock stalled on day ${s.day}: ${s.card?.title ?? 'no card'}`).toBeLessThan(8);
  }
  // a card open at the buzzer is answered first: the clock, not the countdown, waits for it (DESIGN.md 0)
  for (let i = 0; s.status === 'playing' && s.card && i < 8; i++) {
    if (s.card.kind === 'event' && s.card.eventType) stories.add(s.card.eventType);
    for (const a of plan(s)) if (canDispatch(s, a).ok) dispatch(s, a);
  }
  if (s.status === 'playing') act(s, { type: 'timeUp' });
  return { s, stories, knockChoices };
}

describe('a scripted 30-month round (DESIGN 0, 9, 12)', () => {
  it.each([1, 2, 3])('seed %i: the books reconcile at every close, only tournament stories are told, and the action log replays to the identical state', (seed) => {
    const { s, stories, knockChoices } = playRound(seed);

    // the round ran to the buzzer and did the things the tournament lets a player do
    expect(s.status).toBe('sold');
    expect(s.day).toBe(ROUND_MONTHS * D);
    expect(s.history).toHaveLength(ROUND_MONTHS);
    expect(s.rounds.length).toBeGreaterThan(0);
    expect(s.loan).toBeNull();
    expect(s.history.some((b) => b.pnl.severance > 0)).toBe(true);
    expect(S.hasDemoRoom(s)).toBe(true);
    for (const role of RULES.roles) expect(s.actions.some((a) => a.action.type === 'hireRole' && a.action.role === role), role).toBe(true);
    expect(s.actions.every((a) => TOURNAMENT_ACTIONS.has(a.action.type))).toBe(true);
    expect(s.actions.filter((a) => a.action.type === 'card').length).toBeGreaterThan(0);

    // the two bars and cash reconcile every month (DESIGN.md 9), with equity in the financing line
    for (const b of s.history) expect(ledger.checkIdentities(b), `month ${b.month}`).toEqual([]);
    expect(s.history.reduce((sum, b) => sum + b.fin.equityIn, 0)).toBe(s.rounds.reduce((sum, r) => sum + r.amount, 0));
    expect(s.history.every((b) => b.fin.loanIn === 0 && b.fin.loanRepaid === 0 && b.pnl.interest === 0)).toBe(true);
    expect(s.history.every((b) => b.pnl.marketing === 0)).toBe(true);

    // only the three tournament events, and investors never offered a loan
    for (const t of stories) expect(RULES.events, t).toContain(t);
    expect([...knockChoices].sort()).toEqual(['decline', 'equity']);
    expect(s.people.every((p) => p.founder || (p.archetype === RULES.hire[p.role].archetype && p.baseSalary === RULES.hire[p.role].salary))).toBe(true);

    // the buzzer: score = value × founder share (DESIGN.md 0 and 12)
    const r = s.result;
    expect(r?.kind).toBe('sold');
    expect(r?.offer).toBe(s.valuation.value);
    expect(r?.score).toBe((r?.offer ?? 0) * s.founderShare);
    expect(r?.reason.startsWith("Time's up")).toBe(true);

    // DESIGN.md 12: deterministic from seed + action log
    const log = JSON.parse(JSON.stringify(s.actions)) as ActionRecord[];
    const replayed = replay(seed, log);
    advanceTo(replayed, s.day);
    const a = JSON.stringify(s);
    const b = JSON.stringify(replayed);
    expect(b === a, firstDifference(a, b)).toBe(true);
    expect(replayed.status).toBe('sold');
    expect(replayed.result).toEqual(s.result);
  }, 30_000);
});
