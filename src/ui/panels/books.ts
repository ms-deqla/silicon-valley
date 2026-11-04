/**
 * The Books: this month's P&L, the cash bridge, the invoice tray, a mini balance
 * sheet with the score the buzzer would take now, the cap table (you, each fund with
 * its percentage, DESIGN.md 0 v2), "investors want r%" with its premia, and a 12-month
 * history table. DESIGN.md sections 0, 9, 10 and 13. Opened by tapping any HUD pill.
 * Lines for mechanics the tournament switches off (loans, the ad budget, R&D) are not
 * drawn.
 */
import { CONFIG, ledger, selectors } from '../../sim';
import type { GameState, MonthBook } from '../../sim';
import type { ShellController } from '../controller';
import { capTable, customerName, dueText, money, months, percent, signedMoney } from '../format';
import { h, kv, note, section } from './dom';
import type { SheetSpec } from './sheet';

function line(label: string, amount: number, opts: { always?: boolean; cls?: string } = {}): HTMLElement | null {
  if (!opts.always && Math.abs(amount) < 0.5) return null;
  const el = kv(label, signedMoney(amount), opts.cls ?? '');
  el.classList.toggle('neg', amount < -0.5);
  el.classList.toggle('pos', amount > 0.5);
  return el;
}

function pnlSection(book: MonthBook): HTMLElement {
  const p = book.pnl;
  return section('This month · P&L',
    line('SMB subscriptions', p.smbRevenue, { always: true }),
    line('Enterprise contracts signed', p.enterpriseRevenue, { always: true }),
    line('Salaries', -p.salaries, { always: true }),
    line('Rent', -p.rent, { always: true }),
    line('Depreciation', -p.depreciation),
    line('Severance', -p.severance),
    line('Bad debt', -p.badDebt),
    line('Commission', -p.commission),
    line('Disposal loss', -p.disposalLoss),
    line('Event costs', -p.eventCosts),
    line('Profit', ledger.profitOf(book), { always: true, cls: 'total' }));
}

function bridgeSection(state: GameState): HTMLElement {
  const b = ledger.bridgeOf(state.book, ledger.openReceivables(state), state.cash);
  const step = (sign: string, label: string, amount: number, cls = ''): HTMLElement => {
    const el = h('div', { class: `bridge-step ${cls}`.trim() },
      h('span', { class: 'bridge-sign', text: sign }),
      h('span', { class: 'bridge-label', text: label }),
      h('span', { class: 'bridge-amount', text: signedMoney(amount) }));
    el.classList.toggle('neg', amount < -0.5);
    el.classList.toggle('pos', amount > 0.5);
    return el;
  };
  return section('Cash bridge',
    note('Why profit and cash disagree this month: start from profit, add back what never left the bank, take off what left the bank without touching profit.', 'muted'),
    step('', 'Profit', b.profit, 'first'),
    step('+', 'Depreciation (no cash left)', b.depreciation),
    step('+', 'Disposal loss (no cash left)', b.disposalLoss),
    step('−', 'Capex (cash left, not in profit)', -b.capex),
    step('+', 'Disposal proceeds', b.disposalProceeds),
    step('−', 'Δ receivables (revenue not yet paid)', -b.deltaReceivables),
    step('=', 'Free cash flow', b.fcf, 'total'),
    step('+', 'Financing (investors)', b.financing),
    step('=', 'Δ cash', b.deltaCash, 'total'));
}

function invoiceSection(state: GameState): HTMLElement {
  const open = state.invoices.filter((i) => i.status === 'open').sort((a, b) => a.dueDay - b.dueDay);
  const sec = section(`Invoice tray · ${open.length} open · ${money(ledger.openReceivables(state))}`);
  if (open.length === 0) sec.appendChild(note('No open invoices. Enterprise deals book revenue now and pay on the due day.', 'muted'));
  for (const inv of open) {
    const late = inv.dueDay < state.day;
    sec.appendChild(h('div', { class: `invoice${late ? ' late' : ''}${inv.late ? ' pushed' : ''}` },
      h('span', { class: 'inv-customer', text: customerName(inv.customerId) }),
      h('span', { class: 'inv-amount', text: money(inv.amount) }),
      h('span', { class: 'inv-due', text: `${dueText(inv.dueDay, state.day)}${inv.late ? ' · pushed back' : ''}` })));
  }
  return sec;
}

/** DESIGN.md 0: score = company value × the founder's remaining share, taken at the buzzer. */
function balanceSection(state: GameState): HTMLElement {
  const value = Math.max(0, state.valuation.value);
  return section('Balance sheet (mini)',
    kv('Cash', money(state.cash)),
    kv('Receivables (open invoices)', money(ledger.openReceivables(state))),
    kv('Assets at book', money(ledger.assetsAtBook(state))),
    kv('Company value', money(state.valuation.value), 'total'),
    kv('Your share', percent(state.founderShare, 1)),
    kv('Score if the buzzer went now', money(value * state.founderShare), 'big total'));
}

/**
 * DESIGN.md 0 (v2): the cap table — you, then each fund with the share it holds today
 * (what it bought, diluted by every round after it), the round's day, the cash it put in
 * and the price it paid; with the bar the HUD draws.
 */
