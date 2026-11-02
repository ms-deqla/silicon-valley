/**
 * The six events and their effects. DESIGN.md section 11.
 *
 * One card at a time; the clock is paused while it is open (game.ts skips the tick).
 * Eligibility and weights decide which story is told, the two choices apply their
 * effect: money through ledger.ts, people through staff.ts, customers through
 * customers.ts, randomness through rng.ts with state.rng. Everything else is a field
 * on state.effects that the selectors already read (press, recession, price cut,
 * salary cut, competitor).
 */
import type { Card, EventType, GameState, Invoice, LogEntry, Person } from './types';
import { EVENT_TYPES, ROLE_JOB } from './types';
import { CONFIG } from './config';
import { chance, pick, pickWeighted, randInt } from './rng';
import * as L from './ledger';
import * as S from './selectors';
import * as staff from './staff';
import * as customers from './customers';

const E = CONFIG.events;

/** Choice ids of every event card, in the order DESIGN.md 11 lists the options. */
export const EVENT_CHOICES: Record<EventType, readonly [string, string]> = {
  latePayer: ['wait', 'press'],
  outage: ['fix', 'ride'],
  press: ['push', 'enjoy'],
  competitor: ['outbuild', 'cut'],
  poach: ['counter', 'letgo'],
  recession: ['tighten', 'hold'],
};

/**
 * Relative draw weights (CONFIG.events.weights; DESIGN.md 11: a late payer is the most
 * common story). The outage weight is further multiplied by CONFIG.events.outageShortWeight
 * when servers are short; eventWeights() zeroes the events that cannot happen right now.
 */
const BASE_WEIGHT: Record<EventType, number> = E.weights;

/** Counter-offers are rounded to this (cosmetic: salaries read as round numbers). */
const SALARY_ROUND = 100;

/** Cosmetic company names for enterprise customers (Customer carries no name). */
const CUSTOMER_NAMES = [
  'Northwind Logistics', 'Halvorsen Freight', 'Meridian Health', 'Castellan Insurance',
  'Oakridge Retail', 'Pelican Energy', 'Summit Legal', 'Bluewater Shipping',
  'Granite Civil', 'Larkspur Media', 'Tidewater Foods', 'Ironbark Mining',
] as const;

// ---------------------------------------------------------------- formatting

function trimZero(s: string): string {
  return s.replace(/\.0$/, '');
}

function money(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? '−' : '';
  if (abs >= 1_000_000) return `${sign}$${trimZero((abs / 1_000_000).toFixed(1))}M`;
  if (abs >= 1_000) return `${sign}$${trimZero((abs / 1_000).toFixed(1))}k`;
  return `${sign}$${Math.round(abs)}`;
}

function pct(x: number): string {
  return `${trimZero((x * 100).toFixed(1))}%`;
}

function log(state: GameState, text: string, tone: LogEntry['tone'] = 'info'): void {
  state.log.push({ day: state.day, text, tone });
}

function toast(state: GameState, text: string, tone: LogEntry['tone']): void {
  state.visuals.push({ t: 'toast', day: state.day, text, tone });
}

function dataString(card: Card, key: string): string | null {
  const v = card.data[key];
  return typeof v === 'string' ? v : null;
}

/** Stable cosmetic name for a customer id (no rng: must not disturb the seeded stream). */
export function customerName(customerId: string): string {
  let h = 0;
  for (let i = 0; i < customerId.length; i++) h = (h * 31 + customerId.charCodeAt(i)) >>> 0;
  return CUSTOMER_NAMES[h % CUSTOMER_NAMES.length];
}

// ---------------------------------------------------------------- eligibility

/** The invoice a late payer would hold back: the largest open one, preferring ones not already pushed back. */
export function latePayerTarget(state: GameState): Invoice | null {
  const open = customers.openEnterpriseInvoices(state);
  if (open.length === 0) return null;
  const sorted = [...open].sort((a, b) =>
    (Number(a.late) - Number(b.late)) || (b.amount - a.amount) || (a.issuedDay - b.issuedDay) || a.id.localeCompare(b.id));
  return sorted[0];
}

/**
 * Who a rival could poach: non-founder seniors and stars (DESIGN.md 11). Mercenaries are
 * "poaching targets" (DESIGN.md 6), so when any is eligible the pick is made among them.
 */
export function poachTargets(state: GameState): Person[] {
  const eligible = state.people.filter((p) => !p.founder && (p.archetype === 'senior' || p.archetype === 'star'));
  const mercenaries = eligible.filter((p) => p.quirk === 'mercenary');
  return mercenaries.length > 0 ? mercenaries : eligible;
}

