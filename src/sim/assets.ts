/**
 * Capex: the catalogue, buying, selling, depreciation, laptops.
 * DESIGN.md section 7.
 */
import { CONFIG } from './config';
import * as L from './ledger';
import * as S from './selectors';
import { fmtMoney, roomName } from './names';
import { ASSET_KINDS, no, OK } from './types';
import type { Asset, AssetCard, AssetKind, GameState, Person, Room, Verdict } from './types';

/** DESIGN.md 6: output = skill × (0.5 + morale / 200). Only used for the coffee payback estimate on the card. */

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

// ---------------------------------------------------------------- catalogue

function effectText(kind: AssetKind): string {
  const A = CONFIG.assets;
  const g = CONFIG.grid;
  switch (kind) {
    case 'desk': return '+1 seat in a room (needs free capacity)';
    case 'laptop': return `One per person; without one a person works at ${Math.round(CONFIG.people.noLaptopOutput * 100)}%`;
    case 'server': return `1 per ${A.customersPerServer} customers; each missing server adds a ${Math.round(A.outageChancePerMissingServer * 100)}%/month outage chance`;
    case 'coffee': return `+${A.coffeeMorale} morale for everyone, fixes the coffee quirk`;
    case 'demoRoom': return `Enterprise deals ×${A.demoRoomMult}; takes a ${CONFIG.rooms.demo.w}×${CONFIG.rooms.demo.h} block`;
    case 'secondFloor': return `Adds floor 1: another ${g.w}×${g.h} grid`;
  }
}

/** People in laptop priority order: the founder first, then by hire day (stable for ties). */
function laptopOrder(state: GameState): Person[] {
  return [...state.people].sort((a, b) => (b.founder ? 1 : 0) - (a.founder ? 1 : 0) || a.hiredDay - b.hiredDay);
}

/** Who gets the next laptop bought (null when everyone has one). */
export function nextLaptopRecipient(state: GameState): Person | null {
  return laptopOrder(state).find((p) => !p.hasLaptop) ?? null;
}

/** Estimated monthly cash benefit of buying one more of this kind today (DESIGN.md 7: payback estimate). */
export function monthlyBenefitOf(state: GameState, kind: AssetKind): number {
  const A = CONFIG.assets;
  switch (kind) {
    case 'laptop': {
      const p = nextLaptopRecipient(state);
      return p ? round2((1 - CONFIG.people.noLaptopOutput) * S.salaryOf(state, p)) : 0;
    }
    case 'server': {
      if (S.serversShort(state) <= 0) return 0;
      let revenue = 0;
      for (const c of state.customers) revenue += c.monthlyPrice;
      return round2(A.outageChancePerMissingServer * A.outageChurn * revenue);
    }
    case 'coffee':
      return S.hasCoffee(state) ? 0 : round2((A.coffeeMorale / CONFIG.people.outputMoraleDivisor) * S.monthlySalaries(state));
    case 'demoRoom': {
      if (S.hasDemoRoom(state)) return 0;
      const dealsPerMonth = S.salesCapacityPerMonth(state) * S.enterpriseCloseProb(state);
      const monthlyDeal = S.enterpriseDealValue(state) / CONFIG.customers.enterpriseContractMonths;
      return round2((A.demoRoomMult - 1) * dealsPerMonth * monthlyDeal);
    }
    default:
      return 0;
  }
}

/** One card per kind with price, effect text, monthly depreciation, payback estimate and a live verdict. */
export function catalogue(state: GameState): AssetCard[] {
  return ASSET_KINDS.map((kind) => {
    const c = CONFIG.assets.catalogue[kind];
    const monthlyBenefit = monthlyBenefitOf(state, kind);
    return {
      kind,
      label: c.label,
      price: c.price,
      lifeMonths: c.lifeMonths,
      monthlyDepreciation: round2(c.price / c.lifeMonths),
      effect: effectText(kind),
      monthlyBenefit,
      paybackMonths: monthlyBenefit > 0 ? c.price / monthlyBenefit : null,
      // a desk card has no room yet: it is buyable when any room can take one
      verdict: kind === 'desk' ? deskCatalogueVerdict(state) : canBuy(state, kind),
    };
  });
}

// ---------------------------------------------------------------- buying

function deskRoomVerdict(state: GameState, room: Room): Verdict {
  const max = S.roomMaxDesks(room);
  if (max <= 0) return no(`The ${roomName(room.kind)} takes no desks.`);
  if (S.desksIn(state, room.id).length >= max) return no(`The ${roomName(room.kind)} is full (${max} desks).`);
  return OK;
}

/** Rooms that can take one more desk (for the UI's room picker). */
export function roomsWithDeskSpace(state: GameState): Room[] {
  return state.rooms.filter((r) => deskRoomVerdict(state, r).ok);
}

function deskCatalogueVerdict(state: GameState): Verdict {
  const price = CONFIG.assets.catalogue.desk.price;
  if (state.cash < price) return no(`Not enough cash (${fmtMoney(price)}).`);
  if (roomsWithDeskSpace(state).length === 0) return no('Every room is full of desks.');
  return OK;
}

