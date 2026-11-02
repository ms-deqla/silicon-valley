/**
 * The books. Every dollar that moves goes through one of these functions so the
 * month-to-date P&L, cash flow and financing stay reconciled with cash and
 * receivables. DESIGN.md section 9 defines the identities checked at close.
 */
import type { Asset, GameState, Invoice, MonthBook } from './types';
import { CONFIG } from './config';

const EPS = 0.01;

function emptyPnL(): MonthBook['pnl'] {
  return {
    smbRevenue: 0, enterpriseRevenue: 0, salaries: 0, rent: 0, marketing: 0, interest: 0,
    depreciation: 0, severance: 0, badDebt: 0, commission: 0, disposalLoss: 0, eventCosts: 0,
  };
}

function emptyCashFlow(): MonthBook['cf'] {
  return {
    smbReceipts: 0, collections: 0, disposalProceeds: 0, salaries: 0, rent: 0, marketing: 0,
    interest: 0, severance: 0, commission: 0, capex: 0, eventCosts: 0,
  };
}

// ---------------------------------------------------------------- balances

/** Face value of all open invoices. */
export function openReceivables(state: GameState): number {
  let ar = 0;
  for (const inv of state.invoices) if (inv.status === 'open') ar += inv.amount;
  return ar;
}

export function assetsAtBook(state: GameState): number {
  let b = 0;
  for (const a of state.assets) b += a.bookValue;
  return b;
}

export function debtOf(state: GameState): number {
  return state.loan ? state.loan.principal : 0;
}

// ---------------------------------------------------------------- books

export function newBook(state: GameState, month: number, startDay: number): MonthBook {
  return {
    month,
    startDay,
    pnl: emptyPnL(),
    cf: emptyCashFlow(),
    fin: { equityIn: 0, loanIn: 0, loanRepaid: 0 },
    cashStart: state.cash,
    arStart: openReceivables(state),
    assetsBookStart: assetsAtBook(state),
    debtStart: debtOf(state),
    visitors: 0,
    smbSignups: 0,
    dealsSigned: 0,
    churned: 0,
    invoicesIssued: 0,
    closed: false,
    cashEnd: 0,
    arEnd: 0,
    assetsBookEnd: 0,
    debtEnd: 0,
    profit: 0,
    fcf: 0,
    deltaCash: 0,
    customersEnd: 0,
    featuresEnd: 0,
    valueEnd: 0,
    requiredReturnEnd: 0,
  };
}

export function revenueOf(book: MonthBook): number {
  return book.pnl.smbRevenue + book.pnl.enterpriseRevenue;
}

export function costsOf(book: MonthBook): number {
  const p = book.pnl;
  return p.salaries + p.rent + p.marketing + p.interest + p.depreciation + p.severance + p.badDebt
    + p.commission + p.disposalLoss + p.eventCosts;
}

/** Accrual profit, month to date. */
export function profitOf(book: MonthBook): number {
  return revenueOf(book) - costsOf(book);
}

export function cashInOf(book: MonthBook): number {
  const c = book.cf;
  return c.smbReceipts + c.collections + c.disposalProceeds;
}

export function cashOutOf(book: MonthBook): number {
  const c = book.cf;
  return c.salaries + c.rent + c.marketing + c.interest + c.severance + c.commission + c.capex + c.eventCosts;
}

/** Free cash flow, month to date. Excludes financing. */
export function fcfOf(book: MonthBook): number {
  return cashInOf(book) - cashOutOf(book);
}

export function financingOf(book: MonthBook): number {
  return book.fin.equityIn + book.fin.loanIn - book.fin.loanRepaid;
}

/** The indirect cash bridge from profit to FCF, as shown in the Books panel. */
export interface Bridge {
  profit: number;
  depreciation: number;
  disposalLoss: number;
  capex: number;
  disposalProceeds: number;
  /** AR(end) − AR(start); for an open month, current AR − AR(start) */
  deltaReceivables: number;
  fcf: number;
  financing: number;
  deltaCash: number;
}

export function bridgeOf(book: MonthBook, currentAr?: number, currentCash?: number): Bridge {
  const arEnd = book.closed ? book.arEnd : (currentAr ?? book.arStart);
  const cashEnd = book.closed ? book.cashEnd : (currentCash ?? book.cashStart);
  const profit = profitOf(book);
  const fcf = fcfOf(book);
  return {
    profit,
    depreciation: book.pnl.depreciation,
    disposalLoss: book.pnl.disposalLoss,
    capex: book.cf.capex,
    disposalProceeds: book.cf.disposalProceeds,
    deltaReceivables: arEnd - book.arStart,
    fcf,
    financing: financingOf(book),
    deltaCash: cashEnd - book.cashStart,
  };
}

/**
 * Returns the list of violated identities (empty when the books reconcile).
 *   ΔCash = FCF + equityIn + loanIn − loanRepaid
 *   FCF   = Profit + depreciation + disposalLoss − capex + disposalProceeds − ΔReceivables
 */
export function checkIdentities(book: MonthBook): string[] {
  const out: string[] = [];
  if (!book.closed) return ['book not closed'];
  const b = bridgeOf(book);
  const cashIdentity = b.fcf + b.financing;
  if (Math.abs(b.deltaCash - cashIdentity) > EPS) {
    out.push(`ΔCash ${b.deltaCash.toFixed(2)} ≠ FCF + financing ${cashIdentity.toFixed(2)}`);
  }
  const fcfIdentity = b.profit + b.depreciation + b.disposalLoss - b.capex + b.disposalProceeds - b.deltaReceivables;
  if (Math.abs(b.fcf - fcfIdentity) > EPS) {
    out.push(`FCF ${b.fcf.toFixed(2)} ≠ bridge ${fcfIdentity.toFixed(2)}`);
  }
  if (Math.abs(book.deltaCash - (book.cashEnd - book.cashStart)) > EPS) out.push('deltaCash field inconsistent');
  if (Math.abs(book.profit - b.profit) > EPS) out.push('profit field inconsistent');
  if (Math.abs(book.fcf - b.fcf) > EPS) out.push('fcf field inconsistent');
  return out;
}