/** Chance a waited-on late payer never pays; finance staff halve it (DESIGN.md 8 and 11). */
export function latePayerDefaultChance(state: GameState): number {
  const halved = S.roleOutput(state, 'finance') > 0;
  return E.latePayerDefault * (halved ? CONFIG.finance.defaultHalving : 1);
}

/** Draw weight of every event right now; 0 means not eligible. */
export function eventWeights(state: GameState): Record<EventType, number> {
  const short = S.serversShort(state) > 0;
  return {
    latePayer: latePayerTarget(state) ? BASE_WEIGHT.latePayer : 0,
    outage: state.customers.length > 0 ? BASE_WEIGHT.outage * (short ? E.outageShortWeight : 1) : 0,
    press: BASE_WEIGHT.press,
    competitor: S.competitorActive(state) ? 0 : BASE_WEIGHT.competitor,
    poach: poachTargets(state).length > 0 ? BASE_WEIGHT.poach : 0,
    recession: S.recessionActive(state) ? 0 : BASE_WEIGHT.recession,
  };
}

export function eligibleEvents(state: GameState): EventType[] {
  const w = eventWeights(state);
  return EVENT_TYPES.filter((t) => w[t] > 0);
}

/** A counter-offer salary: +counterOffer, rounded to SALARY_ROUND. */
export function counterOfferSalary(baseSalary: number): number {
  return Math.round((baseSalary * (1 + E.counterOffer)) / SALARY_ROUND) * SALARY_ROUND;
}

// ---------------------------------------------------------------- the daily hooks

/** Daily: open the scheduled event when day ≥ nextEventDay (weighted by eligibility), reschedule. */
export function dailyEvents(state: GameState): void {
  if (state.card || state.status !== 'playing') return;
  if (state.day < state.schedule.nextEventDay) return;
  openEvent(state);
  // DESIGN.md 11: the next one every [90, 180] days, whether or not anything was eligible today
  state.schedule.nextEventDay = state.day + randInt(state.rng, E.everyDays[0], E.everyDays[1]);
}

/** Daily housekeeping of expiring effects (press multiplier reset etc.). */
export function dailyEffects(state: GameState): void {
  const e = state.effects;
  const day = state.day;
  // the selectors stop applying the press multiplier at pressUntilDay; the reset is cosmetic
  if (e.pressMult !== 1 && day >= e.pressUntilDay) {
    e.pressMult = 1;
    log(state, 'The press coverage has faded; visitors are back to normal.');
  }
  if (e.recessionUntilDay > 0 && day === e.recessionUntilDay) log(state, 'The recession is over: visitors and investors are back to normal.', 'good');
  if (e.priceCutUntilDay > 0 && day === e.priceCutUntilDay) log(state, 'The price cut has ended; prices are back to normal.');
  if (e.salaryCutUntilDay > 0 && day === e.salaryCutUntilDay) log(state, 'Salaries are back to full.', 'good');
}

// ---------------------------------------------------------------- opening a card

/** Open a specific event (or a weighted random eligible one). Returns null if none eligible or a card is open. */
export function openEvent(state: GameState, type?: EventType): Card | null {
  if (state.card || state.status !== 'playing') return null;
  const weights = eventWeights(state);
  let chosen: EventType;
  if (type !== undefined) {
    if (weights[type] <= 0) return null;
    chosen = type;
  } else {
    const eligible = EVENT_TYPES.filter((t) => weights[t] > 0);
    if (eligible.length === 0) return null;
    chosen = pickWeighted(state.rng, eligible, eligible.map((t) => weights[t]));
  }
  const card = buildCard(state, chosen);
  if (!card) return null;
  if (chosen === 'recession') {
    // DESIGN.md 11: the recession itself is not a choice; it starts the day the card opens
    state.effects.recessionUntilDay = state.day + E.recessionDays;
  }
  state.card = card;
  logOpening(state, card);
  return card;
}

function newCard(state: GameState, type: EventType, fields: Omit<Card, 'id' | 'kind' | 'eventType' | 'createdDay'>): Card {
  return { id: `ev${state.nextId++}`, kind: 'event', eventType: type, createdDay: state.day, ...fields };
}

function buildCard(state: GameState, type: EventType): Card | null {
  switch (type) {
    case 'latePayer': return latePayerCard(state);
    case 'outage': return outageCard(state);
    case 'press': return pressCard(state);
    case 'competitor': return competitorCard(state);
    case 'poach': return poachCard(state);
    case 'recession': return recessionCard(state);
  }
}

