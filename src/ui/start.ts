/**
 * The start screen (DESIGN.md 0): the title, the one-line premise, the player's name
 * (required, remembered in this browser), today's world (the daily seed), the rules in
 * five lines, a preview of today's players (the best-of-the-day table, watched on the
 * leaderboard from the moment the screen mounts), and Start. The seed is the day the
 * clock starts: the label and the preview follow the UTC date while the screen waits.
 */
import { CONFIG, RULES, dailySeed } from '../sim';
import { money } from './format';
import { NAME_MAX } from './leaderboard';
import type { Leaderboard } from './leaderboard';
import { leaderTable, longCaption, watchCaption } from './leaderstrip';
import { h } from './panels/dom';

export interface StartOptions {
  seed: number;
  name: string;
}

const NAME_KEY = 'brightbyte.player.name.v1';
/** The day-change timer fires this long after UTC midnight, so the clock is on the new date when it is read. */
const MIDNIGHT_SLACK_MS = 1_000;

function rememberedName(): string {
  try {
    return localStorage.getItem(NAME_KEY) ?? '';
  } catch {
    return '';
  }
}

function rememberName(name: string): void {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    // private mode: the name lives for this session only
  }
}

/** Milliseconds until the next UTC midnight, when the daily seed changes (DESIGN.md 0: one seed per day). */
function msToNextUtcMidnight(now: Date): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(0, next - now.getTime());
}

export function mountStart(root: HTMLElement, leaderboard: Leaderboard, onStart: (opts: StartOptions) => void): () => void {
  let seed = dailySeed(new Date());
  const seedEl = h('b', { class: 'mono', text: String(seed) });

  /** DESIGN.md 0: one seed per day for all players, so the world is the day the clock starts, not the day the page opened. */
  const syncSeed = (): void => {
    const today = dailySeed(new Date());
    if (today === seed) return;
    seed = today;
    seedEl.textContent = String(seed);
    leaderboard.watch(seed);
  };

  const nameInput = h('input', {
    class: 'input',
    type: 'text',
    value: rememberedName(),
    placeholder: 'Your name',
    attrs: { maxlength: String(NAME_MAX), autocomplete: 'nickname', required: '', 'aria-label': 'Your name', enterkeyhint: 'go' },
  });
  const nameError = h('div', { class: 'field-error', text: 'Enter a name to play.' });
  nameError.hidden = true;
  nameInput.addEventListener('input', () => {
    nameError.hidden = true;
  });

  const form = h('form', { class: 'start-form', attrs: { novalidate: '' } },
    h('label', { class: 'field' }, h('span', { text: 'Your name' }), nameInput, nameError),
    h('div', { class: 'world' },
      h('span', { text: "Today's world: " }),
      seedEl,
      h('span', { class: 'caption', text: 'Everyone playing today gets the same world.' })),
    h('button', { class: 'btn primary start-btn', type: 'submit', text: 'Start the clock' }));
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const name = nameInput.value.trim().slice(0, NAME_MAX);
    if (!name) {
      nameError.hidden = false;
      nameInput.focus();
      return;
    }
    rememberName(name);
    // the seed of the moment the clock starts, and the label with it
    syncSeed();
    onStart({ seed, name });
  });

  const minutes = Math.round(RULES.roundSeconds / 60);
  const rules = h('ul', { class: 'start-rules' },
    h('li', { text: `${minutes}:00 on the clock; one game month every ${RULES.secondsPerMonth} seconds. No pause: a card you leave open costs game months, not minutes.` }),
    h('li', { text: `You start in a garage with ${money(CONFIG.start.cash)}. Hire and fire in ${RULES.roles.length} departments; desks, laptops and rooms sort themselves out.` }),
    h('li', { text: 'Buy servers and a demo room. Take or decline investors. Answer what happens.' }),
    h('li', { text: 'Score = company value × the share you still own when the buzzer goes. Out of cash scores 0.' }),
    h('li', { text: 'The clock never stops. If you leave the tab, the game catches up when you return; a card left open keeps the game paused while the clock runs.' }));

  const tableWrap = h('div', { class: 'lb-wrap' });
  const caption = h('p', { class: 'caption' });
  caption.hidden = true;
  const unsubscribe = leaderboard.subscribe((entries) => {
    tableWrap.replaceChildren(leaderTable(entries));
  });
  const offCaption = watchCaption(leaderboard, caption, longCaption);
  // the preview: today's players, live, before any run is registered
  leaderboard.watch(seed);

  // The date can roll over while the page waits here: a timer to the next UTC midnight (re-armed each
  // day), and a check whenever the tab comes back, because a hidden tab's timers are throttled.
  let midnight: ReturnType<typeof setTimeout> | null = null;
  const armMidnight = (): void => {
    midnight = setTimeout(() => {
      syncSeed();
      armMidnight();
    }, msToNextUtcMidnight(new Date()) + MIDNIGHT_SLACK_MS);
  };
  armMidnight();
  const onVisible = (): void => {
    if (document.visibilityState === 'visible') syncSeed();
  };
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('focus', syncSeed);

  const screen = h('div', { class: 'start-screen' },
    h('div', { class: 'start-hero' },
      h('div', { class: 'start-logo', text: 'BrightByte' }),
      h('p', { class: 'start-premise', text: 'Ten minutes. Build the most valuable company. The buzzer sells it.' })),
    form,
    rules,
    h('section', { class: 'sec' }, h('h3', { class: 'sec-title', text: "Today's players" }), tableWrap, caption));
  root.appendChild(screen);

  return () => {
    if (midnight !== null) clearTimeout(midnight);
    document.removeEventListener('visibilitychange', onVisible);
    window.removeEventListener('focus', syncSeed);
    offCaption();
    unsubscribe();
    screen.remove();
  };
}