/** Fill the end-of-month snapshot. Called by closeMonth after all monthly entries are booked. */
export function closeBook(state: GameState): MonthBook {
  const book = state.book;
  book.closed = true;
  book.cashEnd = state.cash;
  book.arEnd = openReceivables(state);
  book.assetsBookEnd = assetsAtBook(state);
  book.debtEnd = debtOf(state);
  book.profit = profitOf(book);
  book.fcf = fcfOf(book);
  book.deltaCash = book.cashEnd - book.cashStart;
  book.customersEnd = state.customers.length;
  book.featuresEnd = state.features;
  return book;
}

// ---------------------------------------------------------------- operating entries (both bars)

export function accrueSalary(state: GameState, amount: number): void {
  if (amount <= 0) return;
  state.book.pnl.salaries += amount;
  state.book.cf.salaries += amount;
  state.cash -= amount;
}

export function accrueRent(state: GameState, amount: number): void {
  if (amount <= 0) return;
  state.book.pnl.rent += amount;
  state.book.cf.rent += amount;
  state.cash -= amount;
}

export function accrueMarketing(state: GameState, amount: number): void {
  if (amount <= 0) return;
  state.book.pnl.marketing += amount;
  state.book.cf.marketing += amount;
  state.cash -= amount;
}

export function accrueInterest(state: GameState, amount: number): void {
  if (amount <= 0) return;
  state.book.pnl.interest += amount;
  state.book.cf.interest += amount;
  state.cash -= amount;
}

export function paySeverance(state: GameState, amount: number): void {
  if (amount <= 0) return;
  state.book.pnl.severance += amount;
  state.book.cf.severance += amount;
  state.cash -= amount;
}

export function payCommission(state: GameState, amount: number): void {
  if (amount <= 0) return;
  state.book.pnl.commission += amount;
  state.book.cf.commission += amount;
  state.cash -= amount;
}

export function payEventCost(state: GameState, amount: number): void {
  if (amount <= 0) return;
  state.book.pnl.eventCosts += amount;
  state.book.cf.eventCosts += amount;
  state.cash -= amount;
}

/** SMB subscriptions: revenue and cash in the same moment. */
export function billSmb(state: GameState, amount: number): void {
  if (amount <= 0) return;
  state.book.pnl.smbRevenue += amount;
  state.book.cf.smbReceipts += amount;
  state.cash += amount;
}

// ---------------------------------------------------------------- receivables (profit now, cash later)

/** Book an enterprise contract as revenue and issue the invoice. Returns the invoice. */
export function bookEnterpriseDeal(state: GameState, customerId: string, amount: number, termsDays: number): Invoice {
  state.book.pnl.enterpriseRevenue += amount;
  state.book.dealsSigned += 1;
  state.book.invoicesIssued += 1;
  const inv: Invoice = {
    id: `inv${state.nextId++}`,
    customerId,
    amount,
    issuedDay: state.day,
    dueDay: state.day + termsDays,
    status: 'open',
    settledDay: null,
    late: false,
  };
  state.invoices.push(inv);
  if (!state.financeUnlocked) {
    state.financeUnlocked = true;
    state.log.push({ day: state.day, text: 'Finance department unlocked: you now have invoices to chase.', tone: 'info' });
  }
  return inv;
}

export function collectInvoice(state: GameState, inv: Invoice): void {
  if (inv.status !== 'open') return;
  inv.status = 'paid';
  inv.settledDay = state.day;
  state.book.cf.collections += inv.amount;
  state.cash += inv.amount;
}

export function writeOffInvoice(state: GameState, inv: Invoice): void {
  if (inv.status !== 'open') return;
  inv.status = 'writtenOff';
  inv.settledDay = state.day;
  state.book.pnl.badDebt += inv.amount;
}

// ---------------------------------------------------------------- assets (cash now, profit later)

export function recordCapex(state: GameState, amount: number): void {
  if (amount <= 0) return;
  state.book.cf.capex += amount;
  state.cash -= amount;
}

/** Proceeds at resale; the loss against book hits the P&L. Caller removes the asset. Returns proceeds. */
export function recordDisposal(state: GameState, asset: Asset): number {
  const proceeds = Math.round(asset.bookValue * CONFIG.assets.resaleOfBook * 100) / 100;
  const loss = asset.bookValue - proceeds;
  state.book.cf.disposalProceeds += proceeds;
  state.book.pnl.disposalLoss += loss;
  state.cash += proceeds;
  return proceeds;
}

export function recordDepreciation(state: GameState, amount: number): void {
  if (amount <= 0) return;
  state.book.pnl.depreciation += amount;
}

// ---------------------------------------------------------------- financing (cash only)

export function recordEquity(state: GameState, amount: number): void {
  state.book.fin.equityIn += amount;
  state.cash += amount;
}

export function recordLoanIn(state: GameState, amount: number): void {
  state.book.fin.loanIn += amount;
  state.cash += amount;
}

export function recordLoanRepaid(state: GameState, amount: number): void {
  state.book.fin.loanRepaid += amount;
  state.cash -= amount;
}