function logOpening(state: GameState, card: Card): void {
  switch (card.eventType) {
    case 'latePayer':
      log(state, `${customerName(dataString(card, 'customerId') ?? '')} is paying late: ${money(Number(card.data.amount))} outstanding.`, 'bad');
      break;
    case 'outage': log(state, 'Server outage: the service is down.', 'bad'); break;
    case 'press': log(state, `${state.companyName} is in the news.`, 'good'); break;
    case 'competitor': log(state, 'A competitor opened next door.', 'bad'); break;
    case 'poach': log(state, `${String(card.data.name)} has been approached by a rival.`, 'bad'); break;
    case 'recession': log(state, `A recession hits: visitors ×${E.recessionVisitors} for ${E.recessionDays} days.`, 'bad'); break;
    default: log(state, card.title);
  }
}

function latePayerCard(state: GameState): Card | null {
  const inv = latePayerTarget(state);
  if (!inv) return null;
  const who = customerName(inv.customerId);
  const p = latePayerDefaultChance(state);
  const halved = p < E.latePayerDefault;
  const dueIn = inv.dueDay - state.day;
  const when = dueIn > 0 ? `due in ${dueIn} days` : dueIn === 0 ? 'due today' : `${-dueIn} days overdue`;
  return newCard(state, 'latePayer', {
    title: 'Big customer pays late',
    speaker: `The CFO of ${who}`,
    quote: `We will pay. Just not this month. Give us ${E.latePayerDelayDays} days.`,
    body: `${who} owes you ${money(inv.amount)}, ${when}. Waiting pushes the due date out ${E.latePayerDelayDays} days, `
      + `with a ${pct(p)} chance they go under and never pay${halved ? ' (halved: your finance team chases invoices)' : ''}. `
      + `Pressing them gets the cash in ${E.pressPayDays} days, but there is a ${pct(E.pressNoRenew)} chance they will not renew.`,
    choices: [
      { id: 'wait', label: 'Wait', detail: `Due date +${E.latePayerDelayDays} days · ${pct(p)} chance of a write-off` },
      { id: 'press', label: 'Press them', detail: `Paid in ${E.pressPayDays} days · ${pct(E.pressNoRenew)} chance they do not renew` },
    ],
    data: { invoiceId: inv.id, customerId: inv.customerId, amount: inv.amount, defaultChance: p },
  });
}

function outageCard(state: GameState): Card | null {
  const n = state.customers.length;
  if (n < 1) return null;
  const owned = S.serversOwned(state);
  const needed = S.serversNeeded(state);
  const lost = Math.round(n * E.outageLoss);
  const short = needed > owned;
  return newCard(state, 'outage', {
    title: 'Server outage',
    speaker: 'Your CTO',
    quote: short
      ? `We are running ${n} customers on ${owned} server${owned === 1 ? '' : 's'}. Something had to give.`
      : 'A bad deploy took the whole stack down. I can have it back tonight if we pay for it.',
    body: `The service is down. ${n} customers sit on ${owned} server${owned === 1 ? '' : 's'} (you need ${needed}). `
      + `An emergency fix costs ${money(E.outageFix)}. Riding it out loses about ${pct(E.outageLoss)} of your customers (~${lost}).`,
    choices: [
      { id: 'fix', label: 'Emergency fix', detail: `−${money(E.outageFix)} now` },
      { id: 'ride', label: 'Ride it out', detail: `Lose about ${pct(E.outageLoss)} of customers (~${lost})` },
    ],
    data: { customers: n, serversOwned: owned, serversNeeded: needed },
  });
}

function pressCard(state: GameState): Card {
  return newCard(state, 'press', {
    title: 'Press coverage',
    speaker: 'A tech reporter',
    quote: `We are running a story on ${state.companyName} tomorrow. Anything you want to add?`,
    body: `${state.companyName} is about to be in the news. Visitors ×${E.pressMult} for ${E.pressDays} days. `
      + `A PR push costs ${money(E.prPush)} and makes it ×${E.prMult} instead.`,
    choices: [
      { id: 'push', label: 'PR push', detail: `−${money(E.prPush)} · visitors ×${E.prMult} for ${E.pressDays} days` },
      { id: 'enjoy', label: 'Enjoy it', detail: `Visitors ×${E.pressMult} for ${E.pressDays} days, free` },
    ],
    data: {},
  });
}

