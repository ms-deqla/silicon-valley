/**
 * Build sheet: departments with the two sizes and their rent, the demo room, a floor
 * picker when the second floor exists; "Place" enters placement mode on the canvas.
 * DESIGN.md sections 5 and 13.
 */
import { CONFIG, ROLES, ROLE_LABEL, roomRent, validSpots } from '../../sim';
import type { GameState, Role, RoomSize, Verdict } from '../../sim';
import { no, OK } from '../../sim';
import type { ShellController } from '../controller';
import { money } from '../format';
import { h, note, section, segmented, verdictButton } from './dom';
import type { SheetHost, SheetSpec } from './sheet';

const ROLE_BLURB: Record<Role, string> = {
  product: 'Engineers ship features: price and conversion go up.',
  sales: 'Reps close enterprise deals from the lobby.',
  support: 'Agents serve tickets: fewer customers churn.',
  marketing: 'Marketers bring visitors; unlocks the ad budget.',
  finance: 'Shorter invoice terms, fewer defaults, enables loans.',
  rnd: 'Researchers raise the price tier (×1.5, ×2.25).',
};

export function buildSheet(controller: ShellController, host: SheetHost): SheetSpec {
  let floor: 0 | 1 = 0;

  function placementVerdict(state: GameState, kind: Role | 'demo', size: RoomSize): { verdict: Verdict; spots: { x: number; y: number }[] } {
    if (kind === 'finance' && !state.financeUnlocked) return { verdict: no('Locks until your first invoice'), spots: [] };
    const spots = validSpots(state, kind, size, floor);
    if (spots.length === 0) return { verdict: no(`No free spot on floor ${floor + 1}`), spots };
    const v = controller.can({ type: 'placeRoom', kind, size, floor, x: spots[0].x, y: spots[0].y });
    return { verdict: v.ok ? OK : v, spots };
  }

  function place(kind: Role | 'demo', size: RoomSize, spots: { x: number; y: number }[]): void {
    controller.setPlacement({ kind, size, floor, spots });
    host.close();
  }

  return {
    id: 'build',
    title: 'Build',
    render(body, state) {
      if (state.floors === 2) {
        body.appendChild(h('div', { class: 'row-sub' }, 'Floor ',
          segmented([{ id: '0', label: 'Ground floor' }, { id: '1', label: 'Second floor' }], String(floor), (id) => {
            floor = id === '1' ? 1 : 0;
            host.update();
          })));
      } else {
        floor = 0;
      }
      body.appendChild(note('Rent starts the day a room opens. Closing a room fires its staff (severance) and sells its desks at 60% of book.'));

      const sizes: { size: RoomSize; label: string }[] = [
        { size: 'small', label: `Small ${CONFIG.rooms.size.small.w}×${CONFIG.rooms.size.small.h}` },
        { size: 'large', label: `Large ${CONFIG.rooms.size.large.w}×${CONFIG.rooms.size.large.h}` },
      ];

      const depts = section('Departments');
      for (const role of ROLES) {
        const locked = role === 'finance' && !state.financeUnlocked;
        const row = h('div', { class: `card-row dept ${role}${locked ? ' locked' : ''}` },
          h('div', { class: 'row-head' },
            h('span', { class: 'row-head-left' }, h('i', { class: `swatch ${role}` }), h('b', { text: ROLE_LABEL[role] })),
            locked ? h('span', { class: 'tag', text: 'Locked' }) : null),
          h('div', { class: 'row-sub', text: locked ? 'Locks until your first invoice.' : ROLE_BLURB[role] }));
        const btns = h('div', { class: 'btn-row' });
        for (const s of sizes) {
          const { verdict, spots } = placementVerdict(state, role, s.size);
          const cfg = CONFIG.rooms.size[s.size];
          btns.appendChild(verdictButton(
            h('span', { class: 'btn-stack' }, h('b', { text: s.label }), h('small', { text: `${cfg.maxDesks} desks · ${money(roomRent(role, s.size))}/mo` })),
            verdict,
            () => place(role, s.size, spots),
            'btn small'));
        }
        row.appendChild(btns);
        depts.appendChild(row);
      }
      body.appendChild(depts);

      const demoCfg = CONFIG.assets.catalogue.demoRoom;
      const { verdict, spots } = placementVerdict(state, 'demo', 'small');
      body.appendChild(section('Demo room',
        h('div', { class: 'card-row dept demo' },
          h('div', { class: 'row-head' }, h('span', { class: 'row-head-left' }, h('i', { class: 'swatch demo' }), h('b', { text: demoCfg.label })), h('b', { text: money(demoCfg.price) })),
          h('div', { class: 'row-sub', text: `A ${CONFIG.rooms.demo.w}×${CONFIG.rooms.demo.h} block, capex only, no rent. Enterprise deals ×${CONFIG.assets.demoRoomMult}. Depreciates over ${demoCfg.lifeMonths / 12} years.` }),
          h('div', { class: 'btn-row' }, verdictButton('Place', verdict, () => place('demo', 'small', spots), 'btn small')))));
    },
  };
}
