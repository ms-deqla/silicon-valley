/**
 * Visitors, conversion, prospects, deals, invoices, churn, renewals, tickets.
 * DESIGN.md section 8. The daily order is tick step 6 of section 14:
 * arrivals → sales attention and closes → collections due today → SMB churn →
 * enterprise contract ends → prospect expiry. Month end bills SMB and fixes the
 * tickets-served share that drives next month's churn and the renewal decisions.
 */
import type { Customer, GameState, Invoice, Person, Prospect } from './types';
import { CONFIG } from './config';
import * as L from './ledger';
import * as S from './selectors';
import { chance, poisson, rand } from './rng';

const D = CONFIG.time.daysPerMonth;
const C = CONFIG.customers;

/** Cosmetic: at most this many churn figures walk out per day; the Books panel has the real count. */
const MAX_CHURN_VISUALS_PER_DAY = CONFIG.ui.maxChurnVisualsPerDay;

// ---------------------------------------------------------------- helpers

/** "$39k", "$39.5k", "$300" — for log lines only. */
function money(x: number): string {
  if (Math.abs(x) >= 1000) {
    const k = x / 1000;
    return `$${Number.isInteger(k) ? k.toFixed(0) : k.toFixed(1)}k`;
  }
  return `$${Math.round(x)}`;
}

function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

/** Remove every element matching pred (called in order, with the original index), in place. Returns the removed ones. */
function removeWhere<T>(arr: T[], pred: (x: T, i: number) => boolean): T[] {
  const removed: T[] = [];
  let w = 0;
  for (let r = 0; r < arr.length; r++) {
    const x = arr[r];
    if (pred(x, r)) removed.push(x);
    else arr[w++] = x;
  }
  arr.length = w;
  return removed;
}

function newSmbCustomer(state: GameState, monthlyPrice: number): Customer {
  return {
    id: `c${state.nextId++}`,
    kind: 'smb',
    joinedDay: state.day,
    monthlyPrice,
    contractValue: 0,
    contractEndDay: null,
    noRenew: false,
    servedShare: 1,
  };
}

/** Invoice terms in whole days (the selector is fractional with finance staff; due days are days). */
function termsDays(state: GameState): number {
  return Math.round(S.invoiceTermsDays(state));
}

function pushChurnVisuals(state: GameState, gone: Customer[]): void {
  for (const c of gone.slice(0, MAX_CHURN_VISUALS_PER_DAY)) state.visuals.push({ t: 'churn', day: state.day, kind: c.kind });
}

// ---------------------------------------------------------------- daily

/**
 * Daily: Poisson visitors; split SMB/enterprise; SMB convert or leave (visual 'visitor');
 * prospects wait for reps, progress, close (ledger.bookEnterpriseDeal, commission for stars, visual 'invoice');
 * collect invoices due today (ledger.collectInvoice, visual 'coins'); SMB churn hazard; enterprise contract ends
 * (renew → new deal, else leave); prospects expire.
 */
export function dailyCustomers(state: GameState): void {
  arrivals(state);
  workProspects(state);
  collectDueInvoices(state);
  churnSmb(state);
  endContracts(state);
  expireProspects(state);
}

/** DESIGN.md 8: arrivals are Poisson per day; 10% are enterprise prospects, the rest SMB. */
function arrivals(state: GameState): void {
  const n = poisson(state.rng, S.visitorsPerMonth(state) / D);
  state.book.visitors += n;
  for (let i = 0; i < n; i++) {
    if (chance(state.rng, C.enterpriseShare)) arriveEnterprise(state);
    else arriveSmb(state);
  }
}

/** DESIGN.md 8: SMB converts at 0.8 × feature factor (× 0.75 with a competitor), at today's price. */
function arriveSmb(state: GameState): void {
  if (chance(state.rng, S.smbConversion(state))) {
    state.customers.push(newSmbCustomer(state, S.smbPrice(state)));
    state.book.smbSignups += 1;
    state.visuals.push({ t: 'visitor', day: state.day, outcome: 'smb' });
  } else {
    state.visuals.push({ t: 'visitor', day: state.day, outcome: 'left' });
  }
}