/** desk needs a roomId with free desk capacity; secondFloor once; coffee once; demoRoom is bought via placeRoom, not here. */
export function canBuy(state: GameState, kind: AssetKind, roomId?: string): Verdict {
  if (kind === 'demoRoom') return no('Place it with Build');
  // one-off assets: the permanent reason comes before the cash reason
  if (kind === 'secondFloor' && (state.floors >= 2 || S.assetsOfKind(state, 'secondFloor').length > 0)) return no('You already own the second floor.');
  if (kind === 'coffee' && S.hasCoffee(state)) return no('One coffee machine is enough.');
  const c = CONFIG.assets.catalogue[kind];
  if (state.cash < c.price) return no(`Not enough cash (${fmtMoney(c.price)}).`);
  if (kind === 'desk') {
    if (!roomId) return no('Pick a room for the desk.');
    const room = S.roomById(state, roomId);
    if (!room) return no('No such room.');
    return deskRoomVerdict(state, room);
  }
  return OK;
}

/** Records capex, creates the asset, applies instant effects (secondFloor → floors = 2; laptop → assignLaptops). */
export function buy(state: GameState, kind: AssetKind, roomId?: string): Asset {
  if (kind === 'demoRoom') throw new Error('Place the demo room with Build (rooms.placeRoom).');
  const c = CONFIG.assets.catalogue[kind];
  let room: Room | undefined;
  if (kind === 'desk') {
    room = roomId ? S.roomById(state, roomId) : roomsWithDeskSpace(state)[0];
    if (!room) throw new Error('No room can take a desk.');
  }
  L.recordCapex(state, c.price);
  const asset: Asset = {
    id: `a${state.nextId++}`,
    kind,
    cost: c.price,
    bookValue: c.price,
    lifeMonths: c.lifeMonths,
    boughtDay: state.day,
    roomId: room ? room.id : null,
  };
  state.assets.push(asset);
  if (kind === 'secondFloor') state.floors = 2;
  let note = '';
  if (kind === 'laptop') {
    const recipient = nextLaptopRecipient(state);
    assignLaptops(state);
    note = recipient ? ` ${recipient.name} gets it.` : ' It sits in the cupboard as a spare.';
  }
  if (kind === 'desk' && room) note = ` It stands in the ${roomName(room.kind)}.`;
  if (kind === 'secondFloor') note = ' The stairs are open.';
  state.visuals.push({ t: 'asset', day: state.day, kind, op: 'buy' });
  state.log.push({ day: state.day, text: `Bought a ${c.label.toLowerCase()} for ${fmtMoney(c.price)}.${note}`, tone: 'info' });
  return asset;
}

// ---------------------------------------------------------------- selling

/** Desks with someone sitting at them, the second floor with rooms on it, and the demo room cannot be sold here. */
export function canSell(state: GameState, assetId: string): Verdict {
  const a = state.assets.find((x) => x.id === assetId);
  if (!a) return no('No such asset.');
  switch (a.kind) {
    case 'desk': {
      if (a.roomId !== null && S.occupantsOf(state, a.roomId).length >= S.desksIn(state, a.roomId).length) {
        return no('Someone is sitting at that desk.');
      }
      break;
    }
    case 'secondFloor':
      if (state.rooms.some((r) => r.floor === 1)) return no('Close the rooms upstairs first.');
      break;
    case 'demoRoom':
      return no('Close the demo room with Build');
    default:
      break;
  }
  return OK;
}

/** ledger.recordDisposal then remove; laptops → reassign; secondFloor → floors = 1. Returns proceeds. */
export function sell(state: GameState, assetId: string): number {
  const idx = state.assets.findIndex((x) => x.id === assetId);
  if (idx < 0) return 0;
  const a = state.assets[idx];
  const book = a.bookValue;
  const spareBefore = S.spareLaptops(state);
  // DESIGN.md 7: resale = 60% of book value; the P&L takes the loss
  const proceeds = L.recordDisposal(state, a);
  state.assets.splice(idx, 1);
  let note = '';
  if (a.kind === 'laptop') {
    assignLaptops(state);
    if (spareBefore <= 0) {
      // no spare existed, so the last person in priority order lost theirs
      const loser = laptopOrder(state)[S.laptopsOwned(state)];
      if (loser) note = ` ${loser.name} now works without one.`;
    }
  }
  if (a.kind === 'secondFloor') state.floors = 1;
  state.visuals.push({ t: 'asset', day: state.day, kind: a.kind, op: 'sell' });
  const label = CONFIG.assets.catalogue[a.kind].label.toLowerCase();
  state.log.push({ day: state.day, text: `Sold a ${label} for ${fmtMoney(proceeds)} (book ${fmtMoney(book)}).${note}`, tone: 'info' });
  return proceeds;
}

// ---------------------------------------------------------------- month end

/** Straight line: cost / lifeMonths per month, never below 0; books via ledger.recordDepreciation. */
export function bookMonthlyDepreciation(state: GameState): void {
  let total = 0;
  for (const a of state.assets) {
    if (a.bookValue <= 0) {
      a.bookValue = 0; // fully depreciated: kept at book 0 (DESIGN.md 14, close step 2)
      continue;
    }
    const monthly = round2(a.cost / a.lifeMonths);
    const dep = Math.min(a.bookValue, monthly);
    a.bookValue = round2(a.bookValue - dep);
    total += dep;
  }
  L.recordDepreciation(state, round2(total));
}

// ---------------------------------------------------------------- laptops

/** Hand laptops to people without one while spares exist; take them back when people leave. Founder first, then by hire day. */
export function assignLaptops(state: GameState): void {
  let left = S.laptopsOwned(state);
  for (const p of laptopOrder(state)) {
    p.hasLaptop = left > 0;
    if (left > 0) left -= 1;
  }
}
