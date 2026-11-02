/**
 * The start screen: title, premise, company name, seed (today's by default), Start,
 * and the local leaderboard. DESIGN.md section 12.
 */
import { CONFIG, dailySeed, hashSeed } from '../sim';
import { money } from './format';
import { renderLeaderboard } from './leaderboard';
import { h } from './panels/dom';

export interface StartOptions {
  seed: number;
  companyName: string;
}

export function mountStart(root: HTMLElement, onStart: (opts: StartOptions) => void, initial: Partial<StartOptions> = {}): () => void {
  const today = dailySeed();
  const nameInput = h('input', { class: 'input', type: 'text', value: initial.companyName ?? CONFIG.start.companyName, attrs: { maxlength: '24', autocomplete: 'off' } });
  const seedInput = h('input', { class: 'input mono', type: 'text', value: String(initial.seed ?? today), attrs: { autocomplete: 'off', inputmode: 'text' } });
  const seedCaption = h('div', { class: 'caption' });

  function resolvedSeed(): number {
    const t = seedInput.value.trim();
    return t ? hashSeed(t) : today;
  }

  function refreshCaption(): void {
    const t = seedInput.value.trim();
    if (!t || t === String(today)) seedCaption.textContent = "today's seed — everyone playing today gets the same world";
    else if (/^-?\d+$/.test(t)) seedCaption.textContent = 'custom seed';
    else seedCaption.textContent = `“${t}” → seed ${hashSeed(t)}`;
  }
  seedInput.addEventListener('input', refreshCaption);
  refreshCaption();

  const start = (): void => {
    onStart({ seed: resolvedSeed(), companyName: nameInput.value.trim() || CONFIG.start.companyName });
  };
  const form = h('form', { class: 'start-form' },
    h('label', { class: 'field' }, h('span', { text: 'Company name' }), nameInput),
    h('label', { class: 'field' }, h('span', { text: 'Seed' }), seedInput, seedCaption),
    h('button', { class: 'btn primary start-btn', type: 'submit', text: 'Start' }));
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    start();
  });

  const screen = h('div', { class: 'start-screen' },
    h('div', { class: 'start-hero' },
      h('div', { class: 'start-logo', text: 'BrightByte' }),
      h('p', { class: 'start-premise', text: `Build a startup from a garage with ${money(CONFIG.start.cash)}. Watch profit and cash disagree — then sell before the bank notices.` })),
    form,
    h('section', { class: 'sec' }, h('h3', { class: 'sec-title', text: 'Leaderboard' }), renderLeaderboard()),
    h('p', { class: 'caption', text: 'Keys: space pauses, 1 and 3 set the speed, D opens the debug drawer, Escape closes sheets.' }));
  root.appendChild(screen);
  return () => screen.remove();
}
