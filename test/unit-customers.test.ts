/**
 * Customers and product (DESIGN.md section 8): conversion, enterprise deals and invoices,
 * commission, churn, SMB billing, renewals, prospect expiry, features and tiers.
 * States are hand-built: createGame, then people / rooms / features pushed directly so
 * the tests do not depend on rooms.ts, and on staff.ts only where firing a rep is the point.
 */
import { describe, expect, it } from 'vitest';
import { CONFIG } from '../src/sim/config';
import { advanceTo, createGame } from '../src/sim/game';
import * as L from '../src/sim/ledger';
import * as S from '../src/sim/selectors';
import * as customers from '../src/sim/customers';
import * as product from '../src/sim/product';
import * as staff from '../src/sim/staff';
import type { Archetype, Customer, GameState, Invoice, Person, Prospect, Role, RoomKind, Room, VisualEvent } from '../src/sim/types';

const D = CONFIG.time.daysPerMonth;
const MONTHS = CONFIG.customers.enterpriseContractMonths;

// ---------------------------------------------------------------- builders

function addPerson(s: GameState, role: Role, archetype: Archetype, skill: number, salary = 0): Person {
  const p: Person = {
    id: `p${s.nextId++}`,
    name: `${archetype} ${role} ${s.nextId}`,
    role,
    archetype,
    quirk: 'loyal',
    skill,
    baseSalary: salary,
    morale: CONFIG.people.morale.start,
    roomId: null,
    hiredDay: s.day,
    lastRaiseDay: s.day,
    raisePending: false,
    raiseRequestedDay: null,
    raiseGrantedDay: null,
    raiseRefusedDay: null,
    founder: false,
    hasLaptop: true,
  };
  s.people.push(p);
  return p;
}

function addRoom(s: GameState, kind: RoomKind): Room {
  const r: Room = { id: `r${s.nextId++}`, kind, size: 'small', floor: 0, x: 0, y: 0, w: 2, h: 2, rent: 0, openedDay: s.day };
  s.rooms.push(r);
  return r;
}

function addProspect(s: GameState, expiresIn = 10_000): Prospect {
  const p: Prospect = {
    id: `pr${s.nextId++}`,
    arrivedDay: s.day,
    expiresDay: s.day + expiresIn,
    value: S.enterpriseDealValue(s),
    repId: null,
    progress: 0,
  };
  s.prospects.push(p);
  return p;
}

function addEnterprise(s: GameState, contractEndDay: number, servedShare: number, noRenew = false): Customer {
  const value = S.enterpriseDealValue(s);
  const c: Customer = {
    id: `c${s.nextId++}`,
    kind: 'enterprise',
    joinedDay: s.day,
    monthlyPrice: value / MONTHS,
    contractValue: value,
    contractEndDay,
    noRenew,
    servedShare,
  };
  s.customers.push(c);
  return c;
}

/** My daily step only: no accruals, no other modules. */
function runDays(s: GameState, n: number, onDay?: (day: number) => void): void {
  for (let i = 0; i < n; i++) {
    s.day += 1;
    customers.dailyCustomers(s);
    onDay?.(s.day);
  }
}

function visuals<T extends VisualEvent['t']>(s: GameState, t: T): Extract<VisualEvent, { t: T }>[] {
  return s.visuals.filter((v): v is Extract<VisualEvent, { t: T }> => v.t === t);
}

function enterpriseCustomers(s: GameState): Customer[] {
  return s.customers.filter((c) => c.kind === 'enterprise');
}

// ---------------------------------------------------------------- visitors & conversion

describe('visitors and SMB conversion', () => {
  it('converts nobody without features, and converts once features exist', () => {
    const s = createGame(1);
    addRoom(s, 'marketing');
    addPerson(s, 'marketing', 'star', 5);
    s.adBudget = CONFIG.marketing.adMax;
    expect(S.smbConversion(s)).toBe(0);

    runDays(s, 90);
    expect(s.book.visitors).toBeGreaterThan(50);
    expect(s.customers).toHaveLength(0);
    expect(s.book.smbSignups).toBe(0);
    expect(visuals(s, 'visitor').some((v) => v.outcome === 'smb')).toBe(false);
    expect(visuals(s, 'visitor').filter((v) => v.outcome === 'left').length).toBeGreaterThan(0);

    s.features = 10;
    const price = S.smbPrice(s);
    runDays(s, 90);
    const smb = s.customers.filter((c) => c.kind === 'smb');
    expect(smb.length).toBeGreaterThan(0);
    expect(s.book.smbSignups).toBe(smb.length + s.book.churned);
    for (const c of smb) {
      expect(c.monthlyPrice).toBe(price);
      expect(c.contractValue).toBe(0);
      expect(c.contractEndDay).toBeNull();
      expect(c.id).toMatch(/^c\d+$/);
    }
  });

  it('enterprise visitors become lobby prospects with the deal value fixed on arrival', () => {
    const s = createGame(2);
    addRoom(s, 'marketing');
    addPerson(s, 'marketing', 'star', 5);
    s.features = 10;
    const value = S.enterpriseDealValue(s);
    runDays(s, 40);
    expect(s.prospects.length).toBeGreaterThan(0);
    for (const p of s.prospects) {
      expect(p.value).toBe(value);
      expect(p.expiresDay).toBe(p.arrivedDay + CONFIG.customers.prospectWaitDays);
      expect(p.repId).toBeNull();
      expect(p.progress).toBe(0);
      expect(p.id).toMatch(/^pr\d+$/);
    }
    expect(visuals(s, 'visitor').filter((v) => v.outcome === 'waiting').length).toBeGreaterThanOrEqual(s.prospects.length);
    expect(enterpriseCustomers(s)).toHaveLength(0); // nobody in sales
  });
});