/** DESIGN.md 8: an enterprise prospect waits in the lobby up to 45 days; the deal value is fixed on arrival. */
function arriveEnterprise(state: GameState): void {
  const p: Prospect = {
    id: `pr${state.nextId++}`,
    arrivedDay: state.day,
    expiresDay: state.day + C.prospectWaitDays,
    value: S.enterpriseDealValue(state),
    repId: null,
    progress: 0,
  };
  state.prospects.push(p);
  state.visuals.push({ t: 'visitor', day: state.day, outcome: 'waiting' });
  state.log.push({
    day: state.day,
    text: `An enterprise prospect is waiting in the lobby: a ${money(p.value)} deal if a rep closes it.`,
    tone: 'info',
  });
}

/** Is the prospect's rep still in sales? False when nobody picked it up, or its rep left (fired, quit, founder off sales). */
function hasLiveRep(reps: Person[], p: Prospect): boolean {
  return p.repId !== null && reps.some((r) => r.id === p.repId);
}

/** The sales person with the highest output; the founder counts while playing sales. */
function bestRep(state: GameState, reps: Person[]): Person | null {
  let best: Person | null = null;
  let bestOutput = -1;
  for (const r of reps) {
    const o = S.outputOf(state, r);
    if (o > bestOutput) {
      best = r;
      bestOutput = o;
    }
  }
  return best;
}

/**
 * DESIGN.md 8: a rep closes output × 0.5 deals per month of attention. Capacity flows FIFO:
 * the oldest unfinished prospect takes it until its progress reaches 1, the remainder flows on.
 */
function workProspects(state: GameState): void {
  if (state.prospects.length === 0) return;
  let capacity = S.salesCapacityPerMonth(state) / D;
  if (capacity <= 0) return;
  const reps = S.peopleIn(state, 'sales');
  const best = bestRep(state, reps);
  const finished: Prospect[] = [];
  for (const p of state.prospects) {
    if (capacity <= 0) break;
    if (best && !hasLiveRep(reps, p)) p.repId = best.id;
    const need = 1 - p.progress;
    if (capacity >= need) {
      p.progress = 1;
      capacity -= need;
      finished.push(p);
    } else {
      p.progress += capacity;
      capacity = 0;
    }
  }
  for (const p of finished) {
    removeWhere(state.prospects, (q) => q.id === p.id);
    // DESIGN.md 8: close probability = 0.5 × feature factor (× 0.75 with a competitor)
    if (chance(state.rng, S.enterpriseCloseProb(state))) closeDeal(state, p);
    else walkAway(state, p);
  }
}

/** DESIGN.md 8: the full contract value is booked as revenue at signing; the invoice is collected in `terms` days. */
function closeDeal(state: GameState, p: Prospect): void {
  const value = p.value;
  const customer: Customer = {
    id: `c${state.nextId++}`,
    kind: 'enterprise',
    joinedDay: state.day,
    monthlyPrice: value / C.enterpriseContractMonths,
    contractValue: value,
    contractEndDay: state.day + C.enterpriseContractMonths * D,
    noRenew: false,
    servedShare: 1,
  };
  state.customers.push(customer);
  const terms = termsDays(state);
  const inv = L.bookEnterpriseDeal(state, customer.id, value, terms);
  const rep = p.repId === null ? undefined : S.personById(state, p.repId);
  state.visuals.push({ t: 'visitor', day: state.day, outcome: 'enterprise' });
  state.visuals.push({ t: 'invoice', day: state.day, amount: value, dueDay: inv.dueDay });
  state.log.push({
    day: state.day,
    text: `Enterprise deal signed${rep ? ` by ${rep.name}` : ''}: ${money(value)} booked as revenue now; the invoice is due on day ${inv.dueDay} (${terms} days).`,
    tone: 'good',
  });
  state.visuals.push({ t: 'toast', day: state.day, text: `Deal signed: ${money(value)}. Cash lands in ${terms} days.`, tone: 'good' });

  // DESIGN.md 8: star reps take 10% commission in cash at signing
  if (rep && rep.archetype === 'star') {
    const commission = value * CONFIG.people.starCommission;
    L.payCommission(state, commission);
    state.log.push({ day: state.day, text: `${rep.name} took a ${money(commission)} commission, paid in cash today.`, tone: 'info' });
  }
}

