/**
 * Invest sheet: Assets (catalogue with payback), Owned (book value, Sell at 60% of
 * book) and Capital (founder share, rounds, loan, the waiting knock).
 * DESIGN.md sections 7, 10 and 13.
 */
import { ASSET_KINDS, CONFIG, catalogue, ledger, selectors } from '../../sim';
import type { Asset, AssetKind, GameState, Room } from '../../sim';
import type { ShellController } from '../controller';
import { money, months, percent } from '../format';
import { h, kv, note, section, verdictButton } from './dom';
import { adBudgetControl, roomTitle } from './room';
import type { SheetSpec } from './sheet';

export interface InvestHooks {
  /** Re-open the card modal (the knock the player hid). */
  showCard(): void;
  /** The demo room is placed from the Build sheet. */
  openBuild(): void;
}

function deskRooms(state: GameState): Room[] {
  return state.rooms.filter((r) => r.kind !== 'lobby' && r.kind !== 'demo');
}

export function investSheet(controller: ShellController, hooks: InvestHooks): SheetSpec {
  let deskRoomId: string | null = null;

  function assetsTab(body: HTMLElement, state: GameState): void {
    if (selectors.hasRoom(state, 'marketing')) body.appendChild(section('Marketing', adBudgetControl(controller, state)));
    body.appendChild(note(`Capex leaves cash today and reaches profit as depreciation month by month. Resale is ${Math.round(CONFIG.assets.resaleOfBook * 100)}% of book.`));
    const sec = section('Catalogue');
    for (const card of catalogue(state)) {
      const row = h('div', { class: 'card-row asset' },
        h('div', { class: 'row-head' }, h('b', { text: card.label }), h('b', { text: money(card.price) })),
        h('div', { class: 'row-sub', text: card.effect }),
        h('div', { class: 'row-sub muted', text: `−${money(card.monthlyDepreciation)}/mo depreciation · life ${card.lifeMonths / 12} y · payback ${card.paybackMonths === null || card.paybackMonths > 120 ? '—' : months(card.paybackMonths)}` }));
      if (card.kind === 'desk') {
        const rooms = deskRooms(state);
        if (!deskRoomId || !rooms.some((r) => r.id === deskRoomId)) {
          deskRoomId = rooms.find((r) => selectors.desksIn(state, r.id).length < selectors.roomMaxDesks(r))?.id ?? rooms[0]?.id ?? null;
        }
        const select = h('select', { class: 'select', attrs: { 'aria-label': 'Room for the desk' }, onChange: (ev) => {
          deskRoomId = (ev.target as HTMLSelectElement).value;
          rerenderSoon();
        } });
        for (const r of rooms) {
          select.appendChild(h('option', { value: r.id, selected: r.id === deskRoomId, text: `${roomTitle(state, r)} · ${selectors.desksIn(state, r.id).length}/${selectors.roomMaxDesks(r)} desks` }));
        }
        row.appendChild(h('div', { class: 'row-sub' }, 'Into ', select));
        const v = deskRoomId ? controller.can({ type: 'buyAsset', kind: 'desk', roomId: deskRoomId }) : { ok: false, reason: 'No room to put it in.' };
        row.appendChild(verdictButton('Buy', v, () => {
          if (deskRoomId) controller.dispatch({ type: 'buyAsset', kind: 'desk', roomId: deskRoomId });
        }, 'btn primary small'));
      } else if (card.kind === 'demoRoom') {
        // the demo room is placed on the floor from the Build sheet (rooms.placeRoom), not bought here
        const v = selectors.hasDemoRoom(state) ? { ok: false, reason: 'You already have a demo room.' } : { ok: true };
        row.appendChild(h('div', { class: 'btn-row' }, verdictButton('Place via Build', v, () => hooks.openBuild(), 'btn small')));
      } else {
        const v = controller.can({ type: 'buyAsset', kind: card.kind });
        row.appendChild(verdictButton('Buy', v, () => controller.dispatch({ type: 'buyAsset', kind: card.kind }), 'btn primary small'));
      }
      sec.appendChild(row);
    }
    body.appendChild(sec);
  }

  let rerender: (() => void) | null = null;
  function rerenderSoon(): void {
    const fn = rerender;
    if (fn) setTimeout(fn, 0);
  }

  function ownedTab(body: HTMLElement, state: GameState): void {
    const total = ledger.assetsAtBook(state);
    body.appendChild(note(`${state.assets.length} assets · ${money(total)} at book. Selling returns ${Math.round(CONFIG.assets.resaleOfBook * 100)}% of book; the rest is a disposal loss in the P&L.`));
    const spare = selectors.spareLaptops(state);
    if (spare > 0) body.appendChild(note(`${spare} spare ${spare === 1 ? 'laptop' : 'laptops'}: still depreciating, can be sold.`, 'muted'));
    const order = (k: AssetKind): number => ASSET_KINDS.indexOf(k);
    const assets = [...state.assets].sort((a, b) => order(a.kind) - order(b.kind) || a.boughtDay - b.boughtDay);
    if (assets.length === 0) body.appendChild(note('Nothing owned yet.', 'muted'));
    for (const a of assets) body.appendChild(assetRow(state, a));
  }

  function assetRow(state: GameState, a: Asset): HTMLElement {
    const label = CONFIG.assets.catalogue[a.kind].label;
    const room = a.roomId ? selectors.roomById(state, a.roomId) : undefined;
    const where = room ? ` · ${roomTitle(state, room)}` : '';
    const resale = a.bookValue * CONFIG.assets.resaleOfBook;
    const v = controller.can({ type: 'sellAsset', assetId: a.id });
    return h('div', { class: 'card-row asset' },
      h('div', { class: 'row-head' }, h('b', { text: `${label}${where}` }), h('span', {}, h('b', { text: money(a.bookValue) }), h('span', { class: 'muted', text: ' book' }))),
      h('div', { class: 'row-sub muted', text: `Bought ${selectors.calendar(a.boughtDay).label} for ${money(a.cost)} · −${money(a.cost / a.lifeMonths)}/mo` }),
      verdictButton(`Sell · ${money(resale)}`, v, () => controller.dispatch({ type: 'sellAsset', assetId: a.id }), 'btn small'));
  }

  function capitalTab(body: HTMLElement, state: GameState): void {
    if (state.card && (state.card.kind === 'knock' || state.card.kind === 'desperation' || state.card.kind === 'maturity')) {
      body.appendChild(h('div', { class: 'card-row waiting' },
        h('b', { text: state.card.kind === 'maturity' ? 'The bank is waiting' : 'An investor is waiting' }),
        h('div', { class: 'row-sub', text: 'The clock is stopped until you answer.' }),
        h('button', { class: 'btn primary small', type: 'button', text: 'Open the offer', onClick: hooks.showCard })));
    }

    body.appendChild(section('Ownership',
      kv('Your share', percent(state.founderShare, 1)),
      kv('Company value', money(state.valuation.value)),
      kv('Your stake is worth', money(state.valuation.value * state.founderShare))));

    const rounds = section('Rounds');
    if (state.rounds.length === 0) rounds.appendChild(note('No equity raised. Investors knock on their own schedule; declining costs nothing.', 'muted'));
    for (const r of state.rounds) {
      rounds.appendChild(h('div', { class: 'card-row round' },
        h('div', { class: 'row-head' }, h('b', { text: `${money(r.amount)} for ${percent(r.shareSold, 1)}` }), h('span', { class: `tag${r.desperate ? ' bad' : ''}`, text: r.desperate ? 'Desperation' : 'Round' })),
        h('div', { class: 'row-sub muted', text: `${selectors.calendar(r.day).label} · pre-money ${money(r.preMoney)} · post-money ${money(r.postMoney)}` })));
    }
    body.appendChild(rounds);

    const loan = section('Loan');
    if (state.loan) {
      const l = state.loan;
      const v = controller.can({ type: 'prepayLoan' });
      loan.append(
        kv('Principal', money(l.principal)),
        kv('Rate', `${percent(l.annualRate, 1)} a year · ${money(selectors.monthlyInterest(state))}/mo`),
        kv('Due', `${selectors.calendar(l.dueDay).label} (day ${l.dueDay})${l.rolledOver ? ' · rolled over' : ''}`),
        kv('Drawn', selectors.calendar(l.startDay).label),
        note(`The principal is due in one payment. If cash is short that day, the bank offers one ${CONFIG.capital.rolloverMonths}-month rollover at +${Math.round(CONFIG.capital.rolloverPremium * 100)}%; failing that is game over.`),
        verdictButton(`Prepay · ${money(l.principal)}`, v, () => controller.dispatch({ type: 'prepayLoan' }), 'btn primary small'));
    } else {
      loan.appendChild(note(selectors.hasRoom(state, 'finance')
        ? 'No loan outstanding. The next investor knock will include a loan option.'
        : 'No loan. Loans are offered with investor knocks and need a Finance room.', 'muted'));
    }
    body.appendChild(loan);
  }

  return {
    id: 'invest',
    title: 'Invest',
    tabs: [{ id: 'assets', label: 'Assets' }, { id: 'owned', label: 'Owned' }, { id: 'capital', label: 'Capital' }],
    render(body, state, tab, api) {
      rerender = api.rerender;
      if (tab === 'owned') ownedTab(body, state);
      else if (tab === 'capital') capitalTab(body, state);
      else assetsTab(body, state);
    },
  };
}