// ---------------------------------------------------------------- enterprise deals

describe('enterprise deals', () => {
  it('books revenue and an open invoice at signing; cash is unchanged until the due day', () => {
    const s = createGame(3);
    s.features = 10;
    addRoom(s, 'sales');
    for (let i = 0; i < 3; i++) addPerson(s, 'sales', 'senior', 5);
    const value = S.enterpriseDealValue(s);
    const terms = S.invoiceTermsDays(s);
    expect(terms).toBe(CONFIG.finance.terms);
    for (let i = 0; i < 30; i++) addProspect(s);
    const cash0 = s.cash;
    const prospects0 = s.prospects.length;

    let first: Invoice | undefined;
    let signedDay = 0;
    for (let day = 1; day <= 400 && s.day < 400; day++) {
      runDays(s, 1);
      if (!first && s.invoices.length > 0) {
        first = s.invoices[0];
        signedDay = s.day;
        expect(s.invoices).toHaveLength(1);
        expect(first.status).toBe('open');
        expect(first.amount).toBe(value);
        expect(first.issuedDay).toBe(s.day);
        expect(first.dueDay).toBe(s.day + terms);
        expect(first.late).toBe(false);
        expect(L.openReceivables(s)).toBe(value);
        expect(s.book.pnl.enterpriseRevenue).toBe(value);
        expect(s.book.dealsSigned).toBe(1);
        expect(s.book.invoicesIssued).toBe(1);
        expect(s.cash).toBe(cash0); // profit now, cash later
        expect(s.book.pnl.commission).toBe(0); // seniors take no commission
        expect(s.financeUnlocked).toBe(true);
        expect(s.prospects.length).toBeLessThan(prospects0);

        const ent = s.customers.find((c) => c.id === first!.customerId);
        expect(ent).toBeDefined();
        expect(ent!.kind).toBe('enterprise');
        expect(ent!.contractValue).toBe(value);
        expect(ent!.monthlyPrice).toBeCloseTo(value / MONTHS);
        expect(ent!.contractEndDay).toBe(s.day + MONTHS * D);
        expect(ent!.servedShare).toBe(1);

        expect(visuals(s, 'invoice').some((v) => v.amount === value && v.dueDay === first!.dueDay && v.day === s.day)).toBe(true);
        expect(visuals(s, 'visitor').some((v) => v.outcome === 'enterprise')).toBe(true);
        expect(s.log.some((l) => l.day === s.day && /deal signed/i.test(l.text) && l.tone === 'good')).toBe(true);
        // no more deals: the reps leave and the lobby empties, so only this invoice can move cash
        s.people = s.people.filter((p) => p.role !== 'sales');
        s.prospects.length = 0;
      } else if (first) {
        if (s.day < first.dueDay) {
          expect(s.cash).toBe(cash0);
          expect(first.status).toBe('open');
        } else {
          expect(s.day).toBe(first.dueDay);
          expect(first.status).toBe('paid');
          expect(first.settledDay).toBe(first.dueDay);
          expect(s.cash).toBe(cash0 + value);
          expect(s.book.cf.collections).toBe(value);
          expect(L.openReceivables(s)).toBe(0);
          expect(visuals(s, 'coins').some((v) => v.source === 'collection' && v.amount === value && v.day === s.day)).toBe(true);
          expect(s.log.some((l) => l.day === s.day && /invoice paid/i.test(l.text))).toBe(true);
          break;
        }
      }
    }
    expect(signedDay).toBeGreaterThan(0);
    expect(first!.status).toBe('paid');
  });

  it('a star rep takes 10% commission in cash at signing', () => {
    const s = createGame(4);
    s.features = 10;
    addRoom(s, 'sales');
    const star = addPerson(s, 'sales', 'star', 5);
    const value = S.enterpriseDealValue(s);
    const commission = value * CONFIG.people.starCommission;
    for (let i = 0; i < 30; i++) addProspect(s);
    const cash0 = s.cash;

    let signed = false;
    for (let day = 1; day <= 700 && !signed; day++) {
      runDays(s, 1);
      if (s.book.dealsSigned > 0) {
        signed = true;
        expect(s.book.dealsSigned).toBe(1);
        expect(s.cash).toBeCloseTo(cash0 - commission, 6);
        expect(s.book.pnl.commission).toBeCloseTo(commission, 6);
        expect(s.book.cf.commission).toBeCloseTo(commission, 6);
        expect(s.invoices[0].amount).toBe(value);
        expect(s.log.some((l) => l.day === s.day && /commission/i.test(l.text))).toBe(true);
      }
      // the star is the only rep: every worked prospect is theirs
      for (const p of s.prospects) if (p.progress > 0) expect(p.repId).toBe(star.id);
    }
    expect(signed).toBe(true);
  });

  it('the founder selling as a mid pays no commission', () => {
    const s = createGame(5);
    s.features = 10;
    s.founderRole = 'sales';
    const founder = s.people.find((p) => p.founder)!;
    expect(S.peopleIn(s, 'sales').map((p) => p.id)).toEqual([founder.id]);
    for (let i = 0; i < 30; i++) addProspect(s);
    const cash0 = s.cash;
    let signed = false;
    for (let day = 1; day <= 900 && !signed; day++) {
      runDays(s, 1);
      if (s.book.dealsSigned > 0) {
        signed = true;
        expect(s.cash).toBe(cash0);
        expect(s.book.pnl.commission).toBe(0);
      }
    }
    expect(signed).toBe(true);
  });

  it('sales capacity flows FIFO and the prospect is handed to the rep with the highest output', () => {
    const s = createGame(6);
    s.features = 10;
    addRoom(s, 'sales');
    addPerson(s, 'sales', 'junior', 1);
    const senior = addPerson(s, 'sales', 'senior', 5);
    const perDay = S.salesCapacityPerMonth(s) / D;
    expect(perDay).toBeGreaterThan(0);
    const a = addProspect(s);
    const b = addProspect(s);
    a.progress = 1 - perDay / 4; // a quarter of today's capacity finishes it

    runDays(s, 1);
    expect(s.prospects.find((p) => p.id === a.id)).toBeUndefined();
    const bAfter = s.prospects.find((p) => p.id === b.id)!;
    expect(bAfter.progress).toBeCloseTo((perDay * 3) / 4, 10);
    expect(bAfter.repId).toBe(senior.id);
    const closed = enterpriseCustomers(s).length === 1;
    const walked = s.log.some((l) => /walked/.test(l.text));
    expect(closed || walked).toBe(true);
    expect(closed && walked).toBe(false);
  });
});