function walkAway(state: GameState, p: Prospect): void {
  state.visuals.push({ t: 'visitor', day: state.day, outcome: 'left' });
  state.log.push({ day: state.day, text: `An enterprise prospect (${money(p.value)}) heard the pitch and walked.`, tone: 'bad' });
}

/** DESIGN.md 8: cash arrives on the due day. */
function collectDueInvoices(state: GameState): void {
  for (const inv of state.invoices) {
    if (inv.status !== 'open' || inv.dueDay > state.day) continue;
    L.collectInvoice(state, inv);
    state.visuals.push({ t: 'coins', day: state.day, amount: inv.amount, source: 'collection' });
    state.log.push({ day: state.day, text: `Invoice paid${inv.late ? ' (late)' : ''}: ${money(inv.amount)} is in the bank.`, tone: 'good' });
  }
}

/** DESIGN.md 8: daily hazard = (2% + 6% × share of tickets unserved) / 30, from last month's served share. */
function churnSmb(state: GameState): void {
  const hazard = S.monthlySmbChurn(state, state.ticketsServedShare) / D;
  const gone = removeWhere(state.customers, (c) => c.kind === 'smb' && chance(state.rng, hazard));
  if (gone.length === 0) return;
  state.book.churned += gone.length;
  pushChurnVisuals(state, gone);
  const why = state.ticketsServedShare < 1 ? ` Support served only ${pct(state.ticketsServedShare)} of tickets last month.` : '';
  state.log.push({ day: state.day, text: `${gone.length} subscriber${gone.length === 1 ? '' : 's'} cancelled.${why}`, tone: 'bad' });
}

/** DESIGN.md 8: after 12 months an enterprise customer renews if served ≥ 50% of tickets, else leaves. */
function endContracts(state: GameState): void {
  const leaving = new Set<string>();
  for (const c of state.customers) {
    if (c.kind !== 'enterprise' || c.contractEndDay === null || c.contractEndDay > state.day) continue;
    if (c.servedShare >= C.renewServedMin && !c.noRenew) renewContract(state, c);
    else leaving.add(c.id);
  }
  if (leaving.size === 0) return;
  const gone = removeWhere(state.customers, (c) => leaving.has(c.id));
  state.book.churned += gone.length;
  pushChurnVisuals(state, gone);
  for (const c of gone) {
    const why = c.noRenew ? 'they had warned they would not renew' : `support served only ${pct(c.servedShare)} of their tickets`;
    state.log.push({ day: state.day, text: `Enterprise customer left at contract end (${money(c.contractValue)} a year): ${why}.`, tone: 'bad' });
  }
}

/** A renewal is a new deal at today's value with a new invoice. No commission: nobody sold it. */
function renewContract(state: GameState, c: Customer): void {
  const value = S.enterpriseDealValue(state);
  c.contractValue = value;
  c.monthlyPrice = value / C.enterpriseContractMonths;
  c.contractEndDay = Math.max(c.contractEndDay ?? state.day, state.day) + C.enterpriseContractMonths * D;
  const terms = termsDays(state);
  const inv = L.bookEnterpriseDeal(state, c.id, value, terms);
  state.visuals.push({ t: 'invoice', day: state.day, amount: value, dueDay: inv.dueDay });
  state.log.push({
    day: state.day,
    text: `Enterprise customer renewed for another year: ${money(value)} booked; the invoice is due on day ${inv.dueDay} (${terms} days).`,
    tone: 'good',
  });
}

