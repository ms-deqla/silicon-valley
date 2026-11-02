/**
 * Derived numbers, all pure reads of GameState. The UI and every sim module use
 * these instead of recomputing capacities, so the game has one definition of
 * "how many visitors a month" or "what does this person cost".
 */
import type { Asset, Customer, GameState, Person, Role, Room, RoomKind } from './types';
import { CONFIG } from './config';
import { debtOf, openReceivables } from './ledger';

const D = CONFIG.time.daysPerMonth;

// ---------------------------------------------------------------- calendar

/** 0-based month index of a day. Day 1..30 → 0, day 31..60 → 1. Day 0 → 0. */
export function monthIndex(day: number): number {
  return Math.max(0, Math.ceil(day / D) - 1);
}

export const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function calendar(day: number): { year: number; quarter: number; month: number; monthName: string; dayOfMonth: number; label: string } {
  const m = monthIndex(day);
  const year = Math.floor(m / 12) + 1;
  const monthOfYear = m % 12;
  const quarter = Math.floor(monthOfYear / 3) + 1;
  const dayOfMonth = day === 0 ? 1 : ((day - 1) % D) + 1;
  return {
    year,
    quarter,
    month: m,
    monthName: MONTH_NAMES[monthOfYear],
    dayOfMonth,
    label: `Year ${year} · Q${quarter} · ${MONTH_NAMES[monthOfYear]}`,
  };
}

// ---------------------------------------------------------------- people

export function salaryOf(state: GameState, p: Person): number {
  if (p.founder) return 0;
  const cut = state.day < state.effects.salaryCutUntilDay ? CONFIG.events.tightenCut : 0;
  return p.baseSalary * (1 - cut);
}

/** Effective role of a person (the founder plays state.founderRole). */
export function roleOf(state: GameState, p: Person): Role {
  return p.founder ? state.founderRole : p.role;
}

export function outputOf(state: GameState, p: Person): number {
  const laptop = p.hasLaptop ? 1 : CONFIG.people.noLaptopOutput;
  return p.skill * (0.5 + p.morale / 200) * laptop;
}

export function peopleIn(state: GameState, role: Role): Person[] {
  return state.people.filter((p) => roleOf(state, p) === role);
}

export function roleOutput(state: GameState, role: Role): number {
  let o = 0;
  for (const p of peopleIn(state, role)) o += outputOf(state, p);
  return o;
}

export function personById(state: GameState, id: string): Person | undefined {
  return state.people.find((p) => p.id === id);
}

export function monthlySalaries(state: GameState): number {
  let s = 0;
  for (const p of state.people) s += salaryOf(state, p);
  return s;
}

export function severanceOf(state: GameState, p: Person): number {
  return p.baseSalary * CONFIG.people.severanceMonths;
}

// ---------------------------------------------------------------- rooms & seats

export function roomById(state: GameState, id: string): Room | undefined {
  return state.rooms.find((r) => r.id === id);
}

export function roomsOf(state: GameState, kind: RoomKind): Room[] {
  return state.rooms.filter((r) => r.kind === kind);
}

export function hasRoom(state: GameState, kind: RoomKind): boolean {
  return state.rooms.some((r) => r.kind === kind);
}

export function roomMaxDesks(room: Room): number {
  if (room.kind === 'garage') return CONFIG.rooms.garage.maxDesks;
  if (room.kind === 'lobby') return CONFIG.rooms.lobby.maxDesks;
  if (room.kind === 'demo') return CONFIG.rooms.demo.maxDesks;
  return CONFIG.rooms.size[room.size].maxDesks;
}

export function desksIn(state: GameState, roomId: string): Asset[] {
  return state.assets.filter((a) => a.kind === 'desk' && a.roomId === roomId);
}

export function occupantsOf(state: GameState, roomId: string): Person[] {
  return state.people.filter((p) => p.roomId === roomId);
}

export function freeSeatsIn(state: GameState, roomId: string): number {
  return desksIn(state, roomId).length - occupantsOf(state, roomId).length;
}

/** Can this role sit in this room? Department rooms take their role; the garage takes anyone. */
export function roomAcceptsRole(room: Room, role: Role): boolean {
  return room.kind === 'garage' || room.kind === role;
}