// ---------------------------------------------------------------- churn & tickets

describe('SMB churn', () => {
  function churnOver30Days(seed: number, servedShare: number): { lost: number; maxVisualsPerDay: number } {
    const s = createGame(seed);
    customers.addCustomersDebug(s, 1000);
    s.ticketsServedShare = servedShare;
    s.visuals.length = 0;
    let maxVisualsPerDay = 0;
    runDays(s, D, () => {
      maxVisualsPerDay = Math.max(maxVisualsPerDay, visuals(s, 'churn').length);
      s.visuals.length = 0;
    });
    expect(s.book.churned).toBe(1000 - s.customers.length);
    return { lost: 1000 - s.customers.length, maxVisualsPerDay };
  }

  it('is near zero when tickets are served and rises when they are not; visuals capped at 3 a day', () => {
    expect(S.monthlySmbChurn(createGame(7), 1)).toBeCloseTo(CONFIG.customers.churnBase);
    expect(S.monthlySmbChurn(createGame(7), 0)).toBeCloseTo(CONFIG.customers.churnBase + CONFIG.customers.churnUnserved);
    const served = churnOver30Days(7, 1); // mean 20 of 1000
    const unserved = churnOver30Days(7, 0); // mean 80 of 1000
    expect(served.lost).toBeLessThan(40);
    expect(unserved.lost).toBeGreaterThan(50);
    expect(unserved.lost).toBeGreaterThan(served.lost);
    expect(served.maxVisualsPerDay).toBeLessThanOrEqual(3);
    expect(unserved.maxVisualsPerDay).toBeLessThanOrEqual(3);
  });

  it('enterprise customers do not churn daily', () => {
    const s = createGame(8);
    for (let i = 0; i < 50; i++) addEnterprise(s, 10_000, 0);
    s.ticketsServedShare = 0;
    runDays(s, 60);
    expect(enterpriseCustomers(s)).toHaveLength(50);
  });
});