function capTableSection(state: GameState): HTMLElement {
  const entries = capTable(state);
  const bar = h('div', { class: 'captable books', attrs: { role: 'img', 'aria-label': `Cap table: ${entries.map((e) => `${e.label} ${percent(e.share)}`).join(', ')}` } },
    ...entries.map((e) => h('span', {
      class: `cap-seg ${e.kind}${e.round?.desperate ? ' desperate' : ''}`,
      style: `flex: ${Math.max(e.share, 0.004).toFixed(4)} 1 0px`,
      title: `${e.label} · ${percent(e.share, 1)}`,
    })));
  const rows = entries.map((e) => {
    if (!e.round) return kv('You', percent(e.share, 1), 'you');
    const cal = selectors.calendar(e.round.day);
    const detail = `${e.round.desperate ? 'Lifeline' : 'Round'} ${e.number} · ${cal.monthName} Y${cal.year} · ${money(e.round.amount)} at ${money(e.round.preMoney)} pre`;
    return kv(h('span', { class: 'cap-fund' }, h('b', { text: e.label }), h('small', { class: 'cap-detail', text: detail })), percent(e.share, 1));
  });
  return section('Cap table',
    bar,
    ...rows,
    state.rounds.length === 0
      ? note(`Nobody else owns a slice yet. Investors knock on their own schedule; an offer never asks for more than ${percent(CONFIG.capital.maxShareSold)} in one round.`, 'muted')
      : note('A fund keeps the share it bought, diluted by every round after it, the same as yours.', 'muted'));
}

function valuationSection(state: GameState): HTMLElement {
  const v = state.valuation;
  const pr = v.premia;
  const premium = (label: string, x: number): HTMLElement | null => (x > 0.00005 ? kv(label, `+${percent(x, 1)}`) : null);
  const floorWins = v.floor >= v.operating;
  return section(`Investors want ${percent(v.r, 1)}`,
    note(floorWins
      ? `Value = the floor. The cash-flow forecast comes to ${money(v.dcf)}, less than what the company already holds: cash, ${percent(CONFIG.valuation.arRecovery)} of receivables, ${percent(CONFIG.valuation.assetRecovery)} of assets at book, and a team worth ${money(v.acquihire)} (skill × ${money(CONFIG.valuation.acquihirePerSkill)}). The number moves when forecast cash flows beat that.`
      : 'Value = the cash-flow forecast plus net cash. Riskier choices raise the return investors want and lower the number even when profit is the same.', 'muted'),
    kv('In force', floorWins ? 'Floor' : 'Forecast'),
    kv('Base return', percent(pr.base, 1)),
    premium('Burn premium (runway)', pr.burn),
    premium('Concentration premium', pr.concentration),
    kv('Forecast base (op. cash flow)', `${money(v.runRate)}/mo`),
    kv('Growth used', `${percent(v.growth, 1)}/mo`),
    kv('DCF (enterprise value)', money(v.dcf)),
    kv('Floor (cash, AR, assets, team)', money(v.floor)),
    v.runwayMonths === null ? kv('Runway', 'not burning') : kv('Runway', months(v.runwayMonths)));
}

function historySection(state: GameState): HTMLElement {
  const rows = state.history.slice(-CONFIG.valuation.historyMonths);
  const sec = section(`Last ${CONFIG.valuation.historyMonths} months`);
  if (rows.length === 0) {
    sec.appendChild(note('The first month has not closed yet.', 'muted'));
    return sec;
  }
  const table = h('table', { class: 'table' },
    h('thead', {}, h('tr', {}, h('th', { text: 'Month' }), h('th', { text: 'Revenue' }), h('th', { text: 'Profit' }), h('th', { text: 'FCF' }), h('th', { text: 'Δ cash' }), h('th', { text: 'Value' }))),
    h('tbody', {}, ...rows.map((b) => {
      const cal = selectors.calendar(b.startDay + 1);
      const cell = (n: number): HTMLElement => h('td', { class: n < -0.5 ? 'neg' : '', text: money(n) });
      return h('tr', {}, h('td', { text: `Y${cal.year} ${cal.monthName}` }), cell(ledger.revenueOf(b)), cell(b.profit), cell(b.fcf), cell(b.deltaCash), cell(b.valueEnd));
    })));
  sec.appendChild(h('div', { class: 'table-wrap' }, table));
  return sec;
}

/** The Books tab that carries "Investors want r%" with each premium (DESIGN.md 10): where the value pill lands. */
export const BOOKS_VALUATION_TAB = 'sheet';

export function booksSheet(controller: ShellController): SheetSpec {
  void controller;
  return {
    id: 'books',
    title: 'Books',
    tabs: [{ id: 'month', label: 'P&L' }, { id: 'bridge', label: 'Bridge' }, { id: BOOKS_VALUATION_TAB, label: 'Balance' }, { id: 'history', label: 'History' }],
    render(body, state, tab) {
      const cal = selectors.calendar(state.day);
      body.appendChild(h('div', { class: 'books-head', text: `${cal.label} · day ${cal.dayOfMonth} · month to date` }));
      if (tab === 'bridge') body.appendChild(bridgeSection(state));
      else if (tab === BOOKS_VALUATION_TAB) body.append(balanceSection(state), capTableSection(state), valuationSection(state), invoiceSection(state));
      else if (tab === 'history') body.appendChild(historySection(state));
      else body.append(pnlSection(state.book), invoiceSection(state));
    },
  };
}
