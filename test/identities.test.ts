/**
 * DESIGN.md 16: ledger identities after every close over random action sequences,
 * plus the structural invariants the three bars rest on. Driven through the public
 * sim API only (src/sim/index.ts) by the random-but-valid policy in scripts/strategies,
 * once under the full engine and once under the tournament rules (DESIGN.md 0), where
 * the policy hires and fires by department, buys servers and the demo room, and the
 * rich uncle's money fills the lot so rooms close themselves and the second floor gets
 * built (DESIGN.md 0 "Space (v2)").
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { CONFIG, RULES, ledger, selectors as S } from '../src/sim';
import type { Action, GameState, InvoiceStatus, Role } from '../src/sim';
import { randomStrategy, runStrategy } from '../scripts/strategies';
import type { Strategy } from '../scripts/strategies';
import { useTournamentRules } from './setup';

const SEEDS = Array.from({ length: 20 }, (_, i) => 1000 + i * 37);
const MONTHS = 60;
const D = CONFIG.time.daysPerMonth;
/** same tolerance as ledger.checkIdentities */
const EPS = 0.01;
const INVOICE_STATUSES: readonly InvoiceStatus[] = ['open', 'paid', 'writtenOff'];
const STATUSES = ['playing', 'gameOver', 'sold'];
/** deeper than this is a cycle or a runaway structure, not game state */
const MAX_DEPTH = 40;
/** what the tournament random policy may dispatch: the tournament screen's actions (DESIGN.md 0) and the rich uncle */
const TOURNAMENT_POLICY_ACTIONS: readonly Action['type'][] = ['hireRole', 'fireRole', 'buyAsset', 'buyDemoRoom', 'card', 'debug'];

/** Path of the first NaN / ±Infinity anywhere in a plain-data tree, or null. JSON.stringify would silently turn it into null. */
function findNonFinite(value: unknown, path = 'state', depth = 0): string | null {
  if (typeof value === 'number') return Number.isFinite(value) ? null : `${path} = ${value}`;
  if (value === null || typeof value !== 'object') return null;
  if (depth > MAX_DEPTH) return `${path}: nested deeper than ${MAX_DEPTH} levels`;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = findNonFinite(value[i], `${path}[${i}]`, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const hit = findNonFinite(v, `${path}.${k}`, depth + 1);
    if (hit) return hit;
  }
  return null;
}