describe('month end', () => {
  it('bills SMB subscriptions: cash and revenue together, one aggregated coin visual', () => {
    const s = createGame(9);
    s.features = 3;
    const price = S.smbPrice(s);
    customers.addCustomersDebug(s, 5);
    expect(s.customers).toHaveLength(5);
    expect(s.customers.every((c) => c.kind === 'smb' && c.monthlyPrice === price)).toBe(true);
    const cash0 = s.cash;
    s.visuals.length = 0;

    s.day = D;
    customers.monthlyCustomers(s);
    expect(s.cash).toBeCloseTo(cash0 + 5 * price, 6);
    expect(s.book.pnl.smbRevenue).toBeCloseTo(5 * price, 6);
    expect(s.book.cf.smbReceipts).toBeCloseTo(5 * price, 6);
    const coins = visuals(s, 'coins');
    expect(coins).toHaveLength(1);
    expect(coins[0].source).toBe('smb');
    expect(coins[0].amount).toBeCloseTo(5 * price, 6);
    expect(s.log.some((l) => /billed 5 subscribers/i.test(l.text))).toBe(true);
  });

  it('sets the tickets-served share on the state and every customer', () => {
    const s = createGame(10);
    customers.addCustomersDebug(s, 5);
    customers.monthlyCustomers(s);
    expect(s.ticketsServedShare).toBe(0); // nobody in support
    expect(s.customers.every((c) => c.servedShare === 0)).toBe(true);
    expect(s.log.some((l) => /support served only 0%/i.test(l.text) && l.tone === 'bad')).toBe(true);

    addRoom(s, 'support');
    addPerson(s, 'support', 'mid', 3);
    expect(S.ticketCapacityPerMonth(s)).toBeGreaterThan(S.ticketsPerMonth(s));
    customers.monthlyCustomers(s);
    expect(s.ticketsServedShare).toBe(1);
    expect(s.customers.every((c) => c.servedShare === 1)).toBe(true);

    // partial coverage: 1000 customers = 300 tickets a month against one agent
    customers.addCustomersDebug(s, 995);
    customers.monthlyCustomers(s);
    const expected = S.ticketCapacityPerMonth(s) / S.ticketsPerMonth(s);
    expect(expected).toBeLessThan(1);
    expect(s.ticketsServedShare).toBeCloseTo(expected);
    expect(s.customers.every((c) => Math.abs(c.servedShare - expected) < 1e-9)).toBe(true);

    const empty = createGame(10);
    customers.monthlyCustomers(empty);
    expect(empty.ticketsServedShare).toBe(1);
    expect(empty.cash).toBe(CONFIG.start.cash);
  });

  it('bills through the real close on day 30 and the books reconcile', () => {
    const s = createGame(11);
    s.features = 2;
    const price = S.smbPrice(s);
    customers.addCustomersDebug(s, 3);
    advanceTo(s, D);
    expect(s.history).toHaveLength(1);
    const month = s.history[0];
    expect(L.checkIdentities(month)).toEqual([]);
    expect(month.pnl.smbRevenue).toBeCloseTo(s.customers.filter((c) => c.kind === 'smb').length * price, 6);
    expect(month.cf.smbReceipts).toBe(month.pnl.smbRevenue);
    expect(s.cash).toBeCloseTo(CONFIG.start.cash + month.pnl.smbRevenue, 6);
  });
});

// ---------------------------------------------------------------- renewals & expiry