function competitorCard(state: GameState): Card {
  const untilFeatures = state.features + E.competitorFeatures;
  return newCard(state, 'competitor', {
    title: 'Competitor next door',
    speaker: 'A prospect, on the way out',
    quote: 'The people across the street showed us the same thing for less.',
    body: `A well-funded rival opened next door. Out-building them means conversion ×${E.competitorMult} until `
      + `${E.competitorFeatures} more features ship (you have ${state.features}; the penalty lifts at ${untilFeatures}). `
      + `Cutting prices avoids the conversion hit but puts every price at ×${E.priceCut} for ${E.priceCutDays} days.`,
    choices: [
      { id: 'outbuild', label: 'Out-build them', detail: `Conversion ×${E.competitorMult} until ${untilFeatures} features` },
      { id: 'cut', label: 'Cut prices', detail: `All prices ×${E.priceCut} for ${E.priceCutDays} days` },
    ],
    data: { untilFeatures },
  });
}

function poachCard(state: GameState): Card | null {
  const targets = poachTargets(state);
  if (targets.length === 0) return null;
  const p = pick(state.rng, targets);
  const newSalary = counterOfferSalary(p.baseSalary);
  const job = ROLE_JOB[p.role];
  return newCard(state, 'poach', {
    title: `${p.name} has an offer`,
    speaker: `${p.name}, ${job}`,
    quote: 'A rival offered me a lot more. I would rather stay, if you can get close.',
    body: `${p.name} (${p.archetype} ${job.toLowerCase()}, skill ${trimZero(p.skill.toFixed(1))}, ${money(p.baseSalary)}/month) is being poached. `
      + `A counter-offer adds ${pct(E.counterOffer)}: ${money(newSalary)}/month from now on. `
      + 'Letting them go costs no severance, but the desk goes empty today.',
    choices: [
      { id: 'counter', label: 'Counter-offer', detail: `${money(p.baseSalary)} → ${money(newSalary)}/month` },
      { id: 'letgo', label: 'Let them go', detail: 'They leave today · no severance' },
    ],
    data: { personId: p.id, name: p.name, oldSalary: p.baseSalary, newSalary },
  });
}

function recessionCard(state: GameState): Card {
  return newCard(state, 'recession', {
    title: 'Recession',
    speaker: 'The morning news',
    quote: 'Markets tumble; budgets freeze across the industry.',
    body: `A recession hits for ${E.recessionDays} days: visitors ×${E.recessionVisitors} and investors want `
      + `+${pct(CONFIG.valuation.recession)} return on top. Tightening cuts every salary by ${pct(E.tightenCut)} for `
      + `${E.recessionDays} days and costs ${Math.abs(E.tightenMorale)} morale across the team. Holding the line changes nothing else.`,
    choices: [
      { id: 'tighten', label: 'Tighten', detail: `Salaries −${pct(E.tightenCut)} for ${E.recessionDays} days · morale ${E.tightenMorale}` },
      { id: 'hold', label: 'Hold the line', detail: 'Nothing else changes' },
    ],
    data: { untilDay: state.day + E.recessionDays },
  });
}

// ---------------------------------------------------------------- resolving a card

/** Apply the chosen option; clear state.card. */
export function resolveEventCard(state: GameState, card: Card, choiceId: string): void {
  state.card = null;
  if (card.kind !== 'event' || !card.eventType) return;
  switch (card.eventType) {
    case 'latePayer': resolveLatePayer(state, card, choiceId); break;
    case 'outage': resolveOutage(state, choiceId); break;
    case 'press': resolvePress(state, choiceId); break;
    case 'competitor': resolveCompetitor(state, choiceId); break;
    case 'poach': resolvePoach(state, card, choiceId); break;
    case 'recession': resolveRecession(state, choiceId); break;
  }
}

