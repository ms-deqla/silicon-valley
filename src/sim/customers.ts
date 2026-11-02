/**
 * Visitors, conversion, prospects, deals, invoices, churn, renewals, tickets.
 * DESIGN.md section 8. STUB — to be implemented.
 */
import type { GameState, Invoice } from './types';

/**
 * Daily: Poisson visitors; split SMB/enterprise; SMB convert or leave (visual 'visitor');
 * prospects wait for reps, progress, close (ledger.bookEnterpriseDeal, commission for stars, visual 'invoice');
 * collect invoices due today (ledger.collectInvoice, visual 'coins'); SMB churn hazard; enterprise contract ends
 * (renew → new deal, else leave); prospects expire.
 */
export function dailyCustomers(state: GameState): void {
  void state;
}

/** Month end: bill SMB subscriptions (ledger.billSmb), compute tickets served share → state.ticketsServedShare and per-customer servedShare. */
export function monthlyCustomers(state: GameState): void {
  void state;
}

/** Remove a share of customers (outage). Returns the count removed. Pushes visual 'churn' entries (capped). */
export function loseCustomers(state: GameState, share: number, reason: string): number {
  void state; void share; void reason;
  return 0;
}

export function openEnterpriseInvoices(state: GameState): Invoice[] {
  return state.invoices.filter((i) => i.status === 'open');
}

/** Debug: add n SMB customers at today's price. */
export function addCustomersDebug(state: GameState, n: number): void {
  void state; void n;
}