/** A room with a free desk for the role, department rooms first, garage last. */
export function seatFor(state: GameState, role: Role): Room | null {
  const candidates = state.rooms.filter((r) => roomAcceptsRole(r, role) && freeSeatsIn(state, r.id) > 0);
  candidates.sort((a, b) => (a.kind === 'garage' ? 1 : 0) - (b.kind === 'garage' ? 1 : 0));
  return candidates[0] ?? null;
}

export function monthlyRent(state: GameState): number {
  let r = 0;
  for (const room of state.rooms) r += room.rent;
  return r;
}

export function isRoomCrowded(state: GameState, room: Room): boolean {
  return occupantsOf(state, room.id).length >= roomMaxDesks(room) && roomMaxDesks(room) > 0;
}

// ---------------------------------------------------------------- assets

export function assetsOfKind(state: GameState, kind: Asset['kind']): Asset[] {
  return state.assets.filter((a) => a.kind === kind);
}

export function hasCoffee(state: GameState): boolean {
  return state.assets.some((a) => a.kind === 'coffee');
}

export function hasDemoRoom(state: GameState): boolean {
  return state.assets.some((a) => a.kind === 'demoRoom');
}

export function serversOwned(state: GameState): number {
  return assetsOfKind(state, 'server').length;
}

export function serversNeeded(state: GameState): number {
  return Math.ceil(state.customers.length / CONFIG.assets.customersPerServer);
}

export function serversShort(state: GameState): number {
  return Math.max(0, serversNeeded(state) - serversOwned(state));
}

export function laptopsOwned(state: GameState): number {
  return assetsOfKind(state, 'laptop').length;
}

export function spareLaptops(state: GameState): number {
  return laptopsOwned(state) - state.people.filter((p) => p.hasLaptop).length;
}

// ---------------------------------------------------------------- product & customers

export function tierMult(state: GameState): number {
  return CONFIG.rnd.tierMult[state.tier];
}

export function featureCost(state: GameState): number {
  return CONFIG.product.featureBaseCost + CONFIG.product.featureCostPerFeature * state.features;
}

export function featureFactor(state: GameState): number {
  return 1 - Math.exp(-CONFIG.product.conversionK * state.features);
}

export function competitorActive(state: GameState): boolean {
  return state.effects.competitorUntilFeatures !== null && state.features < state.effects.competitorUntilFeatures;
}

export function recessionActive(state: GameState): boolean {
  return state.day < state.effects.recessionUntilDay;
}

export function pressActive(state: GameState): boolean {
  return state.day < state.effects.pressUntilDay;
}

export function priceCutActive(state: GameState): boolean {
  return state.day < state.effects.priceCutUntilDay;
}

export function priceMult(state: GameState): number {
  const priced = Math.min(state.features, CONFIG.product.priceFeatureCap);
  return (1 + CONFIG.product.pricePerFeature * priced) * tierMult(state) * (priceCutActive(state) ? CONFIG.events.priceCut : 1);
}

/** DESIGN.md 8: the market is finite; every extra customer makes the next one a little harder to win. */
export function marketSaturation(state: GameState): number {
  const m = CONFIG.customers.marketSize;
  return m / (m + state.customers.length);
}

/** Monthly price a new SMB customer would pay today. */
export function smbPrice(state: GameState): number {
  return CONFIG.customers.smbPrice * priceMult(state);
}

/** Annual contract a new enterprise deal would be worth today. */
export function enterpriseDealValue(state: GameState): number {
  return CONFIG.customers.enterpriseDeal * priceMult(state) * (hasDemoRoom(state) ? CONFIG.assets.demoRoomMult : 1);
}

export function smbConversion(state: GameState): number {
  return CONFIG.product.conversionMax * featureFactor(state) * marketSaturation(state) * (competitorActive(state) ? CONFIG.events.competitorMult : 1);
}

export function enterpriseCloseProb(state: GameState): number {
  return CONFIG.customers.closeProb * featureFactor(state) * marketSaturation(state) * (competitorActive(state) ? CONFIG.events.competitorMult : 1);
}

export function visitorsPerMonth(state: GameState): number {
  const m = CONFIG.marketing;
  let v = m.baseVisitorsPerMonth;
  if (hasRoom(state, 'marketing')) {
    v += m.visitorsPerOutput * roleOutput(state, 'marketing');
    v += m.adVisitorsPerSqrtK * Math.sqrt(state.adBudget / 1000);
  }
  if (pressActive(state)) v *= state.effects.pressMult;
  if (recessionActive(state)) v *= CONFIG.events.recessionVisitors;
  return v;
}