function resolveLatePayer(state: GameState, card: Card, choiceId: string): void {
  const invoiceId = dataString(card, 'invoiceId');
  const inv = state.invoices.find((i) => i.id === invoiceId);
  if (!inv || inv.status !== 'open') {
    log(state, 'The late invoice was already settled.');
    return;
  }
  const customer = state.customers.find((c) => c.id === inv.customerId);
  const who = customerName(inv.customerId);
  if (choiceId === 'wait') {
    if (chance(state.rng, latePayerDefaultChance(state))) {
      // DESIGN.md 11: never paid → bad debt (profit) and the receivable disappears (cash never comes)
      L.writeOffInvoice(state, inv);
      if (customer) customer.noRenew = true;
      log(state, `${who} went under, ${money(inv.amount)} written off.`, 'bad');
      toast(state, `${who} went under: ${money(inv.amount)} written off`, 'bad');
    } else {
      inv.dueDay += E.latePayerDelayDays;
      inv.late = true;
      log(state, `${who} will pay ${money(inv.amount)} ${E.latePayerDelayDays} days late (now due in ${inv.dueDay - state.day} days).`);
    }
  } else if (choiceId === 'press') {
    inv.dueDay = state.day + E.pressPayDays;
    const noRenew = chance(state.rng, E.pressNoRenew);
    if (customer) customer.noRenew = customer.noRenew || noRenew;
    if (noRenew) {
      log(state, `You pressed ${who}: ${money(inv.amount)} arrives in ${E.pressPayDays} days, but they will not renew.`, 'bad');
      toast(state, `${who} will pay, but will not renew`, 'bad');
    } else {
      log(state, `You pressed ${who}: ${money(inv.amount)} arrives in ${E.pressPayDays} days.`, 'good');
    }
  }
}

function resolveOutage(state: GameState, choiceId: string): void {
  if (choiceId === 'fix') {
    L.payEventCost(state, E.outageFix);
    log(state, `Emergency server fix: −${money(E.outageFix)}.`, 'bad');
  } else if (choiceId === 'ride') {
    const lost = customers.loseCustomers(state, E.outageLoss, 'outage');
    state.visuals.push({ t: 'outage', day: state.day });
    log(state, `You rode out the outage. ${lost} customers left.`, 'bad');
  }
}

function setPress(state: GameState, mult: number): void {
  state.effects.pressUntilDay = state.day + E.pressDays;
  state.effects.pressMult = mult;
}

function resolvePress(state: GameState, choiceId: string): void {
  if (choiceId === 'push') {
    L.payEventCost(state, E.prPush);
    setPress(state, E.prMult);
    log(state, `PR push: −${money(E.prPush)}. Visitors ×${E.prMult} for ${E.pressDays} days.`, 'good');
  } else if (choiceId === 'enjoy') {
    setPress(state, E.pressMult);
    log(state, `Press coverage: visitors ×${E.pressMult} for ${E.pressDays} days.`, 'good');
  }
}

function resolveCompetitor(state: GameState, choiceId: string): void {
  if (choiceId === 'outbuild') {
    state.effects.competitorUntilFeatures = state.features + E.competitorFeatures;
    log(state, `Out-building the competitor: conversion ×${E.competitorMult} until you have ${state.effects.competitorUntilFeatures} features.`);
  } else if (choiceId === 'cut') {
    state.effects.priceCutUntilDay = state.day + E.priceCutDays;
    log(state, `Prices cut: everything ×${E.priceCut} for ${E.priceCutDays} days. No conversion penalty.`);
  }
}

function resolvePoach(state: GameState, card: Card, choiceId: string): void {
  const personId = dataString(card, 'personId');
  const p = personId ? S.personById(state, personId) : undefined;
  if (!p) {
    log(state, 'The poached employee had already left.');
    return;
  }
  if (choiceId === 'counter') {
    const old = p.baseSalary;
    p.baseSalary = counterOfferSalary(old);
    // DESIGN.md is silent here: a +30% counter-offer counts as a granted raise, so it settles any
    // pending ask, lifts morale like one and restarts the raise clock (staff.ts cadence)
    p.raisePending = false;
    p.raiseRequestedDay = null;
    p.lastRaiseDay = state.day;
    p.raiseGrantedDay = state.day;
    log(state, `${p.name} stays: salary ${money(old)} → ${money(p.baseSalary)}/month.`);
  } else if (choiceId === 'letgo') {
    // no severance for 'poached'; staff.fire logs the departure and pushes the 'leave' visual
    staff.fire(state, p.id, 'poached');
  }
}

function resolveRecession(state: GameState, choiceId: string): void {
  // same value as set when the card opened: the clock is paused while a card is open
  state.effects.recessionUntilDay = state.day + E.recessionDays;
  if (choiceId === 'tighten') {
    state.effects.salaryCutUntilDay = state.day + E.recessionDays;
    for (const p of state.people) p.morale = Math.max(0, p.morale + E.tightenMorale);
    log(state, `Belt tightened: salaries −${pct(E.tightenCut)} for ${E.recessionDays} days, morale ${E.tightenMorale} across the team.`, 'bad');
  } else if (choiceId === 'hold') {
    log(state, `You held the line through the recession: visitors ×${E.recessionVisitors} for ${E.recessionDays} days.`);
  }
}