describe('enterprise contract end', () => {
  it('renews served customers at today\'s value with a new invoice; unserved and noRenew customers leave', () => {
    const s = createGame(12);
    s.features = 2;
    const oldValue = S.enterpriseDealValue(s);
    const endDay = 100;
    const renewing = addEnterprise(s, endDay, 1);
    const unserved = addEnterprise(s, endDay, CONFIG.customers.renewServedMin - 0.1);
    const pressed = addEnterprise(s, endDay, 1, true);
    const borderline = addEnterprise(s, endDay, CONFIG.customers.renewServedMin);
    s.features = 5;
    const newValue = S.enterpriseDealValue(s);
    expect(newValue).not.toBe(oldValue);
    const terms = S.invoiceTermsDays(s);
    const cash0 = s.cash;

    s.day = endDay - 1;
    customers.dailyCustomers(s);
    expect(enterpriseCustomers(s)).toHaveLength(4);
    expect(s.invoices).toHaveLength(0);

    s.visuals.length = 0;
    s.day = endDay;
    customers.dailyCustomers(s);

    const left = enterpriseCustomers(s).map((c) => c.id).sort();
    expect(left).toEqual([renewing.id, borderline.id].sort());
    expect(renewing.contractValue).toBe(newValue);
    expect(renewing.monthlyPrice).toBeCloseTo(newValue / MONTHS);
    expect(renewing.contractEndDay).toBe(endDay + MONTHS * D);
    expect(borderline.contractEndDay).toBe(endDay + MONTHS * D);

    expect(s.invoices).toHaveLength(2);
    for (const inv of s.invoices) {
      expect([renewing.id, borderline.id]).toContain(inv.customerId);
      expect(inv.amount).toBe(newValue);
      expect(inv.status).toBe('open');
      expect(inv.dueDay).toBe(endDay + terms);
    }
    expect(s.book.pnl.enterpriseRevenue).toBe(2 * newValue);
    expect(s.book.dealsSigned).toBe(2);
    expect(s.cash).toBe(cash0); // no commission on renewals, no cash at signing
    expect(s.book.pnl.commission).toBe(0);
    expect(visuals(s, 'invoice')).toHaveLength(2);
    expect(s.log.filter((l) => l.day === endDay && /renewed/i.test(l.text))).toHaveLength(2);

    expect(s.customers.find((c) => c.id === unserved.id)).toBeUndefined();
    expect(s.customers.find((c) => c.id === pressed.id)).toBeUndefined();
    expect(s.book.churned).toBeGreaterThanOrEqual(2);
    expect(visuals(s, 'churn').filter((v) => v.kind === 'enterprise')).toHaveLength(2);
    expect(s.log.filter((l) => l.day === endDay && /left at contract end/i.test(l.text) && l.tone === 'bad')).toHaveLength(2);
    expect(s.log.some((l) => /would not renew/i.test(l.text))).toBe(true);
    expect(s.log.some((l) => /served only 40%/i.test(l.text))).toBe(true);
  });
});

describe('prospects', () => {
  it('give up after 45 days without a rep', () => {
    const s = createGame(13);
    s.features = 10;
    s.day = 10;
    const p = addProspect(s, CONFIG.customers.prospectWaitDays);
    expect(p.expiresDay).toBe(55);
    while (s.day < p.expiresDay - 1) {
      runDays(s, 1);
      expect(s.prospects.some((q) => q.id === p.id)).toBe(true);
    }
    s.visuals.length = 0;
    runDays(s, 1);
    expect(s.day).toBe(p.expiresDay);
    expect(s.prospects.some((q) => q.id === p.id)).toBe(false);
    expect(visuals(s, 'visitor').some((v) => v.outcome === 'left')).toBe(true);
    expect(s.log.some((l) => l.day === p.expiresDay && /gave up waiting/i.test(l.text))).toBe(true);
    expect(enterpriseCustomers(s)).toHaveLength(0);
    expect(s.invoices).toHaveLength(0);
  });

  it('a prospect a rep has picked up is worked past day 45 and never "gives up waiting"', () => {
    // DESIGN.md 8: the 45 days are a limit on waiting for a rep, not on the pitch
    const s = createGame(16);
    s.features = 10;
    s.founderRole = 'sales';
    const founder = s.people.find((p) => p.founder)!;
    const a = addProspect(s, CONFIG.customers.prospectWaitDays);
    const b = addProspect(s, CONFIG.customers.prospectWaitDays);
    const perDay = S.salesCapacityPerMonth(s) / D;
    // the founder alone finishes a first prospect inside 45 days but not a second: b is mid-pitch on its expiry day
    expect(perDay * CONFIG.customers.prospectWaitDays).toBeGreaterThan(1);
    expect(perDay * CONFIG.customers.prospectWaitDays).toBeLessThan(2);
    const underTest = new Set([a.id, b.id]);
    const present = (id: string): boolean => s.prospects.some((p) => p.id === id);

    let checkedOnExpiryDay = false;
    for (let i = 0; i < 200 && (present(a.id) || present(b.id)); i++) {
      runDays(s, 1, () => {
        // keep the lobby to the two prospects under test: the base trickle of visitors may add others
        s.prospects = s.prospects.filter((p) => underTest.has(p.id));
      });
      if (s.day === b.expiresDay) {
        checkedOnExpiryDay = true;
        expect(present(a.id)).toBe(false);
        expect(present(b.id)).toBe(true);
        expect(b.repId).toBe(founder.id);
        expect(b.progress).toBeGreaterThan(0);
        expect(b.progress).toBeLessThan(1);
      }
    }
    expect(checkedOnExpiryDay).toBe(true);
    expect(s.day).toBeGreaterThan(b.expiresDay);
    expect(present(a.id) || present(b.id)).toBe(false);
    const walked = s.log.filter((l) => /walked/i.test(l.text)).length;
    expect(s.book.dealsSigned + walked).toBe(2);
    expect(s.log.some((l) => /gave up waiting/i.test(l.text))).toBe(false);
  });

  it('a prospect whose only rep is fired, with no replacement, still gives up on its expiry day', () => {
    const s = createGame(17);
    s.features = 10;
    addRoom(s, 'sales');
    const rep = addPerson(s, 'sales', 'senior', 5, CONFIG.people.salaries.senior);
    const p = addProspect(s, CONFIG.customers.prospectWaitDays);
    runDays(s, 5);
    expect(p.repId).toBe(rep.id);
    expect(p.progress).toBeGreaterThan(0);
    expect(p.progress).toBeLessThan(1);

    // the real path: staff.fire puts the departed rep's prospects back to waiting
    staff.fire(s, rep.id, 'fired');
    expect(S.peopleIn(s, 'sales')).toHaveLength(0);
    expect(p.repId).toBeNull();

    while (s.day < p.expiresDay - 1) {
      runDays(s, 1);
      expect(s.prospects.some((q) => q.id === p.id)).toBe(true);
    }
    s.visuals.length = 0;
    runDays(s, 1);
    expect(s.day).toBe(p.expiresDay);
    expect(s.prospects.some((q) => q.id === p.id)).toBe(false);
    expect(visuals(s, 'visitor').some((v) => v.outcome === 'left')).toBe(true);
    expect(s.log.some((l) => l.day === p.expiresDay && /gave up waiting/i.test(l.text))).toBe(true);
    expect(s.book.dealsSigned).toBe(0);
    expect(s.log.some((l) => /walked/i.test(l.text))).toBe(false);
  });

  it('a prospect stranded when the founder leaves sales still gives up on its expiry day', () => {
    const s = createGame(18);
    s.features = 10;
    s.founderRole = 'sales';
    const founder = s.people.find((p) => p.founder)!;
    const p = addProspect(s, CONFIG.customers.prospectWaitDays);
    runDays(s, 5);
    expect(p.repId).toBe(founder.id);

    s.founderRole = 'product'; // repId now names someone who is no longer in sales
    expect(S.peopleIn(s, 'sales')).toHaveLength(0);
    runDays(s, p.expiresDay - s.day - 1);
    expect(s.prospects.some((q) => q.id === p.id)).toBe(true);
    runDays(s, 1);
    expect(s.day).toBe(p.expiresDay);
    expect(s.prospects.some((q) => q.id === p.id)).toBe(false);
    expect(s.log.some((l) => l.day === p.expiresDay && /gave up waiting/i.test(l.text))).toBe(true);
    expect(s.book.dealsSigned).toBe(0);
  });
});

