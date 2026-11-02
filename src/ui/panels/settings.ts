/**
 * The gear sheet: new game, the seed, the leaderboard; and the leaderboard sheet.
 */
import type { ShellController } from '../controller';
import { renderLeaderboard } from '../leaderboard';
import { h, kv, note, section } from './dom';
import type { SheetSpec } from './sheet';

export interface SettingsHooks {
  onNewGame(): void;
  onLeaderboard(): void;
}

export function settingsSheet(controller: ShellController, hooks: SettingsHooks): SheetSpec {
  return {
    id: 'settings',
    title: 'Settings',
    render(body, state, _tab, api) {
      const seedText = h('span', { class: 'mono', text: String(state.seed) });
      body.appendChild(section('This run',
        kv('Company', state.companyName),
        kv('Seed', seedText),
        kv('Day', `${state.day}`),
        h('div', { class: 'btn-row' },
          h('button', { class: 'btn small', type: 'button', text: 'Copy seed', onClick: () => {
            const nav = navigator.clipboard;
            if (nav) nav.writeText(String(state.seed)).then(() => controller.toast('Seed copied.', 'info'), () => controller.toast(`Seed: ${state.seed}`, 'info'));
            else controller.toast(`Seed: ${state.seed}`, 'info');
          } }),
          h('button', { class: 'btn small', type: 'button', text: 'Restart same seed', onClick: () => {
            controller.newGame(state.seed);
            api.close();
          } }))));
      body.appendChild(section('Game',
        note('Runs are deterministic: the same seed and the same actions give the same world.', 'muted'),
        h('div', { class: 'btn-row' },
          h('button', { class: 'btn primary', type: 'button', text: 'New game', onClick: () => {
            api.close();
            hooks.onNewGame();
          } }),
          h('button', { class: 'btn', type: 'button', text: 'Leaderboard', onClick: () => hooks.onLeaderboard() }))));
      body.appendChild(note('Keys: space pauses, 1 and 3 set the speed, D opens the debug drawer, Escape closes sheets.', 'muted'));
    },
  };
}

export function leaderboardSheet(): SheetSpec {
  return {
    id: 'leaderboard',
    title: 'Leaderboard',
    render(body) {
      body.appendChild(note('Stored in this browser only: name, score, seed, date and months played.', 'muted'));
      body.appendChild(renderLeaderboard());
    },
  };
}
