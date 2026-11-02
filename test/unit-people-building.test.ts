/**
 * DESIGN.md sections 5 (building), 6 (people) and 7 (assets): candidates, hiring, firing,
 * raises, morale, quits, learning, room placement and closing, the asset catalogue,
 * depreciation and laptops. The books must reconcile after every one of these actions
 * and a run must replay identically from seed + action log.
 */
import { describe, expect, it } from 'vitest';
import { advanceTo, createGame, dispatch } from '../src/sim/game';
import * as staff from '../src/sim/staff';
import * as rooms from '../src/sim/rooms';
import * as assets from '../src/sim/assets';
import * as L from '../src/sim/ledger';
import * as S from '../src/sim/selectors';
import { CONFIG } from '../src/sim/config';
import { QUIRK_WORD, fmtMoney } from '../src/sim/names';
import { ASSET_KINDS, ROLES } from '../src/sim/types';
import type { Action, ActionRecord, Archetype, Customer, GameState, Person, Quirk } from '../src/sim/types';

const P = CONFIG.people;
const M = P.morale;
const A = CONFIG.assets;
const D = CONFIG.time.daysPerMonth;
const FAR = 1_000_000;

// ---------------------------------------------------------------- helpers

/** A fresh game with the other modules' cards pushed away so the clock runs when a test advances it. */
function game(seed = 11): GameState {
  const s = createGame(seed);
  s.schedule.nextEventDay = FAR;
  s.schedule.nextKnockDay = FAR;
  return s;
}

/** Same as game.replay but with the same card schedule tweak as game(). */
function replayFar(seed: number, actions: ActionRecord[]): GameState {
  const s = game(seed);
  for (const rec of actions) {
    advanceTo(s, rec.day);
    dispatch(s, rec.action);
  }
  return s;
}

function founderOf(s: GameState): Person {
  return s.people.find((p) => p.founder) as Person;
}