function overlaps(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

const isDepartment = (kind: string): boolean => kind !== 'garage' && kind !== 'lobby' && kind !== 'demo';

/** Cheap invariants, checked after every day. Returns the list of violations (empty when sane). */
function structuralProblems(state: GameState): string[] {
  const out: string[] = [];
  const at = `day ${state.day}`;

  if (!STATUSES.includes(state.status)) out.push(`${at}: status ${state.status}`);
  if (!Number.isFinite(state.cash)) out.push(`${at}: cash ${state.cash}`);
  if (!(state.founderShare > 0 && state.founderShare <= 1)) out.push(`${at}: founderShare ${state.founderShare} not in (0, 1]`);
  if (state.loan && !(state.loan.principal >= 0)) out.push(`${at}: loan principal ${state.loan.principal} < 0`);

  for (const inv of state.invoices) {
    if (!INVOICE_STATUSES.includes(inv.status)) out.push(`${at}: invoice ${inv.id} status ${String(inv.status)}`);
  }

  const roomIds = new Set(state.rooms.map((r) => r.id));
  for (const a of state.assets) {
    if (a.bookValue < -EPS || a.bookValue > a.cost + EPS) out.push(`${at}: asset ${a.id} (${a.kind}) bookValue ${a.bookValue} outside [0, ${a.cost}]`);
    // DESIGN.md 6: desks are per-room assets
    if (a.kind === 'desk' && (a.roomId === null || !roomIds.has(a.roomId))) out.push(`${at}: desk ${a.id} stands in missing room ${a.roomId}`);
  }

  for (const p of state.people) {
    // the founder may stand without a desk after their room closed with the garage full (rooms.closeRoom);
    // staff.dailyStaff seats them again when a desk frees up. Everyone else is hired into a desk (DESIGN.md 6).
    if (p.roomId === null) {
      if (!p.founder) out.push(`${at}: ${p.name} (${p.id}) has no desk`);
    } else if (!roomIds.has(p.roomId)) {
      out.push(`${at}: ${p.name} (${p.id}) sits in missing room ${p.roomId}`);
    }
  }

  const g = CONFIG.grid;
  for (const room of state.rooms) {
    const desks = S.desksIn(state, room.id).length;
    const max = S.roomMaxDesks(room);
    if (desks > max) out.push(`${at}: room ${room.id} (${room.kind}) has ${desks} desks, max ${max}`);
    // DESIGN.md 6: hiring needs a free desk, so nobody sits without one
    const occupants = S.occupantsOf(state, room.id).length;
    if (occupants > desks) out.push(`${at}: room ${room.id} (${room.kind}) seats ${occupants} people on ${desks} desks`);
    // DESIGN.md 0 "Space (v2)": under the tournament rules a department room closes itself the moment its last person leaves
    if (RULES.autoCloseRooms && isDepartment(room.kind) && occupants === 0) out.push(`${at}: room ${room.id} (${room.kind}) stands empty under autoCloseRooms`);
    // DESIGN.md 5: in bounds, one floor at a time
    if (room.x < 0 || room.y < 0 || room.x + room.w > g.w || room.y + room.h > g.h) out.push(`${at}: room ${room.id} out of bounds`);
    if (room.floor === 1 && state.floors < 2) out.push(`${at}: room ${room.id} on a floor that does not exist`);
  }
  for (let i = 0; i < state.rooms.length; i++) {
    for (let j = i + 1; j < state.rooms.length; j++) {
      const a = state.rooms[i];
      const b = state.rooms[j];
      if (a.floor === b.floor && overlaps(a, b)) out.push(`${at}: rooms ${a.id} and ${b.id} overlap`);
    }
  }
  return out;
}

/** Play MONTHS months of `policy` on `seed`, checking the identities at every close and the invariants every day; returns the final state. */
function checkedRun(seed: number, policy: Strategy): GameState {
  let closes = 0;
  const { state } = runStrategy(seed, policy, MONTHS, {
    onClose(s, book) {
      closes += 1;
      const where = `month ${book.month}, day ${s.day}`;
      expect(ledger.checkIdentities(book), where).toEqual([]);
      expect(s.day % D, `${where}: a close lands on a month boundary`).toBe(0);
      expect(book.month, `${where}: months close in sequence`).toBe(s.history.length - 1);
      // right after a close the bank balance is exactly what the closed book says
      expect(s.cash, `${where}: cash vs closed book`).toBe(book.cashEnd);
      // and the new month-to-date book carries every balance forward
      expect(s.book.cashStart, `${where}: new book cashStart`).toBe(book.cashEnd);
      expect(s.book.arStart, `${where}: new book arStart`).toBe(book.arEnd);
      expect(s.book.assetsBookStart, `${where}: new book assetsBookStart`).toBe(book.assetsBookEnd);
      expect(s.book.debtStart, `${where}: new book debtStart`).toBe(book.debtEnd);
      expect(s.book.closed, `${where}: the new book is open`).toBe(false);
      expect(findNonFinite(s), `${where}: non-finite number`).toBeNull();
    },
    onDay(s) {
      expect(structuralProblems(s)).toEqual([]);
    },
  });

  expect(STATUSES).toContain(state.status);
  expect(closes, 'one onClose per closed month').toBe(state.history.length);
  if (state.status === 'playing') expect(state.history.length).toBe(MONTHS);
  for (const book of state.history) expect(ledger.checkIdentities(book), `month ${book.month} at the end`).toEqual([]);
  expect(findNonFinite(state)).toBeNull();
  expect(() => JSON.stringify(state), 'the state serialises').not.toThrow();
  expect(structuralProblems(state)).toEqual([]);
  return state;
}

describe('ledger identities under a random-but-valid policy', () => {
  it.each(SEEDS)('seed %i: every close reconciles and the state stays sane for 60 months', (seed) => {
    checkedRun(seed, randomStrategy(seed * 7919 + 1));
  }, 120_000);
});

describe('ledger identities under the tournament rules (DESIGN.md 0): hires and firings by department, servers, the demo room, rooms that close themselves, the second floor', () => {
  beforeEach(() => {
    useTournamentRules();
  });

  it.each(SEEDS)('seed %i: every close reconciles and the state stays sane for 60 months', (seed) => {
    const state = checkedRun(seed, randomStrategy(seed * 7919 + 1, { engine: 'tournament' }));
    // nothing but the tournament's own actions and the uncle's money; servers are the only asset bought
    expect(state.actions.every((a) => TOURNAMENT_POLICY_ACTIONS.includes(a.action.type))).toBe(true);
    expect(state.actions.every((a) => a.action.type !== 'buyAsset' || a.action.kind === 'server')).toBe(true);
    expect(state.loan).toBeNull();
  }, 120_000);

  it('the policy exercises every tournament action over the seed set: hires into every department, firings, servers, the demo room, card answers; the lot fills past the ground floor and rooms close themselves', () => {
    const seen = new Set<Action['type']>();
    const roles = new Set<Role>();
    let upstairs = 0;
    let closes = 0;
    let maxPeople = 0;
    for (const seed of SEEDS.slice(0, 8)) {
      const { state } = runStrategy(seed, randomStrategy(seed * 7919 + 1, { engine: 'tournament' }), 36, {
        onDay(s) {
          maxPeople = Math.max(maxPeople, s.people.length);
          for (const v of s.visuals) if (v.t === 'room' && v.op === 'close') closes += 1;
          s.visuals.length = 0;
        },
      });
      for (const a of state.actions) {
        seen.add(a.action.type);
        if (a.action.type === 'hireRole') roles.add(a.action.role);
      }
      if (state.floors === 2) upstairs += 1;
    }
    expect([...roles].sort()).toEqual([...RULES.roles].sort());
    for (const type of ['hireRole', 'fireRole', 'buyAsset', 'buyDemoRoom', 'card'] as const) expect(seen.has(type), type).toBe(true);
    // DESIGN.md 0 "Space (v2)": the ground floor holds the garage plus the large rooms that fit above the bottom row;
    // more people than that at once means the hire that found it full built the second floor
    const g = CONFIG.grid;
    const room = CONFIG.rooms.size[RULES.roomSize];
    const groundRooms = Math.floor(g.w / room.w) * Math.floor((g.h - g.garage.h) / room.h);
    const groundSeats = groundRooms * room.maxDesks + CONFIG.rooms.garage.maxDesks;
    expect(maxPeople, 'people at once').toBeGreaterThan(groundSeats);
    expect(upstairs, 'seeds that built the second floor').toBeGreaterThan(0);
    expect(closes, 'rooms that closed themselves').toBeGreaterThan(0);
  }, 120_000);
});
