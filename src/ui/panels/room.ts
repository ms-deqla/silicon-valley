/**
 * Room sheet, opened when the renderer reports a room tap: kind, rent, desks and
 * occupants, Add desk, the Marketing ad budget slider, and Close room with its
 * consequences. DESIGN.md sections 5, 8 and 13.
 */
import { CONFIG, ROLE_JOB, ROLE_LABEL, selectors } from '../../sim';
import type { GameState, Room, RoomKind } from '../../sim';
import type { ShellController } from '../controller';
import { money, skillText } from '../format';
import { confirmButton, h, kv, note, section, verdictButton } from './dom';
import type { SheetSpec } from './sheet';

export function roomLabel(kind: RoomKind): string {
  if (kind === 'garage') return 'Garage';
  if (kind === 'lobby') return 'Lobby';
  if (kind === 'demo') return 'Demo room';
  return ROLE_LABEL[kind];
}

export function roomTitle(state: GameState, room: Room): string {
  const same = state.rooms.filter((r) => r.kind === room.kind);
  const idx = same.indexOf(room);
  return same.length > 1 ? `${roomLabel(room.kind)} ${idx + 1}` : roomLabel(room.kind);
}

/** The Marketing ad budget slider (DESIGN.md 8): $0–$20k in $1k steps, dispatched on release. */
export function adBudgetControl(controller: ShellController, state: GameState): HTMLElement {
  const m = CONFIG.marketing;
  const label = h('b', { text: `${money(state.adBudget)}/mo` });
  const visitors = h('span', { class: 'muted', text: ` · ≈${selectors.visitorsPerMonth(state).toFixed(1)} visitors/mo` });
  const input = h('input', {
    type: 'range', min: 0, max: m.adMax, step: m.adStep, value: state.adBudget, class: 'slider',
    attrs: { 'aria-label': 'Ad budget per month' },
    onInput: (ev) => {
      label.textContent = `${money(Number((ev.target as HTMLInputElement).value))}/mo`;
    },
    onChange: (ev) => {
      const input = ev.target as HTMLInputElement;
      controller.dispatch({ type: 'setAdBudget', amount: Number(input.value) });
      // a range input keeps focus after the gesture; drop it so nothing about the sheet waits on it
      input.blur();
    },
  });
  return h('div', { class: 'card-row adbudget' },
    h('div', { class: 'row-head' }, h('b', { text: 'Ad budget' }), h('span', {}, label, visitors)),
    input,
    h('div', { class: 'row-sub muted', text: `Visitors per month = ${m.baseVisitorsPerMonth} + ${m.visitorsPerOutput} × marketer output + ${m.adVisitorsPerSqrtK} × √(budget in $k). Spend accrues daily.` }));
}

export function roomSheet(controller: ShellController, roomId: string): SheetSpec {
  // Close room has a confirm step; its armed flag lives here so the per-day re-render keeps it.
  let closeArmed = false;
  return {
    id: `room:${roomId}`,
    title: 'Room',
    render(body, state, _tab, api) {
      const room = selectors.roomById(state, roomId);
      if (!room) {
        body.appendChild(note('This room is gone.'));
        return;
      }
      body.appendChild(h('div', { class: 'room-head' }, h('i', { class: `swatch big ${room.kind}` }), h('h2', { text: roomTitle(state, room) })));
      const desks = selectors.desksIn(state, roomId);
      const max = selectors.roomMaxDesks(room);
      const occupants = selectors.occupantsOf(state, roomId);
      body.appendChild(section('Details',
        kv('Rent', room.rent > 0 ? `${money(room.rent)}/mo` : 'rent-free'),
        kv('Size', `${room.w}×${room.h} · floor ${room.floor + 1}`),
        kv('Desks', `${desks.length} / ${max}`),
        kv('Seats free', String(Math.max(0, desks.length - occupants.length))),
        kv('Opened', selectors.calendar(room.openedDay).label)));

      if (room.kind !== 'lobby' && room.kind !== 'demo') {
        const list = section('People');
        if (occupants.length === 0) list.appendChild(note('Nobody sits here yet.', 'muted'));
        for (const p of occupants) {
          const role = selectors.roleOf(state, p);
          list.appendChild(kv(h('span', {}, h('b', { text: p.name }), h('span', { class: 'muted', text: ` · ${ROLE_JOB[role]}` })), `skill ${skillText(p.skill)} · morale ${Math.round(p.morale)}`));
        }
        body.appendChild(list);

        const deskPrice = CONFIG.assets.catalogue.desk.price;
        const v = controller.can({ type: 'buyAsset', kind: 'desk', roomId });
        body.appendChild(section('Desks',
          note(`A desk is ${money(deskPrice)} of capex (depreciates over ${CONFIG.assets.catalogue.desk.lifeMonths / 12} years) and seats one person.`),
          verdictButton(`Add desk · ${money(deskPrice)}`, v, () => controller.dispatch({ type: 'buyAsset', kind: 'desk', roomId }), 'btn primary small')));
      }

      if (room.kind === 'marketing') body.appendChild(section('Marketing', adBudgetControl(controller, state)));

      if (room.kind === 'garage') body.appendChild(note(`The garage is rent-free, seats ${CONFIG.rooms.garage.maxDesks}, and takes any role. It cannot be closed.`));
      if (room.kind === 'lobby') body.appendChild(note('Enterprise prospects wait here for a sales rep. Rent-free, cannot be closed.'));

      if (room.kind !== 'garage' && room.kind !== 'lobby') {
        let severance = 0;
        for (const p of occupants) severance += selectors.severanceOf(state, p);
        let deskBook = 0;
        for (const d of desks) deskBook += d.bookValue;
        const demoAsset = room.kind === 'demo' ? state.assets.find((a) => a.kind === 'demoRoom' && a.roomId === roomId) : undefined;
        const disposeBook = deskBook + (demoAsset?.bookValue ?? 0);
        const proceeds = disposeBook * CONFIG.assets.resaleOfBook;
        const loss = disposeBook - proceeds;
        const lines: string[] = [];
        if (occupants.length > 0) lines.push(`fires ${occupants.length} ${occupants.length === 1 ? 'person' : 'people'} with ${money(severance)} severance`);
        if (desks.length > 0) lines.push(`sells ${desks.length} ${desks.length === 1 ? 'desk' : 'desks'} for ${money(deskBook * CONFIG.assets.resaleOfBook)}`);
        if (demoAsset) lines.push(`disposes of the demo room for ${money(demoAsset.bookValue * CONFIG.assets.resaleOfBook)}`);
        if (loss > 0) lines.push(`books a ${money(loss)} disposal loss`);
        if (room.rent > 0) lines.push(`stops ${money(room.rent)}/mo of rent`);
        if (room.kind === 'marketing' && state.adBudget > 0) lines.push('resets the ad budget to $0');
        const v = controller.can({ type: 'closeRoom', roomId });
        const consequence = lines.length ? `Closing ${lines.join(', ')}.` : 'Closing this room has no cost.';
        body.appendChild(section('Close room',
          note(consequence),
          v.ok
            ? confirmButton('Close room', `${consequence} Cash impact now: ${money(proceeds - severance)}.`, 'Yes, close it', () => {
              controller.dispatch({ type: 'closeRoom', roomId });
              api.close();
            }, { armed: closeArmed, setArmed: (a) => { closeArmed = a; api.rerender(); } })
            : verdictButton('Close room', v, () => undefined, 'btn danger')));
      }
    },
    onClose() {
      closeArmed = false;
      controller.selectRoom(null);
    },
  };
}