/** Deals a month the sales team can progress. */
export function salesCapacityPerMonth(state: GameState): number {
  return CONFIG.customers.dealsPerRepOutput * roleOutput(state, 'sales');
}

export function ticketsPerMonth(state: GameState): number {
  return CONFIG.customers.ticketsPerCustomerPerMonth * state.customers.length;
}

export function ticketCapacityPerMonth(state: GameState): number {
  return CONFIG.customers.ticketsPerAgentOutput * roleOutput(state, 'support');
}

/** Share of tickets that would be served at current staffing, 0..1 (1 when no customers). */
export function servedShareNow(state: GameState): number {
  const demand = ticketsPerMonth(state);
  if (demand <= 0) return 1;
  return Math.min(1, ticketCapacityPerMonth(state) / demand);
}

export function monthlySmbChurn(state: GameState, servedShare: number): number {
  return CONFIG.customers.churnBase + CONFIG.customers.churnUnserved * (1 - servedShare);
}

export function invoiceTermsDays(state: GameState): number {
  const f = CONFIG.finance;
  const financeOutput = hasRoom(state, 'finance') ? roleOutput(state, 'finance') : 0;
  return Math.max(f.termsFloor, f.terms - f.termsPerSkill * financeOutput);
}

/** Is a department overloaded? DESIGN.md 6: dept demand > capacity, no slack. Used for morale. */
export function roleOverloaded(state: GameState, role: Role): boolean {
  switch (role) {
    case 'support': return ticketsPerMonth(state) > ticketCapacityPerMonth(state);
    case 'sales': return state.prospects.length > Math.max(1, salesCapacityPerMonth(state));
    default: return false;
  }
}

export function customersOfKind(state: GameState, kind: Customer['kind']): Customer[] {
  return state.customers.filter((c) => c.kind === kind);
}

export function annualisedRevenue(state: GameState): number {
  let r = 0;
  for (const c of state.customers) r += c.monthlyPrice * 12;
  return r;
}

export function largestCustomerShare(state: GameState): number {
  const total = annualisedRevenue(state);
  if (total <= 0) return 0;
  let max = 0;
  for (const c of state.customers) max = Math.max(max, c.monthlyPrice * 12);
  return max / total;
}

// ---------------------------------------------------------------- money

export function monthlyInterest(state: GameState): number {
  return state.loan ? (state.loan.principal * state.loan.annualRate) / 12 : 0;
}

export function monthlyAdSpend(state: GameState): number {
  return hasRoom(state, 'marketing') ? state.adBudget : 0;
}

/** Run-rate monthly operating costs at today's staffing (cash view, no depreciation). */
export function monthlyCosts(state: GameState): { salaries: number; rent: number; marketing: number; interest: number; total: number } {
  const salaries = monthlySalaries(state);
  const rent = monthlyRent(state);
  const marketing = monthlyAdSpend(state);
  const interest = monthlyInterest(state);
  return { salaries, rent, marketing, interest, total: salaries + rent + marketing + interest };
}

export function rndCostShare(state: GameState): number {
  const total = monthlyCosts(state).total;
  if (total <= 0) return 0;
  let rnd = 0;
  for (const p of peopleIn(state, 'rnd')) rnd += salaryOf(state, p);
  return rnd / total;
}

/** Average FCF over the last n closed months; null when no month has closed. */
export function averageFcf(state: GameState, n: number = CONFIG.valuation.runRateMonths): number | null {
  const h = state.history.slice(-n);
  if (h.length === 0) return null;
  let s = 0;
  for (const b of h) s += b.fcf;
  return s / h.length;
}

/** Monthly burn (positive number) from the FCF run-rate, or from the cost run-rate before any close. */
export function monthlyBurn(state: GameState): number {
  const avg = averageFcf(state);
  const burn = avg === null ? monthlyCosts(state).total - state.customers.reduce((s, c) => s + (c.kind === 'smb' ? c.monthlyPrice : 0), 0) : -avg;
  return Math.max(0, burn);
}

/** Months of cash left at the current burn; null when not burning. */
export function runwayMonths(state: GameState): number | null {
  const burn = monthlyBurn(state);
  if (burn <= 0) return null;
  return Math.max(0, state.cash) / burn;
}

export function netCash(state: GameState): number {
  return state.cash - debtOf(state);
}

export { openReceivables, debtOf };