// ---------------------------------------------------------------- bulk removal & debug

describe('loseCustomers and debug customers', () => {
  it('removes a rounded share of customers chosen with the rng, at most three churn visuals', () => {
    const s = createGame(14);
    customers.addCustomersDebug(s, 20);
    const before = s.customers.map((c) => c.id);
    s.visuals.length = 0;
    expect(customers.loseCustomers(s, CONFIG.assets.outageChurn, 'outage')).toBe(3);
    expect(s.customers).toHaveLength(17);
    expect(s.book.churned).toBe(3);
    expect(visuals(s, 'churn')).toHaveLength(3);
    const after = new Set(s.customers.map((c) => c.id));
    expect(after.size).toBe(17);
    for (const id of after) expect(before).toContain(id);

    expect(customers.loseCustomers(s, 0, 'nothing')).toBe(0);
    expect(s.customers).toHaveLength(17);

    const big = createGame(14);
    customers.addCustomersDebug(big, 100);
    big.visuals.length = 0;
    expect(customers.loseCustomers(big, 0.15, 'outage')).toBe(15);
    expect(big.customers).toHaveLength(85);
    expect(visuals(big, 'churn')).toHaveLength(3);
    expect(customers.loseCustomers(big, 2, 'everything')).toBe(85);
    expect(big.customers).toHaveLength(0);
  });

  it('addCustomersDebug adds SMB customers at today\'s price', () => {
    const s = createGame(15);
    s.features = 4;
    s.tier = 2;
    const price = S.smbPrice(s);
    customers.addCustomersDebug(s, 10);
    expect(s.customers).toHaveLength(10);
    for (const c of s.customers) {
      expect(c.kind).toBe('smb');
      expect(c.monthlyPrice).toBe(price);
    }
    expect(new Set(s.customers.map((c) => c.id)).size).toBe(10);
  });
});

// ---------------------------------------------------------------- product

