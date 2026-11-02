/**
 * Debug drawer (press D): 10× speed, +$100k, force knock, force event, ship a
 * feature, +10 customers; shows the seed and the day. DESIGN.md section 13.
 */
import type { GameState } from '../../sim';
import type { ShellController } from '../controller';
import { h } from './dom';

export interface DebugDrawer {
  el: HTMLElement;
  toggle(): void;
  update(state: GameState): void;
}

export function createDebugDrawer(controller: ShellController, hud: { refreshSpeed(): void }): DebugDrawer {
  const info = h('span', { class: 'debug-info mono' });
  const btn = (label: string, onClick: () => void): HTMLElement => h('button', { class: 'btn tiny', type: 'button', text: label, onClick });
  const el = h('div', { class: 'debug' },
    h('div', { class: 'debug-row' }, h('b', { text: 'Debug' }), info),
    h('div', { class: 'debug-row' },
      btn('10× speed', () => {
        controller.speed = controller.speed === 10 ? 1 : 10;
        hud.refreshSpeed();
      }),
      btn('+$100k', () => controller.dispatch({ type: 'debug', op: 'cash' })),
      btn('Force knock', () => controller.dispatch({ type: 'debug', op: 'knock' })),
      btn('Force event', () => controller.dispatch({ type: 'debug', op: 'event' })),
      btn('Ship feature', () => controller.dispatch({ type: 'debug', op: 'feature' })),
      btn('+10 customers', () => controller.dispatch({ type: 'debug', op: 'tenCustomers' }))));
  el.hidden = true;
  return {
    el,
    toggle() {
      el.hidden = !el.hidden;
    },
    update(state) {
      info.textContent = `seed ${state.seed} · day ${state.day} · ${state.status}${state.card ? ` · card ${state.card.kind}` : ''}`;
    },
  };
}