/**
 * DESIGN.md 8: a prospect waits in the lobby up to 45 days for a rep with free capacity. The limit is on
 * the wait, not on the pitch: once a rep has picked a prospect up it stays until that rep finishes it
 * (closeDeal or walkAway). Only a prospect with no live rep gives up on its expiry day: one nobody has
 * touched yet, or one whose rep left sales (staff.fire clears repId; the founder leaving sales strands
 * the id) and nobody picked it up again today — workProspects runs first, so a new rep keeps it.
 */
function expireProspects(state: GameState): void {
  const reps = S.peopleIn(state, 'sales');
  const gone = removeWhere(state.prospects, (p) => p.expiresDay <= state.day && !hasLiveRep(reps, p));
  for (const p of gone) {
    state.visuals.push({ t: 'visitor', day: state.day, outcome: 'left' });
    state.log.push({ day: state.day, text: `An enterprise prospect (${money(p.value)}) gave up waiting for a sales rep.`, tone: 'bad' });
  }
}

// ---------------------------------------------------------------- monthly

/** Month end: bill SMB subscriptions (ledger.billSmb), compute tickets served share → state.ticketsServedShare and per-customer servedShare. */
export function monthlyCustomers(state: GameState): void {
  // DESIGN.md 8: SMB subscriptions are billed at month end, cash and revenue in the same month.
  // A subscriber pays today's price (features, tier, price cut), so the feature count and a
  // price cut (DESIGN.md 11: "all prices ×0.85") reach existing subscribers, not only new ones.
  const price = S.smbPrice(state);
  let total = 0;
  let n = 0;
  for (const c of state.customers) {
    if (c.kind !== 'smb') continue;
    c.monthlyPrice = price;
    total += price;
    n += 1;
  }
  if (total > 0) {
    L.billSmb(state, total);
    state.visuals.push({ t: 'coins', day: state.day, amount: total, source: 'smb' });
    state.log.push({
      day: state.day,
      text: `Billed ${n} subscriber${n === 1 ? '' : 's'}: ${money(total)} (${state.book.smbSignups} joined, ${state.book.churned} left this month).`,
      tone: 'good',
    });
  }

  // DESIGN.md 8: tickets = 0.3 per customer per month, an agent serves 15 × output; the share served
  // this month drives next month's SMB churn and each enterprise renewal decision
  const served = S.servedShareNow(state);
  state.ticketsServedShare = served;
  for (const c of state.customers) c.servedShare = served;
  if (state.customers.length > 0 && served < 1) {
    state.log.push({
      day: state.day,
      text: `Support served only ${pct(served)} of tickets this month: churn rises and renewals are at risk.`,
      tone: 'bad',
    });
  }
}

// ---------------------------------------------------------------- bulk changes

/** Remove a share of customers (outage). Returns the count removed. Pushes visual 'churn' entries (capped). */
export function loseCustomers(state: GameState, share: number, reason: string): number {
  void reason; // the caller writes the log line it wants (game.ts for outages, events for cards)
  const total = state.customers.length;
  const n = Math.max(0, Math.min(total, Math.round(share * total)));
  if (n === 0) return 0;
  // n distinct customers chosen with the seeded rng (partial Fisher–Yates over indices)
  const order = state.customers.map((_, i) => i);
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(rand(state.rng) * (total - i));
    const t = order[i];
    order[i] = order[j];
    order[j] = t;
  }
  const chosen = new Set(order.slice(0, n));
  const gone = removeWhere(state.customers, (_, i) => chosen.has(i));
  state.book.churned += gone.length;
  pushChurnVisuals(state, gone);
  return gone.length;
}

export function openEnterpriseInvoices(state: GameState): Invoice[] {
  return state.invoices.filter((i) => i.status === 'open');
}

/** Debug: add n SMB customers at today's price. */
export function addCustomersDebug(state: GameState, n: number): void {
  const price = S.smbPrice(state);
  for (let i = 0; i < n; i++) {
    state.customers.push(newSmbCustomer(state, price));
    state.visuals.push({ t: 'visitor', day: state.day, outcome: 'smb' });
  }
  state.log.push({ day: state.day, text: `Debug: +${n} subscribers at ${money(price)} a month.`, tone: 'info' });
}