describe('product', () => {
  it('ships a feature when points reach 4 + features, with visual and log', () => {
    const s = createGame(16); // the founder alone: 2.55 output a month
    const perDay = S.roleOutput(s, 'product') / D;
    expect(perDay).toBeCloseTo(0.085);
    expect(S.featureCost(s)).toBe(CONFIG.product.featureBaseCost);

    s.featurePoints = S.featureCost(s) - perDay / 2;
    s.day = 1;
    product.dailyProduct(s);
    expect(s.features).toBe(1);
    expect(s.featurePoints).toBeCloseTo(perDay / 2);
    expect(visuals(s, 'feature')).toEqual([{ t: 'feature', day: 1, features: 1 }]);
    expect(s.log.some((l) => /Feature 1 shipped/.test(l.text) && l.tone === 'good')).toBe(true);

    expect(S.featureCost(s)).toBe(CONFIG.product.featureBaseCost + CONFIG.product.featureCostPerFeature);
    s.featurePoints = S.featureCost(s) - perDay * 1.5;
    product.dailyProduct(s);
    expect(s.features).toBe(1);
    product.dailyProduct(s);
    expect(s.features).toBe(2);
    expect(s.log.some((l) => /Feature 2 shipped/.test(l.text))).toBe(true);
  });

  it('ships several features in one day when the backlog allows, each at its own cost', () => {
    const s = createGame(17);
    const c0 = S.featureCost(s);
    s.featurePoints = c0 + (c0 + 1) + (c0 + 2) + 2; // three features fit, the fourth does not
    product.dailyProduct(s);
    expect(s.features).toBe(3);
    expect(s.featurePoints).toBeCloseTo(2 + S.roleOutput(s, 'product') / D);
    expect(visuals(s, 'feature').map((v) => v.features)).toEqual([1, 2, 3]);
  });

  it('the founder alone ships features on the schedule the config implies (first by day 45)', () => {
    const s = createGame(18);
    const shipDays: number[] = [];
    for (let day = 1; day <= 200; day++) {
      s.day = day;
      const before = s.features;
      product.dailyProduct(s);
      if (s.features > before) shipDays.push(day);
    }
    // replay the rule: points per day from the founder's output, costs rising by one per feature
    const perDay = S.roleOutput(createGame(18), 'product') / D;
    const expected: number[] = [];
    let pts = 0;
    let cost = CONFIG.product.featureBaseCost;
    for (let day = 1; day <= 200; day++) {
      pts += perDay;
      while (pts >= cost) {
        pts -= cost;
        cost += CONFIG.product.featureCostPerFeature;
        expected.push(day);
      }
    }
    expect(shipDays).toEqual(expected);
    expect(shipDays[0]).toBeLessThanOrEqual(45); // DESIGN.md 16 pacing
    expect(s.tier).toBe(1);
    expect(s.researchPoints).toBe(0); // nobody in R&D
  });

  it('reaches R&D tiers at 60 and 150 cumulative research points', () => {
    const s = createGame(19);
    addRoom(s, 'rnd');
    addPerson(s, 'rnd', 'senior', 5);
    const perDay = S.roleOutput(s, 'rnd') / D;
    expect(perDay).toBeGreaterThan(0);

    s.researchPoints = CONFIG.rnd.tier2Points - perDay / 2;
    s.day = 5;
    product.dailyProduct(s);
    expect(s.tier).toBe(2);
    expect(S.tierMult(s)).toBe(CONFIG.rnd.tierMult[2]);
    expect(visuals(s, 'tier')).toEqual([{ t: 'tier', day: 5, tier: 2 }]);
    expect(s.log.some((l) => /tier 2/i.test(l.text))).toBe(true);

    product.dailyProduct(s);
    expect(s.tier).toBe(2); // points keep accumulating, no tier yet
    s.researchPoints = CONFIG.rnd.tier3Points - perDay / 2;
    product.dailyProduct(s);
    expect(s.tier).toBe(3);
    expect(S.tierMult(s)).toBe(CONFIG.rnd.tierMult[3]);

    s.researchPoints = 10_000;
    product.dailyProduct(s);
    expect(s.tier).toBe(3); // no tier 4
    expect(visuals(s, 'tier')).toHaveLength(2);
  });

  it('shipping features clears the competitor penalty at the target count', () => {
    const s = createGame(20);
    s.features = 3;
    s.effects.competitorUntilFeatures = 5;
    expect(S.competitorActive(s)).toBe(true);
    const conv = S.smbConversion(s);

    product.shipFeature(s);
    expect(s.features).toBe(4);
    expect(s.effects.competitorUntilFeatures).toBe(5);
    expect(S.competitorActive(s)).toBe(true);

    product.shipFeature(s);
    expect(s.features).toBe(5);
    expect(s.effects.competitorUntilFeatures).toBeNull();
    expect(S.competitorActive(s)).toBe(false);
    expect(S.smbConversion(s)).toBeGreaterThan(conv);
    expect(s.log.some((l) => /competitor/i.test(l.text) && /backed off/i.test(l.text))).toBe(true);
  });
});

// ---------------------------------------------------------------- whole-game runs

