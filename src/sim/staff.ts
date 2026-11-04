/**
 * People: candidates, hiring, firing, morale, raises, quitting, learning.
 * DESIGN.md section 6.
 */
import { CONFIG, RULES } from './config';
import { chance, pick, pickWeighted, randRange } from './rng';
import * as L from './ledger';
import * as S from './selectors';
import { assignLaptops, disposeDesksIn } from './assets';
import { ARCHETYPE_WORD, FIRST_NAMES, JOB_WORD, LAST_NAMES, QUIRK_PITCH, fmtMoney, roomName } from './names';
import { no, OK, ROLES, ROLE_LABEL } from './types';
import type { Archetype, Candidate, GameState, Person, Quirk, Role, Verdict } from './types';

const D = CONFIG.time.daysPerMonth;
const ARCHETYPES: readonly Archetype[] = ['junior', 'mid', 'senior', 'star'];
const QUIRKS: readonly Quirk[] = ['coffee', 'crowd', 'mentor', 'mercenary', 'loyal', 'diva'];

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}

/** Money to the nearest $100, rounding to cents first so 7000 × 1.15 = 8049.99… lands on 8100. */
function round100(x: number): number {
  const r = CONFIG.people.salaryRound;
  return Math.round(Math.round(x * 100) / (100 * r)) * r;
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

/** "an engineer", "a marketer". */
function withArticle(word: string): string {
  return `${/^[aeiou]/i.test(word) ? 'an' : 'a'} ${word}`;
}

export function founderOf(state: GameState): Person | undefined {
  return state.people.find((p) => p.founder);
}

/** Salary after a granted raise (DESIGN.md 6: +15%, rounded to $100). */
export function raisedSalary(baseSalary: number): number {
  return round100(baseSalary * (1 + CONFIG.people.raisePct));
}

// ---------------------------------------------------------------- candidates

function pitchFor(role: Role, archetype: Archetype, skill: number, quirk: Quirk): string {
  const P = CONFIG.people;
  const parts = [`${ARCHETYPE_WORD[archetype]} ${JOB_WORD[role]}, skill ${skill.toFixed(1)}.`, QUIRK_PITCH[quirk]];
  if (archetype === 'star') {
    if (role === 'sales') parts.push(`Takes ${Math.round(P.starCommission * 100)}% commission on enterprise deals.`);
    if (quirk !== 'diva') parts.push(`Expects a raise every ${P.divaRaiseEveryMonths} months.`);
  }
  // DESIGN.md 8: researchers are paid like seniors; say so on every card that is not a senior's
  if (role === 'rnd' && archetype !== 'senior') parts.push('Researchers are paid at the senior rate.');
  return parts.join(' ');
}

/** Fresh candidates for a role (archetype weights, skill ranges, salary noise, quirk, pitch). */
export function generateCandidates(state: GameState, role: Role): Candidate[] {
  const P = CONFIG.people;
  const weights = ARCHETYPES.map((a) => P.archetypeWeights[a]);
  const out: Candidate[] = [];
  for (let i = 0; i < P.candidatesPerRole; i++) {
    const archetype = pickWeighted(state.rng, ARCHETYPES, weights);
    const [lo, hi] = P.skill[archetype];
    const skill = round1(randRange(state.rng, lo, hi));
    // DESIGN.md 8: researchers are paid like seniors, whatever archetype they come as
    const band = role === 'rnd' ? P.salaries.senior : P.salaries[archetype];
    const salary = round100(band * randRange(state.rng, 1 - P.salaryNoise, 1 + P.salaryNoise));
    const quirk = pick(state.rng, QUIRKS);
    const name = `${pick(state.rng, FIRST_NAMES)} ${pick(state.rng, LAST_NAMES)}`;
    out.push({ id: `c${state.nextId++}`, name, role, archetype, quirk, skill, salary, pitch: pitchFor(role, archetype, skill, quirk) });
  }
  return out;
}

/** Regenerate candidates for every role (called at creation and every month end). */
export function refreshCandidates(state: GameState): void {
  for (const role of ROLES) state.candidates[role] = generateCandidates(state, role);
}

export function findCandidate(state: GameState, candidateId: string): { role: Role; index: number; candidate: Candidate } | null {
  for (const role of ROLES) {
    const index = state.candidates[role].findIndex((c) => c.id === candidateId);
    if (index >= 0) return { role, index, candidate: state.candidates[role][index] };
  }
  return null;
}

// ---------------------------------------------------------------- hiring and firing

/** Needs: candidate exists, a free desk for the role (department room or garage), cash ≥ one month's salary. */
export function canHire(state: GameState, candidateId: string): Verdict {
  const found = findCandidate(state, candidateId);
  if (!found) return no('That candidate is no longer available.');
  const c = found.candidate;
  if (!S.seatFor(state, c.role)) return no(`No free desk for ${withArticle(JOB_WORD[c.role])}: add a desk or open a ${ROLE_LABEL[c.role]} room.`);
  if (state.cash < c.salary) return no(`Not enough cash for the first month's salary (${fmtMoney(c.salary)}).`);
  return OK;
}

/** Creates the Person, seats them, hands out a laptop if spare, removes the candidate, logs, visual 'hire'. */
export function hire(state: GameState, candidateId: string): void {
  const found = findCandidate(state, candidateId);
  if (!found) return;
  const c = found.candidate;
  state.candidates[found.role].splice(found.index, 1);
  const seat = S.seatFor(state, c.role);
  const p: Person = {
    id: `p${state.nextId++}`,
    name: c.name,
    role: c.role,
    archetype: c.archetype,
    quirk: c.quirk,
    skill: c.skill,
    baseSalary: c.salary,
    morale: CONFIG.people.morale.start,
    roomId: seat ? seat.id : null,
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
  assignLaptops(state);
  state.visuals.push({ t: 'hire', day: state.day, personId: p.id });
  const where = seat ? ` Sits in the ${roomName(seat.kind)}.` : '';
  const laptop = p.hasLaptop ? '' : ' No laptop yet.';
  state.log.push({
    day: state.day,
    text: `Hired ${p.name}, ${ARCHETYPE_WORD[p.archetype].toLowerCase()} ${JOB_WORD[p.role]} at ${fmtMoney(p.baseSalary)}/mo.${where}${laptop}`,
    tone: 'good',
  });
}

export function canFire(state: GameState, personId: string): Verdict {
  const p = S.personById(state, personId);
  if (!p) return no('No such person.');
  if (p.founder) return no("You can't fire yourself.");
  return OK;
}

/**
 * Removes the person. 'fired' and 'roomClosed' pay severance (3 months' base salary);
 * 'quit' and 'poached' do not. Frees the desk and the laptop. Logs and pushes visual 'leave'.
 * Under RULES.autoCloseRooms the room they sat in closes when nobody is left in it.
 */
export function fire(state: GameState, personId: string, reason: 'fired' | 'quit' | 'poached' | 'roomClosed'): void {
  const idx = state.people.findIndex((p) => p.id === personId);
  if (idx < 0) return;
  const p = state.people[idx];
  if (p.founder) return;
  // DESIGN.md 6: firing = 3 months' salary now; quitting and poaching cost nothing
  let severance = 0;
  if (reason === 'fired' || reason === 'roomClosed') {
    severance = S.severanceOf(state, p);
    L.paySeverance(state, severance);
  }
  const roomId = p.roomId;
  state.people.splice(idx, 1);
  p.roomId = null;
  p.hasLaptop = false;
  p.raisePending = false;
  // a departed rep leaves their prospects waiting for the next one
  for (const pr of state.prospects) if (pr.repId === p.id) pr.repId = null;
  assignLaptops(state);
  state.visuals.push({ t: 'leave', day: state.day, personId: p.id, name: p.name, reason });
  const texts = {
    fired: `Let ${p.name} go. Severance ${fmtMoney(severance)}.`,
    roomClosed: `${p.name} lost their desk when the room closed. Severance ${fmtMoney(severance)}.`,
    quit: `${p.name} quit.`,
    poached: `${p.name} was poached by a competitor.`,
  } as const;
  state.log.push({ day: state.day, text: texts[reason], tone: reason === 'quit' || reason === 'poached' ? 'bad' : 'info' });
  // DESIGN.md 0 "Space (v2)": every way of leaving shares this one hook. Not for 'roomClosed':
  // that room is being closed by rooms.closeRoom, which sells the desks and tells the story itself.
  if (RULES.autoCloseRooms && reason !== 'roomClosed' && roomId !== null) closeEmptiedRoom(state, roomId);
}

/**
 * DESIGN.md 0 "Space (v2)": a department room closes itself the moment its last person leaves:
 * its desks are sold at 60% of book (ledger.recordDisposal), the room goes and the rent stops.
 * Never the garage, the lobby or the demo room, and never while anyone (the founder included)
 * still sits there.
 */
function closeEmptiedRoom(state: GameState, roomId: string): void {
  const room = S.roomById(state, roomId);
  if (!room || room.kind === 'garage' || room.kind === 'lobby' || room.kind === 'demo') return;
  if (S.occupantsOf(state, room.id).length > 0) return;
  const proceeds = disposeDesksIn(state, room.id);
  state.rooms.splice(state.rooms.indexOf(room), 1);
  // the last Marketing room takes the ad budget with it, as rooms.closeRoom does
  if (room.kind === 'marketing' && !S.hasRoom(state, 'marketing')) state.adBudget = 0;
  state.visuals.push({ t: 'room', day: state.day, roomId: room.id, op: 'close' });
  state.log.push({
    day: state.day,
    text: `The ${roomName(room.kind)} is empty and closes: rent ${fmtMoney(room.rent)}/mo stops, desks sold for ${fmtMoney(proceeds)}.`,
    tone: 'info',
  });
}

// ---------------------------------------------------------------- raises

export function canRaise(state: GameState, personId: string): Verdict {
  const p = S.personById(state, personId);
  if (!p) return no('No such person.');
  if (!p.raisePending) return no(`${p.name} hasn't asked for a raise.`);
  return OK;
}

function askForRaise(state: GameState, p: Person): void {
  p.raisePending = true;
  p.raiseRequestedDay = state.day;
  state.log.push({
    day: state.day,
    text: `${p.name} is asking for a raise: ${fmtMoney(p.baseSalary)} → ${fmtMoney(raisedSalary(p.baseSalary))}/mo.`,
    tone: 'info',
  });
  state.visuals.push({ t: 'toast', day: state.day, text: `${p.name} wants a raise.`, tone: 'info' });
}

function decideRaise(state: GameState, p: Person, grant: boolean, auto: boolean): void {
  p.raisePending = false;
  p.raiseRequestedDay = null;
  p.lastRaiseDay = state.day;
  if (grant) {
    p.baseSalary = raisedSalary(p.baseSalary);
    p.raiseGrantedDay = state.day;
    state.log.push({ day: state.day, text: `Gave ${p.name} a raise: now ${fmtMoney(p.baseSalary)}/mo.`, tone: 'good' });
  } else {
    // DESIGN.md 6: refusing applies the morale penalty (for raiseRefusedMonths, via moraleTarget)
    p.raiseRefusedDay = state.day;
    const text = auto ? `${p.name} took your silence as a no.` : `Refused ${p.name}'s raise. Expect a mood dip.`;
    state.log.push({ day: state.day, text, tone: 'bad' });
    if (auto) state.visuals.push({ t: 'toast', day: state.day, text: `${p.name}'s raise request expired.`, tone: 'bad' });
  }
}

/** Grant: +15% base salary, morale boost. Refuse: morale penalty. Clears the pending flag. */
export function resolveRaise(state: GameState, personId: string, grant: boolean): void {
  const p = S.personById(state, personId);
  if (!p || !p.raisePending) return;
  decideRaise(state, p, grant, false);
}

// ---------------------------------------------------------------- founder role

function founderNeedsNewSeat(state: GameState, founder: Person, role: Role): boolean {
  const room = founder.roomId === null ? undefined : S.roomById(state, founder.roomId);
  return room !== undefined && !S.roomAcceptsRole(room, role);
}

export function canSetFounderRole(state: GameState, role: 'product' | 'sales'): Verdict {
  // DESIGN.md 0: the tournament board has no founder-role control
  if (!RULES.founderRole) return no('Not in this game.');
  const f = founderOf(state);
  if (!f) return no('There is no founder to reassign.');
  if (state.founderRole === role) return no(`You already work in ${ROLE_LABEL[role]}.`);
  if (founderNeedsNewSeat(state, f, role) && !S.seatFor(state, role)) {
    return no(`No free desk for ${withArticle(JOB_WORD[role])}: add a desk or open a ${ROLE_LABEL[role]} room.`);
  }
  return OK;
}

/** Switches the founder's role; moves them out of a department room that does not take the new role. */
export function setFounderRole(state: GameState, role: 'product' | 'sales'): void {
  const f = founderOf(state);
  if (f) {
    if (founderNeedsNewSeat(state, f, role)) {
      const seat = S.seatFor(state, role);
      if (!seat) return;
      f.roomId = seat.id;
    } else if (f.roomId === null) {
      const seat = S.seatFor(state, role);
      if (seat) f.roomId = seat.id;
    }
    f.role = role;
  }
  state.founderRole = role;
  state.log.push({ day: state.day, text: `You now work in ${ROLE_LABEL[role]}.`, tone: 'info' });
}

// ---------------------------------------------------------------- morale

/** Target morale for a person from office conditions and quirks (DESIGN.md 6). */
export function moraleTarget(state: GameState, p: Person): number {
  const M = CONFIG.people.morale;
  const room = p.roomId === null ? undefined : S.roomById(state, p.roomId);
  const coffee = S.hasCoffee(state);
  const crowded = room ? S.isRoomCrowded(state, room) : false;
  let t = M.base;
  if (!room || !p.hasLaptop) t += M.noDeskOrLaptop;
  if (coffee) t += CONFIG.assets.coffeeMorale;
  if (crowded) t += M.crowded;
  if (S.roleOverloaded(state, S.roleOf(state, p))) t += M.overload;
  if (p.raiseGrantedDay !== null && state.day - p.raiseGrantedDay < M.raiseGrantedMonths * D) t += M.raiseGranted;
  if (p.raiseRefusedDay !== null && state.day - p.raiseRefusedDay < M.raiseRefusedMonths * D) t += M.raiseRefused;
  if (p.quirk === 'coffee' && !coffee) t += M.coffeeQuirkNoMachine;
  if (p.quirk === 'crowd' && crowded) t += M.crowdQuirkAtCapacity;
  return clamp(t, 0, 100);
}

/** Give a person without a desk the first free one for their role. Returns true when seated. */
export function seatPerson(state: GameState, p: Person): boolean {
  const seat = S.seatFor(state, S.roleOf(state, p));
  if (!seat) return false;
  p.roomId = seat.id;
  state.log.push({ day: state.day, text: `${p.name} found a desk in the ${roomName(seat.kind)}.`, tone: 'info' });
  return true;
}

/** Daily: morale drifts toward target; pending raises older than raisePendingDays count as refused. */
export function dailyStaff(state: GameState): void {
  const P = CONFIG.people;
  for (const p of state.people) {
    if (p.roomId === null) seatPerson(state, p);
    if (p.raisePending && p.raiseRequestedDay !== null && state.day - p.raiseRequestedDay >= P.raisePendingDays) {
      decideRaise(state, p, false, true);
    }
  }
  // targets first, then the drift, so the day's move is simultaneous for everyone
  const targets = state.people.map((p) => moraleTarget(state, p));
  state.people.forEach((p, i) => {
    p.morale = clamp(p.morale + (targets[i] - p.morale) * P.morale.driftPerDay, 0, 100);
  });
}

// ---------------------------------------------------------------- month end

/** DESIGN.md 6: juniors gain 0.1 skill a month up to 3; a mentor in the same room doubles it. */
function learn(state: GameState): void {
  const P = CONFIG.people;
  for (const p of state.people) {
    if (p.archetype !== 'junior' || p.skill >= P.juniorLearnCap) continue;
    const mentored = p.roomId !== null && state.people.some((q) => q !== p && q.roomId === p.roomId && q.quirk === 'mentor');
    const gain = P.juniorLearnPerMonth * (mentored ? P.mentorMult : 1);
    p.skill = round1(Math.min(P.juniorLearnCap, p.skill + gain));
    if (p.skill >= P.juniorLearnCap) {
      state.log.push({ day: state.day, text: `${p.name} has grown into a solid ${JOB_WORD[p.role]} (skill ${p.skill.toFixed(1)}).`, tone: 'good' });
    }
  }
}

/**
 * DESIGN.md 6: a raise ask every 12 months (6 for divas and stars), or early when morale is low.
 * The low-morale ask waits at least the shortest regular cadence (divaRaiseEveryMonths) since the
 * last raise decision or hire, so nobody asks twice in quick succession.
 */
function requestRaises(state: GameState): void {
  const P = CONFIG.people;
  for (const p of state.people) {
    if (p.founder || p.raisePending) continue;
    const everyMonths = p.quirk === 'diva' || p.archetype === 'star' ? P.divaRaiseEveryMonths : P.raiseEveryMonths;
    const since = state.day - p.lastRaiseDay;
    const due = since >= everyMonths * D;
    const unhappy = p.morale < P.morale.askRaiseBelow && since >= P.divaRaiseEveryMonths * D;
    if (due || unhappy) askForRaise(state, p);
  }
}

/** DESIGN.md 6: morale < 20 → 10% chance a month to quit (loyal never); mercenaries already below 35. */
function quits(state: GameState): void {
  const M = CONFIG.people.morale;
  for (const p of [...state.people]) {
    if (p.founder || p.quirk === 'loyal') continue;
    const below = p.quirk === 'mercenary' ? M.mercenaryQuitBelow : M.quitBelow;
    if (p.morale < below && chance(state.rng, M.quitChancePerMonth)) {
      state.visuals.push({ t: 'toast', day: state.day, text: `${p.name} quit.`, tone: 'bad' });
      fire(state, p.id, 'quit');
    }
  }
}

/** Monthly: learning, raise requests, quits, candidate refresh. */
export function monthlyStaff(state: GameState): void {
  learn(state);
  if (RULES.raises) requestRaises(state);
  if (RULES.quits) quits(state);
  refreshCandidates(state);
}