function addPerson(s: GameState, over: Partial<Person> = {}): Person {
  const p: Person = {
    id: `p${s.nextId++}`, name: `Test ${s.nextId}`, role: 'product', archetype: 'mid', quirk: 'loyal', skill: 3,
    baseSalary: 7_000, morale: M.start, roomId: 'garage', hiredDay: s.day, lastRaiseDay: s.day, raisePending: false,
    raiseRequestedDay: null, raiseGrantedDay: null, raiseRefusedDay: null, founder: false, hasLaptop: true, ...over,
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

function hired(s: GameState): Person[] {
  return s.people.filter((p) => !p.founder);
}

function lastLog(s: GameState): string {
  return s.log[s.log.length - 1]?.text ?? '';
}

// ---------------------------------------------------------------- candidates

describe('candidates (DESIGN 6)', () => {
  it('generates candidatesPerRole per role, identical for the same seed', () => {
    const a = createGame(123);
    const b = createGame(123);
    const c = createGame(124);
    for (const role of ROLES) {
      expect(a.candidates[role]).toHaveLength(P.candidatesPerRole);
      expect(a.candidates[role]).toEqual(b.candidates[role]);
    }
    expect(JSON.stringify(a.candidates)).not.toBe(JSON.stringify(c.candidates));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('keeps skill in the archetype range (one decimal), salary within the noise band rounded to $100, pitch naming the quirk', () => {
    const seenArchetypes = new Set<Archetype>();
    const seenQuirks = new Set<Quirk>();
    for (let seed = 1; seed <= 30; seed++) {
      const s = createGame(seed);
      for (const role of ROLES) {
        for (const c of s.candidates[role]) {
          expect(c.role).toBe(role);
          expect(c.id).toMatch(/^c\d+$/);
          expect(c.name.split(' ')).toHaveLength(2);
          const [lo, hi] = P.skill[c.archetype];
          expect(c.skill).toBeGreaterThanOrEqual(lo);
          expect(c.skill).toBeLessThanOrEqual(hi);
          expect(Math.round(c.skill * 10) / 10).toBe(c.skill);
          // DESIGN.md 8: researchers are paid like seniors, whatever their archetype
          const base = c.role === 'rnd' ? P.salaries.senior : P.salaries[c.archetype];
          expect(c.salary % 100).toBe(0);
          expect(c.salary).toBeGreaterThanOrEqual(base * (1 - P.salaryNoise) - 50);
          expect(c.salary).toBeLessThanOrEqual(base * (1 + P.salaryNoise) + 50);
          expect(c.pitch.toLowerCase()).toContain(QUIRK_WORD[c.quirk]);
          seenArchetypes.add(c.archetype);
          seenQuirks.add(c.quirk);
        }
      }
    }
    expect(seenArchetypes.size).toBe(4);
    expect(seenQuirks.size).toBe(6);
  });

  it('researchers are paid like seniors whatever archetype they come as (DESIGN 8)', () => {
    const senior = P.salaries.senior;
    const seen = new Set<Archetype>();
    let firstNonSenior: { seed: number; id: string } | null = null;
    for (let seed = 1; seed <= 40; seed++) {
      const s = createGame(seed);
      for (const c of s.candidates.rnd) {
        const where = `${c.archetype} researcher, seed ${seed}`;
        expect(c.salary % 100, where).toBe(0);
        expect(c.salary, where).toBeGreaterThanOrEqual(senior * (1 - P.salaryNoise) - 50);
        expect(c.salary, where).toBeLessThanOrEqual(senior * (1 + P.salaryNoise) + 50);
        // the archetype still sets the skill, so a junior researcher is a junior at a senior price
        const [lo, hi] = P.skill[c.archetype];
        expect(c.skill, where).toBeGreaterThanOrEqual(lo);
        expect(c.skill, where).toBeLessThanOrEqual(hi);
        if (c.archetype === 'senior') expect(c.pitch).not.toContain('senior rate');
        else expect(c.pitch).toContain('Researchers are paid at the senior rate.');
        seen.add(c.archetype);
        if (!firstNonSenior && c.archetype !== 'senior') firstNonSenior = { seed, id: c.id };
      }
      // every other role still pays by archetype, so a junior engineer stays cheap
      for (const role of ROLES) {
        if (role === 'rnd') continue;
        for (const c of s.candidates[role]) {
          expect(c.salary, `${c.archetype} ${role}, seed ${seed}`).toBeLessThanOrEqual(P.salaries[c.archetype] * (1 + P.salaryNoise) + 50);
        }
      }
    }
    // the rule only bites when non-senior researchers are drawn at all
    expect(seen.has('junior') || seen.has('mid') || seen.has('star')).toBe(true);
    expect(firstNonSenior).not.toBeNull();

    // the senior-band salary follows the hire into payroll and the R&D cost share
    const s = game((firstNonSenior as { seed: number; id: string }).seed);
    const c = s.candidates.rnd.find((x) => x.id === (firstNonSenior as { seed: number; id: string }).id)!;
    assets.buy(s, 'desk', 'garage');
    expect(staff.canHire(s, c.id).ok).toBe(true);
    staff.hire(s, c.id);
    const p = hired(s)[0];
    expect(p.role).toBe('rnd');
    expect(p.archetype).toBe(c.archetype);
    expect(p.baseSalary).toBe(c.salary);
    expect(p.baseSalary).toBeGreaterThanOrEqual(senior * (1 - P.salaryNoise) - 50);
    expect(S.monthlySalaries(s)).toBe(c.salary);
    expect(S.rndCostShare(s)).toBeCloseTo(1, 10);
  });

  it('the month-end refresh replaces every role with fresh candidates', () => {
    const s = game();
    const before = new Set(ROLES.flatMap((r) => s.candidates[r].map((c) => c.id)));
    staff.monthlyStaff(s);
    for (const role of ROLES) {
      expect(s.candidates[role]).toHaveLength(P.candidatesPerRole);
      for (const c of s.candidates[role]) expect(before.has(c.id)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------- hiring and firing

describe('hiring', () => {
  it('needs a free desk and a month of cash; seats the hire, removes the candidate, moves no money', () => {
    const s = game();
    const c = s.candidates.sales[0];
    // the garage has one desk and the founder sits at it
    expect(staff.canHire(s, c.id).ok).toBe(false);
    expect(staff.canHire(s, c.id).reason).toContain('desk');
    assets.buy(s, 'desk', 'garage');
    expect(staff.canHire(s, c.id)).toEqual({ ok: true });

    const cash = s.cash;
    s.cash = c.salary - 1;
    expect(staff.canHire(s, c.id).reason).toContain('cash');
    s.cash = cash;

    staff.hire(s, c.id);
    expect(s.cash).toBe(cash);
    const p = hired(s)[0];
    expect(p).toMatchObject({ name: c.name, role: 'sales', archetype: c.archetype, quirk: c.quirk, skill: c.skill, baseSalary: c.salary });
    expect(p.morale).toBe(M.start);
    expect(p.roomId).toBe('garage');
    expect(p.hiredDay).toBe(s.day);
    expect(p.lastRaiseDay).toBe(s.day);
    expect(p.hasLaptop).toBe(false); // one laptop, and the founder comes first
    expect(founderOf(s).hasLaptop).toBe(true);
    expect(s.candidates.sales.some((x) => x.id === c.id)).toBe(false);
    expect(s.candidates.sales).toHaveLength(P.candidatesPerRole - 1);
    expect(s.visuals.some((v) => v.t === 'hire' && v.personId === p.id)).toBe(true);
    expect(lastLog(s)).toContain(c.name);
    expect(staff.canHire(s, c.id).ok).toBe(false); // the slot stays empty until the refresh
    expect(S.freeSeatsIn(s, 'garage')).toBe(0);
    expect(S.monthlySalaries(s)).toBe(c.salary);
  });

  it('seats people in their department room before the garage', () => {
    const s = game();
    assets.buy(s, 'desk', 'garage');
    const room = rooms.placeRoom(s, 'support', 'small', 0, 0, 0);
    assets.buy(s, 'desk', room.id);
    staff.hire(s, s.candidates.support[0].id);
    expect(hired(s)[0].roomId).toBe(room.id);
    // the sales candidate cannot sit in Support, so the garage it is
    staff.hire(s, s.candidates.sales[0].id);
    expect(hired(s)[1].roomId).toBe('garage');
    expect(staff.canHire(s, s.candidates.product[0].id).ok).toBe(false);
  });
});

describe('firing', () => {
  it('pays severance = base salary × severanceMonths through the ledger and frees desk and laptop', () => {
    const s = game();
    assets.buy(s, 'desk', 'garage');
    assets.buy(s, 'laptop');
    const c = s.candidates.product[0];
    staff.hire(s, c.id);
    const p = hired(s)[0];
    expect(p.hasLaptop).toBe(true);
    expect(staff.canFire(s, p.id)).toEqual({ ok: true });
    const cash = s.cash;
    staff.fire(s, p.id, 'fired');
    const severance = c.salary * P.severanceMonths;
    expect(severance).toBe(S.severanceOf(s, p));
    expect(cash - s.cash).toBe(severance);
    expect(s.book.pnl.severance).toBe(severance);
    expect(s.book.cf.severance).toBe(severance);
    expect(S.personById(s, p.id)).toBeUndefined();
    expect(S.freeSeatsIn(s, 'garage')).toBe(1);
    expect(S.spareLaptops(s)).toBe(1);
    expect(s.visuals.some((v) => v.t === 'leave' && v.personId === p.id && v.reason === 'fired')).toBe(true);
    expect(lastLog(s)).toContain(fmtMoney(severance));
  });

  it('quit and poached cost nothing; room closure pays like a firing', () => {
    for (const reason of ['quit', 'poached'] as const) {
      const s = game();
      const p = addPerson(s, { baseSalary: 10_000 });
      const cash = s.cash;
      staff.fire(s, p.id, reason);
      expect(s.cash).toBe(cash);
      expect(s.book.pnl.severance).toBe(0);
      expect(S.personById(s, p.id)).toBeUndefined();
      expect(s.visuals.some((v) => v.t === 'leave' && v.reason === reason)).toBe(true);
    }
    const s = game();
    const p = addPerson(s, { baseSalary: 10_000 });
    staff.fire(s, p.id, 'roomClosed');
    expect(s.book.cf.severance).toBe(30_000);
  });

  it('the founder cannot be fired, and a departing rep releases their prospects', () => {
    const s = game();
    const f = founderOf(s);
    expect(staff.canFire(s, f.id).ok).toBe(false);
    staff.fire(s, f.id, 'fired');
    expect(s.people).toContain(f);
    expect(staff.canFire(s, 'nobody').ok).toBe(false);

    const rep = addPerson(s, { role: 'sales' });
    s.prospects.push({ id: 'x1', arrivedDay: 0, expiresDay: 45, value: 30_000, repId: rep.id, progress: 0.4 });
    staff.fire(s, rep.id, 'fired');
    expect(s.prospects[0].repId).toBeNull();
  });
});

// ---------------------------------------------------------------- laptops

describe('laptops', () => {
  it('go to the founder first, then by hire day; the rest work without one', () => {
    const s = game();
    const later = addPerson(s, { hiredDay: 10, hasLaptop: false, baseSalary: 6_000 });
    const earlier = addPerson(s, { hiredDay: 5, hasLaptop: false, baseSalary: 9_000 });
    assets.assignLaptops(s);
    expect(founderOf(s).hasLaptop).toBe(true);
    expect(earlier.hasLaptop).toBe(false);
    expect(later.hasLaptop).toBe(false);
    expect(S.outputOf(s, later)).toBeCloseTo(later.skill * (0.5 + later.morale / 200) * P.noLaptopOutput);

    expect(assets.catalogue(s).find((c) => c.kind === 'laptop')?.monthlyBenefit).toBe((1 - P.noLaptopOutput) * 9_000);
    assets.buy(s, 'laptop');
    expect(earlier.hasLaptop).toBe(true);
    expect(later.hasLaptop).toBe(false);
    assets.buy(s, 'laptop');
    expect(later.hasLaptop).toBe(true);
    expect(S.spareLaptops(s)).toBe(0);
    expect(assets.catalogue(s).find((c) => c.kind === 'laptop')?.monthlyBenefit).toBe(0);

    const spare = assets.buy(s, 'laptop');
    expect(S.spareLaptops(s)).toBe(1);
    assets.sell(s, spare.id);
    expect(later.hasLaptop).toBe(true);
    const inUse = S.assetsOfKind(s, 'laptop')[0];
    assets.sell(s, inUse.id);
    expect(later.hasLaptop).toBe(false); // the latest hire loses theirs
    expect(earlier.hasLaptop).toBe(true);
    expect(founderOf(s).hasLaptop).toBe(true);
  });
});

// ---------------------------------------------------------------- rooms

describe('rooms (DESIGN 5)', () => {
  it('footprints and rents come from CONFIG', () => {
    expect(rooms.roomFootprint('sales', 'small')).toEqual({ w: 2, h: 2 });
    expect(rooms.roomFootprint('sales', 'large')).toEqual({ w: 3, h: 2 });
    expect(rooms.roomFootprint('demo', 'large')).toEqual({ w: CONFIG.rooms.demo.w, h: CONFIG.rooms.demo.h });
    expect(rooms.roomRent('rnd', 'small')).toBe(CONFIG.rooms.size.small.rent);
    expect(rooms.roomRent('rnd', 'large')).toBe(CONFIG.rooms.size.large.rent);
    expect(rooms.roomRent('demo', 'small')).toBe(0);
  });

  it('validates the floor, the bounds, overlaps and the reserved lobby cells', () => {
    const s = game();
    expect(rooms.canPlaceRoom(s, 'sales', 'small', 1, 0, 0).reason).toContain('second floor');
    expect(rooms.canPlaceRoom(s, 'sales', 'small', 0, 5, 0).reason).toContain('bounds');
    expect(rooms.canPlaceRoom(s, 'sales', 'large', 0, 4, 0).reason).toContain('bounds');
    expect(rooms.canPlaceRoom(s, 'sales', 'small', 0, -1, 0).ok).toBe(false);
    expect(rooms.canPlaceRoom(s, 'sales', 'small', 0, 0, 7).ok).toBe(false);
    expect(rooms.canPlaceRoom(s, 'sales', 'small', 0, 0.5, 0).ok).toBe(false);
    expect(rooms.canPlaceRoom(s, 'sales', 'small', 0, 0, 6).reason).toContain('garage');
    expect(rooms.canPlaceRoom(s, 'sales', 'small', 0, 0, 5).reason).toContain('garage');
    // the lobby cells are reserved before the lobby exists
    expect(rooms.canPlaceRoom(s, 'sales', 'small', 0, 2, 6).reason).toContain('lobby');
    expect(rooms.canPlaceRoom(s, 'sales', 'small', 0, 3, 5).reason).toContain('lobby');
    expect(rooms.canPlaceRoom(s, 'sales', 'small', 0, 4, 6)).toEqual({ ok: true });
    expect(rooms.canPlaceRoom(s, 'sales', 'small', 0, 0, 0)).toEqual({ ok: true });
    expect(rooms.canPlaceRoom(s, 'sales', 'large', 0, 3, 4)).toEqual({ ok: true });
    expect(rooms.validSpots(s, 'sales', 'small', 0)).toHaveLength(27);
    expect(rooms.validSpots(s, 'sales', 'large', 0)).toHaveLength(20);
    expect(rooms.validSpots(s, 'sales', 'small', 1)).toHaveLength(0);

    rooms.placeRoom(s, 'sales', 'small', 0, 0, 0);
    expect(rooms.canPlaceRoom(s, 'product', 'small', 0, 1, 1).reason).toContain('Sales room');
    expect(rooms.canPlaceRoom(s, 'product', 'small', 0, 2, 0)).toEqual({ ok: true });
    expect(rooms.canPlaceRoom(s, 'product', 'small', 0, 2, 6).reason).toContain('lobby');
    expect(rooms.validSpots(s, 'product', 'small', 0)).toHaveLength(27 - 4);

    L.recordEquity(s, A.catalogue.secondFloor.price);
    assets.buy(s, 'secondFloor');
    expect(s.floors).toBe(2);
    expect(rooms.validSpots(s, 'product', 'small', 1)).toHaveLength(35);
    expect(rooms.canPlaceRoom(s, 'product', 'small', 1, 0, 6)).toEqual({ ok: true }); // no garage upstairs
  });

  it('the first department room opens the rent-free lobby, and rent accrues from the first day', () => {
    const s = game();
    expect(S.hasRoom(s, 'lobby')).toBe(false);
    const r = rooms.placeRoom(s, 'product', 'large', 0, 0, 0);
    expect(r.id).toMatch(/^r\d+$/);
    expect(r).toMatchObject({ kind: 'product', size: 'large', floor: 0, x: 0, y: 0, w: 3, h: 2, rent: 4_500, openedDay: 0 });
    const lobby = S.roomsOf(s, 'lobby');
    expect(lobby).toHaveLength(1);
    expect(lobby[0]).toMatchObject({ ...CONFIG.grid.lobby, rent: 0, floor: 0 });
    expect(S.monthlyRent(s)).toBe(4_500);
    expect(s.cash).toBe(CONFIG.start.cash);

    rooms.placeRoom(s, 'sales', 'small', 0, 3, 0);
    expect(S.roomsOf(s, 'lobby')).toHaveLength(1);
    expect(S.monthlyRent(s)).toBe(7_500);
    expect(s.visuals.filter((v) => v.t === 'room' && v.op === 'open')).toHaveLength(3);

    advanceTo(s, D);
    expect(s.day).toBe(D);
    const closed = s.history[0];
    expect(closed.pnl.rent).toBeCloseTo(7_500, 6);
    expect(closed.cf.rent).toBeCloseTo(7_500, 6);
    expect(L.checkIdentities(closed)).toEqual([]);
  });

  it('demo room: needs the cash, only one, capex through the ledger, asset linked to the room, no lobby', () => {
    const s = game();
    const price = A.catalogue.demoRoom.price;
    s.cash = price - 1;
    expect(rooms.canPlaceRoom(s, 'demo', 'small', 0, 0, 0).reason).toContain('cash');
    s.cash = price;
    expect(rooms.canPlaceRoom(s, 'demo', 'large', 0, 0, 0)).toEqual({ ok: true });
    const r = rooms.placeRoom(s, 'demo', 'large', 0, 0, 0);
    expect(r).toMatchObject({ kind: 'demo', w: 2, h: 2, rent: 0 });
    expect(s.cash).toBe(0);
    expect(s.book.cf.capex).toBe(price);
    const demo = S.assetsOfKind(s, 'demoRoom');
    expect(demo).toHaveLength(1);
    expect(demo[0]).toMatchObject({ roomId: r.id, cost: price, bookValue: price, lifeMonths: A.catalogue.demoRoom.lifeMonths });
    expect(S.hasRoom(s, 'lobby')).toBe(false);
    expect(S.enterpriseDealValue(s)).toBeCloseTo(CONFIG.customers.enterpriseDeal * A.demoRoomMult);
    s.cash = price;
    expect(rooms.canPlaceRoom(s, 'demo', 'small', 0, 3, 0).reason).toContain('already');
    expect(assets.canSell(s, demo[0].id).reason).toBe('Close the demo room with Build');

    rooms.closeRoom(s, r.id);
    expect(S.roomById(s, r.id)).toBeUndefined();
    expect(S.hasDemoRoom(s)).toBe(false);
    expect(s.book.cf.disposalProceeds).toBeCloseTo(price * A.resaleOfBook);
    expect(s.book.pnl.disposalLoss).toBeCloseTo(price * (1 - A.resaleOfBook));
    expect(rooms.canPlaceRoom(s, 'demo', 'small', 0, 0, 0)).toEqual({ ok: true });
  });

  it('closing a room fires its staff with severance, sells its desks at 60% of book and removes it', () => {
    const s = game();
    const r = rooms.placeRoom(s, 'support', 'small', 0, 0, 0);
    const d1 = assets.buy(s, 'desk', r.id);
    const d2 = assets.buy(s, 'desk', r.id);
    const [c1, c2] = s.candidates.support;
    staff.hire(s, c1.id);
    staff.hire(s, c2.id);
    expect(S.occupantsOf(s, r.id)).toHaveLength(2);
    expect(rooms.canCloseRoom(s, 'garage').ok).toBe(false);
    expect(rooms.canCloseRoom(s, 'lobby').ok).toBe(false);
    expect(rooms.canCloseRoom(s, 'nope').ok).toBe(false);
    expect(rooms.canCloseRoom(s, r.id)).toEqual({ ok: true });

    const cash = s.cash;
    const book = d1.bookValue + d2.bookValue;
    rooms.closeRoom(s, r.id);
    const severance = (c1.salary + c2.salary) * P.severanceMonths;
    const proceeds = book * A.resaleOfBook;
    expect(s.book.pnl.severance).toBe(severance);
    expect(s.book.cf.severance).toBe(severance);
    expect(s.book.cf.disposalProceeds).toBeCloseTo(proceeds);
    expect(s.book.pnl.disposalLoss).toBeCloseTo(book - proceeds);
    expect(s.cash).toBeCloseTo(cash - severance + proceeds);
    expect(S.roomById(s, r.id)).toBeUndefined();
    expect(S.desksIn(s, r.id)).toHaveLength(0);
    expect(s.assets.some((a) => a.id === d1.id || a.id === d2.id)).toBe(false);
    expect(hired(s)).toHaveLength(0);
    expect(s.visuals.filter((v) => v.t === 'leave' && v.reason === 'roomClosed')).toHaveLength(2);
    expect(s.visuals.some((v) => v.t === 'room' && v.op === 'close' && v.roomId === r.id)).toBe(true);
    expect(S.hasRoom(s, 'lobby')).toBe(true);
    expect(S.monthlyRent(s)).toBe(0);
  });

  it('closing the last Marketing room resets the ad budget', () => {
    const s = game();
    const r = rooms.placeRoom(s, 'marketing', 'small', 0, 0, 0);
    expect(dispatch(s, { type: 'setAdBudget', amount: 5_000 })).toEqual({ ok: true });
    expect(s.adBudget).toBe(5_000);
    rooms.closeRoom(s, r.id);
    expect(s.adBudget).toBe(0);
    expect(S.monthlyAdSpend(s)).toBe(0);
  });

  it('closing the room the founder sits in moves them to a free desk, or leaves them standing until one appears', () => {
    const s = game();
    const f = founderOf(s);
    const r = rooms.placeRoom(s, 'product', 'small', 0, 0, 0);
    assets.buy(s, 'desk', r.id);
    f.roomId = r.id;
    rooms.closeRoom(s, r.id);
    expect(f.roomId).toBe('garage');
    expect(s.people).toHaveLength(1);
    expect(s.book.pnl.severance).toBe(0);

    const r2 = rooms.placeRoom(s, 'product', 'small', 0, 0, 0);
    assets.buy(s, 'desk', r2.id);
    f.roomId = r2.id;
    addPerson(s, { roomId: 'garage' }); // takes the only garage desk
    rooms.closeRoom(s, r2.id);
    expect(f.roomId).toBeNull();
    expect(staff.moraleTarget(s, f)).toBe(M.base + M.noDeskOrLaptop);
    assets.buy(s, 'desk', 'garage');
    staff.dailyStaff(s);
    expect(f.roomId).toBe('garage');
  });
});

// ---------------------------------------------------------------- assets

describe('assets (DESIGN 7)', () => {
  it('catalogue: one card per kind with CONFIG numbers, depreciation, payback and verdicts', () => {
    const s = game();
    const cards = assets.catalogue(s);
    expect(cards.map((c) => c.kind)).toEqual([...ASSET_KINDS]);
    for (const card of cards) {
      const cfg = A.catalogue[card.kind];
      expect(card.label).toBe(cfg.label);
      expect(card.price).toBe(cfg.price);
      expect(card.lifeMonths).toBe(cfg.lifeMonths);
      expect(card.monthlyDepreciation).toBeCloseTo(cfg.price / cfg.lifeMonths, 2);
      expect(card.effect.length).toBeGreaterThan(0);
      if (card.monthlyBenefit > 0) expect(card.paybackMonths).toBeCloseTo(card.price / card.monthlyBenefit);
      else expect(card.paybackMonths).toBeNull();
    }
    const by = (kind: typeof ASSET_KINDS[number]) => cards.find((c) => c.kind === kind) as (typeof cards)[number];
    expect(by('demoRoom').verdict).toEqual({ ok: false, reason: 'Place it with Build' });
    expect(by('desk').verdict).toEqual({ ok: true }); // the garage takes one more
    expect(by('laptop').monthlyBenefit).toBe(0); // everyone has one
    expect(by('desk').monthlyBenefit).toBe(0);
    expect(by('secondFloor').monthlyBenefit).toBe(0);
    expect(by('coffee').monthlyBenefit).toBe(0); // the founder is unpaid
    expect(by('server').monthlyBenefit).toBe(0); // no customers, no shortage

    addPerson(s, { baseSalary: 8_000, hasLaptop: false });
    const cards2 = assets.catalogue(s);
    const laptop = cards2.find((c) => c.kind === 'laptop') as (typeof cards)[number];
    expect(laptop.monthlyBenefit).toBe((1 - P.noLaptopOutput) * 8_000);
    expect(laptop.paybackMonths).toBeCloseTo(A.catalogue.laptop.price / (0.5 * 8_000));
    const coffee = cards2.find((c) => c.kind === 'coffee') as (typeof cards)[number];
    expect(coffee.monthlyBenefit).toBeCloseTo((A.coffeeMorale / 200) * 8_000);
    expect(coffee.paybackMonths).toBeCloseTo(A.catalogue.coffee.price / 400);
  });

  it('the server card estimates the outage cost only while servers are short', () => {
    const s = game();
    addSmbCustomers(s, A.customersPerServer + 1);
    expect(S.serversShort(s)).toBe(2);
    const revenue = s.customers.reduce((sum, c) => sum + c.monthlyPrice, 0);
    const card = assets.catalogue(s).find((c) => c.kind === 'server');
    expect(card?.monthlyBenefit).toBeCloseTo(A.outageChancePerMissingServer * A.outageChurn * revenue, 2);
    expect(card?.paybackMonths).toBeGreaterThan(0);
    assets.buy(s, 'server');
    assets.buy(s, 'server');
    expect(S.serversShort(s)).toBe(0);
    expect(assets.catalogue(s).find((c) => c.kind === 'server')?.monthlyBenefit).toBe(0);
  });

  it('the demo room card estimates the uplift from the sales capacity', () => {
    const s = game();
    const card = () => assets.catalogue(s).find((c) => c.kind === 'demoRoom') as ReturnType<typeof assets.catalogue>[number];
    expect(card().monthlyBenefit).toBe(0); // no sales capacity yet
    staff.setFounderRole(s, 'sales');
    s.features = 3;
    const expected = (A.demoRoomMult - 1) * S.salesCapacityPerMonth(s) * S.enterpriseCloseProb(s) * S.enterpriseDealValue(s) / CONFIG.customers.enterpriseContractMonths;
    expect(card().monthlyBenefit).toBeCloseTo(expected, 2);
    expect(card().paybackMonths).toBeCloseTo(A.catalogue.demoRoom.price / expected, 2);
  });

  it('canBuy: cash, desk room capacity, one coffee, one second floor; buy records capex and applies effects', () => {
    const s = game();
    expect(assets.canBuy(s, 'desk').reason).toContain('room');
    expect(assets.canBuy(s, 'desk', 'nope').reason).toContain('No such room');
    expect(assets.canBuy(s, 'desk', 'garage')).toEqual({ ok: true });
    const cash0 = s.cash;
    const desk = assets.buy(s, 'desk', 'garage');
    expect(desk).toMatchObject({ kind: 'desk', roomId: 'garage', cost: 1_000, bookValue: 1_000, lifeMonths: 60, boughtDay: 0 });
    expect(cash0 - s.cash).toBe(1_000);
    expect(s.book.cf.capex).toBe(1_000);
    expect(s.book.pnl.depreciation).toBe(0);
    expect(assets.canBuy(s, 'desk', 'garage').reason).toContain('full');
    expect(assets.catalogue(s).find((c) => c.kind === 'desk')?.verdict.ok).toBe(false);
    expect(s.visuals.some((v) => v.t === 'asset' && v.kind === 'desk' && v.op === 'buy')).toBe(true);

    rooms.placeRoom(s, 'rnd', 'small', 0, 0, 0);
    expect(assets.canBuy(s, 'desk', 'lobby').reason).toContain('no desks');
    expect(assets.roomsWithDeskSpace(s).map((r) => r.kind)).toEqual(['rnd']);

    assets.buy(s, 'coffee');
    expect(S.hasCoffee(s)).toBe(true);
    expect(assets.canBuy(s, 'coffee').reason).toContain('coffee');

    expect(assets.canBuy(s, 'secondFloor').reason).toContain('cash');
    L.recordEquity(s, A.catalogue.secondFloor.price);
    expect(assets.canBuy(s, 'secondFloor')).toEqual({ ok: true });
    assets.buy(s, 'secondFloor');
    expect(s.floors).toBe(2);
    expect(assets.canBuy(s, 'secondFloor').reason).toContain('already');
    expect(assets.canBuy(s, 'demoRoom').reason).toBe('Place it with Build');
    expect(() => assets.buy(s, 'demoRoom')).toThrow();
    expect(s.book.cf.capex).toBe(1_000 + A.catalogue.coffee.price + A.catalogue.secondFloor.price);
  });

  it('canSell / sell: occupied desks, a floor with rooms on it and the demo room stay; proceeds are 60% of book', () => {
    const s = game();
    const [garageDesk] = S.desksIn(s, 'garage');
    expect(assets.canSell(s, garageDesk.id).reason).toContain('sitting');
    const spareDesk = assets.buy(s, 'desk', 'garage');
    expect(assets.canSell(s, spareDesk.id)).toEqual({ ok: true });
    expect(assets.canSell(s, 'nope').ok).toBe(false);

    L.recordEquity(s, A.catalogue.secondFloor.price);
    const floor = assets.buy(s, 'secondFloor');
    const up = rooms.placeRoom(s, 'sales', 'small', 0 as 0 | 1, 0, 0);
    up.floor = 1; // moved upstairs for the test
    expect(assets.canSell(s, floor.id).reason).toContain('upstairs');
    rooms.closeRoom(s, up.id);
    expect(assets.canSell(s, floor.id)).toEqual({ ok: true });

    const cash = s.cash;
    const book = spareDesk.bookValue;
    const proceeds = assets.sell(s, spareDesk.id);
    expect(proceeds).toBeCloseTo(book * A.resaleOfBook);
    expect(s.cash - cash).toBeCloseTo(proceeds);
    expect(s.book.cf.disposalProceeds).toBeCloseTo(proceeds);
    expect(s.book.pnl.disposalLoss).toBeCloseTo(book - proceeds);
    expect(s.assets.some((a) => a.id === spareDesk.id)).toBe(false);
    expect(s.visuals.some((v) => v.t === 'asset' && v.kind === 'desk' && v.op === 'sell')).toBe(true);

    assets.sell(s, floor.id);
    expect(s.floors).toBe(1);
    expect(rooms.canPlaceRoom(s, 'sales', 'small', 1, 0, 0).ok).toBe(false);
  });

  it('depreciation: straight line to zero, booked through the ledger, never below zero', () => {
    const s = game(); // starts with one desk (1000 / 60) and one laptop (2000 / 36)
    const desk = S.assetsOfKind(s, 'desk')[0];
    const laptop = S.assetsOfKind(s, 'laptop')[0];
    const deskMonthly = desk.cost / desk.lifeMonths;
    const laptopMonthly = laptop.cost / laptop.lifeMonths;
    assets.bookMonthlyDepreciation(s);
    expect(desk.bookValue).toBeCloseTo(desk.cost - deskMonthly, 1);
    expect(laptop.bookValue).toBeCloseTo(laptop.cost - laptopMonthly, 1);
    expect(s.book.pnl.depreciation).toBeCloseTo(deskMonthly + laptopMonthly, 1);
    expect(s.cash).toBe(CONFIG.start.cash);

    for (let i = 1; i < laptop.lifeMonths; i++) assets.bookMonthlyDepreciation(s);
    expect(laptop.bookValue).toBe(0);
    expect(desk.bookValue).toBeCloseTo(desk.cost - laptop.lifeMonths * deskMonthly, 0);
    for (let i = laptop.lifeMonths; i < desk.lifeMonths; i++) assets.bookMonthlyDepreciation(s);
    expect(desk.bookValue).toBe(0);
    expect(L.assetsAtBook(s)).toBe(0);
    expect(s.book.pnl.depreciation).toBeCloseTo(desk.cost + laptop.cost, 1);
    assets.bookMonthlyDepreciation(s);
    expect(s.book.pnl.depreciation).toBeCloseTo(desk.cost + laptop.cost, 1);
    expect(s.assets).toHaveLength(2); // retired assets stay at book 0
    expect(L.recordDisposal(s, desk)).toBe(0);
  });
});

// ---------------------------------------------------------------- morale

describe('morale (DESIGN 6)', () => {
  it('the founder alone in the garage sits at the base target and stays there', () => {
    const s = game();
    const f = founderOf(s);
    expect(staff.moraleTarget(s, f)).toBe(M.base);
    advanceTo(s, 3 * D);
    expect(f.morale).toBe(M.start);
  });

  it('adds every term of the target formula and clamps to 0..100', () => {
    const s = game();
    const p = addPerson(s, { hasLaptop: false, roomId: 'garage' });
    // founder + p: the garage is at its 2-desk capacity
    expect(S.isRoomCrowded(s, S.roomById(s, 'garage') as never)).toBe(true);
    expect(staff.moraleTarget(s, p)).toBe(M.base + M.noDeskOrLaptop + M.crowded);
    p.hasLaptop = true;
    expect(staff.moraleTarget(s, p)).toBe(M.base + M.crowded);
    p.quirk = 'crowd';
    expect(staff.moraleTarget(s, p)).toBe(M.base + M.crowded + M.crowdQuirkAtCapacity);

    const r = rooms.placeRoom(s, 'product', 'small', 0, 0, 0);
    assets.buy(s, 'desk', r.id);
    p.roomId = r.id;
    expect(staff.moraleTarget(s, p)).toBe(M.base);
    p.quirk = 'coffee';
    expect(staff.moraleTarget(s, p)).toBe(M.base + M.coffeeQuirkNoMachine);
    assets.buy(s, 'coffee');
    expect(staff.moraleTarget(s, p)).toBe(M.base + A.coffeeMorale);
    expect(staff.moraleTarget(s, founderOf(s))).toBe(M.base + A.coffeeMorale);

    p.quirk = 'loyal';
    p.raiseGrantedDay = s.day;
    expect(staff.moraleTarget(s, p)).toBe(M.base + A.coffeeMorale + M.raiseGranted);
    s.day = M.raiseGrantedMonths * D - 1;
    expect(staff.moraleTarget(s, p)).toBe(M.base + A.coffeeMorale + M.raiseGranted);
    s.day = M.raiseGrantedMonths * D;
    expect(staff.moraleTarget(s, p)).toBe(M.base + A.coffeeMorale);
    p.raiseRefusedDay = s.day;
    expect(staff.moraleTarget(s, p)).toBe(M.base + A.coffeeMorale + M.raiseRefused);
    s.day += M.raiseRefusedMonths * D;
    expect(staff.moraleTarget(s, p)).toBe(M.base + A.coffeeMorale);

    // overload: support demand above capacity
    p.role = 'support';
    addSmbCustomers(s, 300);
    expect(S.roleOverloaded(s, 'support')).toBe(true);
    expect(staff.moraleTarget(s, p)).toBe(M.base + A.coffeeMorale + M.overload);
    // the founder plays founderRole, so no support overload for them
    expect(staff.moraleTarget(s, founderOf(s))).toBe(M.base + A.coffeeMorale);

    // pile on the penalties: clamped at 0
    p.hasLaptop = false;
    p.raiseRefusedDay = s.day;
    p.roomId = null;
    expect(staff.moraleTarget(s, p)).toBe(M.base + A.coffeeMorale + M.overload + M.noDeskOrLaptop + M.raiseRefused);
    p.quirk = 'coffee';
    assets.sell(s, S.assetsOfKind(s, 'coffee')[0].id);
    expect(M.base + M.overload + M.noDeskOrLaptop + M.raiseRefused + M.coffeeQuirkNoMachine).toBeLessThan(0);
    expect(staff.moraleTarget(s, p)).toBe(0);
  });

  it('morale moves a tenth of the gap toward the target each day', () => {
    const s = game();
    const p = addPerson(s, { morale: 20, roomId: 'garage' });
    const r = rooms.placeRoom(s, 'product', 'small', 0, 0, 0);
    assets.buy(s, 'desk', r.id);
    p.roomId = r.id;
    expect(staff.moraleTarget(s, p)).toBe(M.base);
    staff.dailyStaff(s);
    expect(p.morale).toBeCloseTo(20 + (M.base - 20) * M.driftPerDay);
    const after = p.morale;
    staff.dailyStaff(s);
    expect(p.morale).toBeCloseTo(after + (M.base - after) * M.driftPerDay);
    p.morale = 100;
    p.hasLaptop = false;
    staff.dailyStaff(s);
    expect(p.morale).toBeCloseTo(100 + (M.base + M.noDeskOrLaptop - 100) * M.driftPerDay);
  });
});

// ---------------------------------------------------------------- raises, quits, learning

describe('raises', () => {
  it('asks every 12 months (6 for divas and stars), never the founder; grant and refuse do what they say', () => {
    const s = game();
    s.day = 12 * D;
    const f = founderOf(s);
    f.lastRaiseDay = 0;
    const p = addPerson(s, { lastRaiseDay: 0, baseSalary: 7_000 });
    const diva = addPerson(s, { lastRaiseDay: 6 * D, quirk: 'diva' });
    const star = addPerson(s, { lastRaiseDay: 6 * D, archetype: 'star', baseSalary: 14_000, skill: 5 });
    const fresh = addPerson(s, { lastRaiseDay: 6 * D });
    staff.monthlyStaff(s);
    expect(p.raisePending).toBe(true);
    expect(p.raiseRequestedDay).toBe(s.day);
    expect(diva.raisePending).toBe(true);
    expect(star.raisePending).toBe(true);
    expect(fresh.raisePending).toBe(false);
    expect(f.raisePending).toBe(false);
    expect(s.visuals.filter((v) => v.t === 'toast' && v.text.includes('raise'))).toHaveLength(3);
    expect(staff.canRaise(s, fresh.id).ok).toBe(false);
    expect(staff.canRaise(s, 'nobody').ok).toBe(false);
    expect(staff.canRaise(s, p.id)).toEqual({ ok: true });

    const salaries = S.monthlySalaries(s);
    const targetBefore = staff.moraleTarget(s, p); // five people share the garage, so it is crowded
    expect(targetBefore).toBe(M.base + M.crowded);
    staff.resolveRaise(s, p.id, true);
    expect(p.baseSalary).toBe(8_100); // 7000 × 1.15 = 8050 → nearest $100
    expect(staff.raisedSalary(4_600)).toBe(5_300);
    expect(p.raisePending).toBe(false);
    expect(p.raiseRequestedDay).toBeNull();
    expect(p.raiseGrantedDay).toBe(s.day);
    expect(p.lastRaiseDay).toBe(s.day);
    expect(staff.moraleTarget(s, p)).toBe(targetBefore + M.raiseGranted);
    expect(S.monthlySalaries(s)).toBe(salaries + 1_100);
    expect(s.cash).toBe(CONFIG.start.cash); // nothing moves until the salary accrues

    staff.resolveRaise(s, diva.id, false);
    expect(diva.baseSalary).toBe(7_000);
    expect(diva.raisePending).toBe(false);
    expect(diva.raiseRefusedDay).toBe(s.day);
    expect(diva.lastRaiseDay).toBe(s.day);
    expect(staff.moraleTarget(s, diva)).toBe(targetBefore + M.raiseRefused);
    expect(staff.canRaise(s, diva.id).ok).toBe(false);

    // the next month-end does not ask again right after a decision
    s.day += D;
    staff.monthlyStaff(s);
    expect(p.raisePending).toBe(false);
    expect(diva.raisePending).toBe(false);
    expect(star.raisePending).toBe(true);

    // a request left unanswered for raisePendingDays counts as refused
    s.day = star.raiseRequestedDay as number + P.raisePendingDays - 1;
    staff.dailyStaff(s);
    expect(star.raisePending).toBe(true);
    s.day += 1;
    staff.dailyStaff(s);
    expect(star.raisePending).toBe(false);
    expect(star.raiseRefusedDay).toBe(s.day);
    expect(star.lastRaiseDay).toBe(s.day);
    expect(star.baseSalary).toBe(14_000);
    expect(s.log.some((l) => l.text.includes('silence'))).toBe(true);

    // the diva asks again six months after the refusal, the regular person after twelve
    s.day = diva.lastRaiseDay + 6 * D;
    staff.monthlyStaff(s);
    expect(diva.raisePending).toBe(true);
    expect(p.raisePending).toBe(false);
    s.day = p.lastRaiseDay + 12 * D;
    staff.monthlyStaff(s);
    expect(p.raisePending).toBe(true);
  });

  it('low morale brings the ask forward, but not twice within six months', () => {
    const s = game();
    s.day = 12 * D;
    const p = addPerson(s, { lastRaiseDay: 6 * D, morale: M.askRaiseBelow - 1 });
    const q = addPerson(s, { lastRaiseDay: 6 * D + 1, morale: M.askRaiseBelow - 1 });
    staff.monthlyStaff(s);
    expect(p.raisePending).toBe(true);
    expect(q.raisePending).toBe(false);
    staff.resolveRaise(s, p.id, false);
    s.day += 3 * D;
    staff.monthlyStaff(s);
    expect(p.raisePending).toBe(false);
    s.day = p.lastRaiseDay + 6 * D;
    staff.monthlyStaff(s);
    expect(p.raisePending).toBe(true);
  });

  it('the raise action flows through dispatch', () => {
    const s = game();
    const p = addPerson(s, { lastRaiseDay: 0 });
    expect(dispatch(s, { type: 'raise', personId: p.id, grant: true }).ok).toBe(false);
    s.day = 12 * D;
    staff.monthlyStaff(s);
    expect(dispatch(s, { type: 'raise', personId: p.id, grant: false })).toEqual({ ok: true });
    expect(p.raiseRefusedDay).toBe(s.day);
  });
});

describe('quits and learning', () => {
  it('unhappy people quit with a monthly chance (mercenaries sooner); loyal people and the founder never', () => {
    const s = game();
    const merc = addPerson(s, { quirk: 'mercenary', morale: M.mercenaryQuitBelow - 1 });
    const low = addPerson(s, { quirk: 'crowd', morale: M.quitBelow - 1 });
    const loyal = addPerson(s, { quirk: 'loyal', morale: 0 });
    const okay = addPerson(s, { quirk: 'crowd', morale: M.quitBelow });
    founderOf(s).morale = 0;
    let months = 0;
    while ((S.personById(s, merc.id) || S.personById(s, low.id)) && months < 400) {
      s.day += D;
      staff.monthlyStaff(s);
      months += 1;
    }
    expect(months).toBeLessThan(400);
    expect(S.personById(s, merc.id)).toBeUndefined();
    expect(S.personById(s, low.id)).toBeUndefined();
    expect(S.personById(s, loyal.id)).toBe(loyal);
    expect(S.personById(s, okay.id)).toBe(okay);
    expect(founderOf(s)).toBeDefined();
    expect(s.cash).toBe(CONFIG.start.cash);
    expect(s.book.pnl.severance).toBe(0);
    expect(s.visuals.filter((v) => v.t === 'leave' && v.reason === 'quit')).toHaveLength(2);
    expect(s.visuals.filter((v) => v.t === 'toast' && v.text.endsWith('quit.'))).toHaveLength(2);
  });

  it('juniors learn 0.1 a month, twice that with a mentor in the room, capped at 3', () => {
    const s = game();
    const j = addPerson(s, { archetype: 'junior', skill: 1.5, roomId: 'garage' });
    staff.monthlyStaff(s);
    expect(j.skill).toBe(1.6);
    const mentor = addPerson(s, { quirk: 'mentor', roomId: 'garage' });
    staff.monthlyStaff(s);
    expect(j.skill).toBe(1.8);
    mentor.roomId = 'elsewhere';
    staff.monthlyStaff(s);
    expect(j.skill).toBe(1.9);
    j.skill = P.juniorLearnCap - 0.05;
    staff.monthlyStaff(s);
    expect(j.skill).toBe(P.juniorLearnCap);
    staff.monthlyStaff(s);
    expect(j.skill).toBe(P.juniorLearnCap);
    expect(founderOf(s).skill).toBe(CONFIG.start.founderSkill);
  });
});

// ---------------------------------------------------------------- founder role

describe('founder role', () => {
  it('switches role; moves out of a department room that does not take it, or refuses when no desk is free', () => {
    const s = game();
    const f = founderOf(s);
    expect(staff.canSetFounderRole(s, 'product').ok).toBe(false);
    expect(staff.canSetFounderRole(s, 'sales')).toEqual({ ok: true });
    staff.setFounderRole(s, 'sales');
    expect(s.founderRole).toBe('sales');
    expect(S.roleOf(s, f)).toBe('sales');
    expect(f.roomId).toBe('garage'); // the garage takes anyone
    expect(S.salesCapacityPerMonth(s)).toBeGreaterThan(0);

    const sales = rooms.placeRoom(s, 'sales', 'small', 0, 0, 0);
    assets.buy(s, 'desk', sales.id);
    f.roomId = sales.id;
    addPerson(s, { roomId: 'garage' }); // takes the garage desk
    expect(staff.canSetFounderRole(s, 'product').ok).toBe(false);
    expect(staff.canSetFounderRole(s, 'product').reason).toContain('desk');
    staff.setFounderRole(s, 'product');
    expect(s.founderRole).toBe('sales');
    expect(f.roomId).toBe(sales.id);

    const product = rooms.placeRoom(s, 'product', 'small', 0, 2, 0);
    assets.buy(s, 'desk', product.id);
    expect(staff.canSetFounderRole(s, 'product')).toEqual({ ok: true });
    expect(dispatch(s, { type: 'founderRole', role: 'product' })).toEqual({ ok: true });
    expect(s.founderRole).toBe('product');
    expect(f.roomId).toBe(product.id);
    expect(S.occupantsOf(s, sales.id)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------- books and determinism

describe('books and determinism', () => {
  it('a run of hires, rooms, assets and closures keeps every closed month reconciled and replays identically', () => {
    const seed = 2026;
    const s = game(seed);
    const act = (a: Action) => expect(dispatch(s, a)).toEqual({ ok: true });

    act({ type: 'debug', op: 'cash' }); // financing, so severance never pushes cash below zero
    act({ type: 'placeRoom', kind: 'product', size: 'small', floor: 0, x: 0, y: 0 });
    const room = S.roomsOf(s, 'product')[0];
    act({ type: 'buyAsset', kind: 'desk', roomId: room.id });
    act({ type: 'buyAsset', kind: 'laptop' });
    const cheapest = [...s.candidates.product].sort((a, b) => a.salary - b.salary)[0];
    act({ type: 'hire', candidateId: cheapest.id });
    const engineer = hired(s)[0];
    expect(engineer.roomId).toBe(room.id);
    expect(engineer.hasLaptop).toBe(true);

    advanceTo(s, D);
    act({ type: 'buyAsset', kind: 'coffee' });
    act({ type: 'founderRole', role: 'sales' });
    advanceTo(s, 2 * D);
    act({ type: 'sellAsset', assetId: S.assetsOfKind(s, 'coffee')[0].id });
    act({ type: 'fire', personId: engineer.id });
    advanceTo(s, 3 * D);
    act({ type: 'placeRoom', kind: 'marketing', size: 'small', floor: 0, x: 2, y: 0 });
    act({ type: 'setAdBudget', amount: 5_000 });
    advanceTo(s, 4 * D);
    act({ type: 'closeRoom', roomId: S.roomsOf(s, 'marketing')[0].id });
    expect(s.adBudget).toBe(0);
    act({ type: 'closeRoom', roomId: room.id });
    advanceTo(s, 6 * D);

    expect(s.status).toBe('playing');
    expect(s.day).toBe(6 * D);
    expect(s.history).toHaveLength(6);
    for (const b of s.history) expect(L.checkIdentities(b)).toEqual([]);
    // day 30 closes month 0 before the day-30 actions land, so those sit in month 1, and so on
    const [month0, month1, month2, , month4] = s.history;
    expect(month0.cf.capex).toBe(A.catalogue.desk.price + A.catalogue.laptop.price);
    expect(month0.pnl.rent).toBeCloseTo(CONFIG.rooms.size.small.rent, 6);
    expect(month0.pnl.salaries).toBeCloseTo(cheapest.salary, 6);
    expect(month0.pnl.depreciation).toBeGreaterThan(0);
    expect(month1.cf.capex).toBe(A.catalogue.coffee.price);
    expect(month2.pnl.severance).toBe(cheapest.salary * P.severanceMonths);
    expect(month2.cf.severance).toBe(cheapest.salary * P.severanceMonths);
    expect(month2.pnl.disposalLoss).toBeGreaterThan(0);
    expect(month2.cf.disposalProceeds).toBeGreaterThan(0);
    expect(month2.pnl.salaries).toBeCloseTo(0, 6);
    expect(month4.cf.disposalProceeds).toBeCloseTo(A.catalogue.desk.price * A.resaleOfBook * (1 - 4 / A.catalogue.desk.lifeMonths), 0);
    expect(S.monthlyRent(s)).toBe(0);

    const r = replayFar(seed, s.actions);
    advanceTo(r, s.day); // a replay ends at the last action; run it to the same day
    expect(JSON.stringify(r)).toBe(JSON.stringify(s));
  });

  it('the founder alone costs nothing for a year: no salary, no rent, no severance, only depreciation', () => {
    const s = game(42);
    advanceTo(s, 12 * D);
    expect(s.day).toBe(12 * D);
    expect(s.cash).toBeGreaterThanOrEqual(CONFIG.start.cash); // other modules may add revenue, never costs
    expect(s.people).toHaveLength(1);
    expect(founderOf(s).morale).toBe(M.start);
    for (const b of s.history) {
      expect(b.pnl.salaries).toBe(0);
      expect(b.pnl.rent).toBe(0);
      expect(b.pnl.severance).toBe(0);
      expect(b.cf.capex).toBe(0);
      expect(L.checkIdentities(b)).toEqual([]);
    }
    expect(s.history.reduce((sum, b) => sum + b.pnl.depreciation, 0)).toBeCloseTo(12 * (1_000 / 60 + 2_000 / 36), 0);
    expect(L.assetsAtBook(s)).toBeCloseTo(3_000 - 12 * (1_000 / 60 + 2_000 / 36), 0);
  });
});