describe('through the clock', () => {
  /** Seat a person at a desk with a laptop so staff.ts does not dock their morale or output. */
  function seat(s: GameState, p: Person, room: Room): void {
    const desk = CONFIG.assets.catalogue.desk;
    const laptop = CONFIG.assets.catalogue.laptop;
    s.assets.push({ id: `a${s.nextId++}`, kind: 'desk', cost: desk.price, bookValue: desk.price, lifeMonths: desk.lifeMonths, boughtDay: s.day, roomId: room.id });
    s.assets.push({ id: `a${s.nextId++}`, kind: 'laptop', cost: laptop.price, bookValue: laptop.price, lifeMonths: laptop.lifeMonths, boughtDay: s.day, roomId: null });
    p.roomId = room.id;
    p.hasLaptop = true;
  }

  function fullTeam(seed: number): GameState {
    const s = createGame(seed);
    L.recordEquity(s, 3_000_000); // financing keeps the identities while salaries run
    // no investor or event cards: they would stop the clock (those modules have their own tests)
    s.schedule.nextKnockDay = 1_000_000;
    s.schedule.nextEventDay = 1_000_000;
    const pay = CONFIG.people.salaries;
    const hire = (role: Role, archetype: Archetype, skill: number, room: Room): void => seat(s, addPerson(s, role, archetype, skill, pay[archetype]), room);
    const marketing = addRoom(s, 'marketing');
    hire('marketing', 'senior', 4, marketing);
    const sales = addRoom(s, 'sales');
    hire('sales', 'senior', 4.5, sales);
    hire('sales', 'star', 5, sales);
    const support = addRoom(s, 'support');
    hire('support', 'mid', 3, support);
    hire('support', 'mid', 3, support);
    const engineering = addRoom(s, 'product');
    hire('product', 'mid', 3, engineering);
    hire('product', 'mid', 3, engineering);
    const finance = addRoom(s, 'finance');
    hire('finance', 'mid', 3, finance);
    const rnd = addRoom(s, 'rnd');
    hire('rnd', 'senior', 5, rnd);
    hire('rnd', 'senior', 5, rnd);
    return s;
  }

  it('24 months with a full team: every close reconciles, deals sign, invoices collect, SMB bills', () => {
    const s = fullTeam(2024);
    advanceTo(s, 24 * D);
    expect(s.status).toBe('playing');
    expect(s.day).toBe(24 * D);
    expect(s.history).toHaveLength(24);
    for (const b of s.history) expect(L.checkIdentities(b)).toEqual([]);

    const sum = (f: (b: (typeof s.history)[number]) => number): number => s.history.reduce((a, b) => a + f(b), 0);
    expect(sum((b) => b.dealsSigned)).toBeGreaterThan(0);
    expect(sum((b) => b.pnl.enterpriseRevenue)).toBeGreaterThan(0);
    expect(sum((b) => b.cf.collections)).toBeGreaterThan(0);
    expect(sum((b) => b.pnl.smbRevenue)).toBeGreaterThan(0);
    expect(sum((b) => b.pnl.commission)).toBeGreaterThan(0); // the star closed something
    expect(sum((b) => b.visitors)).toBeGreaterThan(100);
    expect(s.features).toBeGreaterThan(3);
    expect(s.tier).toBeGreaterThan(1);
    expect(s.customers.length).toBeGreaterThan(0);
    expect(s.financeUnlocked).toBe(true);

    // finance staff shorten terms to whole days; every paid invoice settled on its due day
    expect(s.invoices.length).toBeGreaterThan(0);
    for (const inv of s.invoices) {
      expect(Number.isInteger(inv.dueDay)).toBe(true);
      const terms = inv.dueDay - inv.issuedDay; // whole days, shortened by the finance person's output on the day
      expect(Number.isInteger(terms)).toBe(true);
      expect(terms).toBeGreaterThanOrEqual(CONFIG.finance.termsFloor);
      expect(terms).toBeLessThan(CONFIG.finance.terms);
      if (inv.status === 'paid') expect(inv.settledDay).toBe(inv.dueDay);
      else expect(inv.dueDay).toBeGreaterThan(s.day);
    }
    expect(L.openReceivables(s)).toBe(s.invoices.filter((i) => i.status === 'open').reduce((a, i) => a + i.amount, 0));
    expect(s.ticketsServedShare).toBeGreaterThan(0);
    expect(s.ticketsServedShare).toBeLessThanOrEqual(1);
  });

  it('is deterministic for a seed', () => {
    const a = fullTeam(77);
    const b = fullTeam(77);
    advanceTo(a, 400);
    advanceTo(b, 400);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    const c = fullTeam(78);
    advanceTo(c, 400);
    expect(JSON.stringify(c)).not.toBe(JSON.stringify(a));
  });
});
