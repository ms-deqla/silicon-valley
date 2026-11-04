/**
 * The start screen (DESIGN.md 0): the title "Silicon Valley", the premise (you build
 * BrightByte), the player's name (required, remembered in this browser), the colour
 * (one of eight, remembered; DESIGN.md 20), the optional tournament code (empty = today's
 * world, else seed = hashSeed(code); DESIGN.md 20), the rules in five lines, a preview of
 * the chosen world's players (the best-of-the-day table, watched on the leaderboard from
 * the moment the screen mounts and whenever the code changes), "How to play" (the
 * Playbook), the speaker toggle (DESIGN.md 19), "Start the clock" and "Practice (not
 * scored)". The daily seed is the day the clock starts: the label and the preview follow
 * the UTC date while the screen waits.
 */
import { CONFIG, RULES, dailySeed, hashSeed } from '../sim';
import type { Audio } from './audio';
import { money } from './format';
import { icon } from './icons';
import { COLORS, COLOR_HEX, DEFAULT_COLOR, NAME_MAX, isColor } from './leaderboard';
import type { Color, Leaderboard } from './leaderboard';
import { leaderTable, longCaption, watchCaption } from './leaderstrip';
import { h } from './panels/dom';
import { openPlaybook, styleOnce } from './playbook';
import type { PlaybookHandle } from './playbook';

export interface StartOptions {
  seed: number;
  name: string;
  /** DESIGN.md 20: the player's colour */
  color: Color;
  /** DESIGN.md 0, Practice: nothing is posted to the board */
  practice: boolean;
  /** the tournament code the seed came from, or '' for today's world */
  code: string;
}

export interface StartExtras {
  /** the page's audio, for the speaker toggle (hidden when the AudioContext cannot be created) */
  audio?: Audio;
}

export const GAME_TITLE = 'Silicon Valley';

const NAME_KEY = 'brightbyte.player.name.v1';
const COLOR_KEY = 'brightbyte.player.color.v1';
/** The code typed on the start screen is trimmed to this many characters. */
export const CODE_MAX = 32;
/** The day-change timer fires this long after UTC midnight, so the clock is on the new date when it is read. */
const MIDNIGHT_SLACK_MS = 1_000;
/** A typed code re-points the preview at its world after this pause, not on every keystroke. */
const CODE_DEBOUNCE_MS = 350;

function remembered(key: string): string {
  try {
    return localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}

function remember(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // private mode: the value lives for this session only
  }
}

function rememberedColor(): Color {
  const c = remembered(COLOR_KEY);
  return isColor(c) ? c : DEFAULT_COLOR;
}

/** Milliseconds until the next UTC midnight, when the daily seed changes (DESIGN.md 0: one seed per day). */
function msToNextUtcMidnight(now: Date): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(0, next - now.getTime());
}

/** DESIGN.md 20: the seed of a tournament code, or today's world when the code is empty. */
export function seedFor(code: string, now: Date): number {
  // case does not matter: "Friday" and "friday" are the same world (DESIGN.md 20)
  const t = code.trim().toLowerCase();
  return t ? hashSeed(t) : dailySeed(now);
}

/** The code the page was opened with (`?code=word`), so a shared link lands on the same world. */
function codeFromUrl(): string {
  try {
    return (new URL(location.href).searchParams.get('code') ?? '').trim().slice(0, CODE_MAX);
  } catch {
    return '';
  }
}

const START_CSS = `
.start-title { font-size: 11px; font-weight: 800; letter-spacing: 0.14em; text-transform: uppercase; color: var(--ink-2, #5d616c); }
.start-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
.swatches { display: flex; gap: 7px; flex-wrap: wrap; }
.swatch { width: 42px; height: 42px; border-radius: 50%; border: 2px solid transparent; box-shadow: inset 0 0 0 1px rgba(20, 22, 30, 0.15); cursor: pointer; padding: 0; }
.swatch[aria-pressed="true"] { border-color: var(--ink, #22242b); transform: scale(1.08); }
.start-buttons { display: flex; flex-direction: column; gap: 8px; }
.btn.practice-btn { width: 100%; min-height: 46px; }
.start-links { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
.start-links .link { padding: 10px 2px; min-height: 44px; display: inline-flex; align-items: center; }
.start-speaker { display: inline-flex; align-items: center; gap: 6px; border: 0; background: rgba(255, 255, 255, 0.75); border-radius: 999px; padding: 10px 14px 10px 11px; min-height: 44px; font-weight: 700; font-size: 12.5px; cursor: pointer; box-shadow: var(--shadow-soft, 0 4px 14px rgba(20, 22, 30, 0.08)); }
.start-speaker .icon { width: 18px; height: 18px; }
.start-speaker[aria-pressed="false"] { color: var(--ink-3, #8b92a3); }
`;

export function mountStart(root: HTMLElement, leaderboard: Leaderboard, onStart: (opts: StartOptions) => void, extras: StartExtras = {}): () => void {
  styleOnce('sv-start-style', START_CSS);
  let code = codeFromUrl();
  let seed = seedFor(code, new Date());
  const seedEl = h('b', { class: 'mono', text: String(seed) });
  const worldLabel = h('span', { text: "Today's world: " });
  const worldCaption = h('span', { class: 'caption' });
  let playbook: PlaybookHandle | null = null;

  const describeWorld = (): void => {
    seedEl.textContent = String(seed);
    worldLabel.textContent = code ? `World of “${code}”: ` : "Today's world: ";
    worldCaption.textContent = code
      ? 'Everyone who types this code plays this world and shares its board.'
      : 'Everyone playing today gets the same world.';
  };

  /**
   * DESIGN.md 0: one seed per day for all players, so the world is the day the clock starts, not the day
   * the page opened; with a code (DESIGN.md 20) the world is the code's and the date does not matter.
   */
  const syncSeed = (): void => {
    const next = seedFor(code, new Date());
    if (next === seed) return;
    seed = next;
    describeWorld();
    leaderboard.watch(seed);
  };

  const nameInput = h('input', {
    class: 'input',
    type: 'text',
    value: remembered(NAME_KEY),
    placeholder: 'Your name',
    attrs: { maxlength: String(NAME_MAX), autocomplete: 'nickname', required: '', 'aria-label': 'Your name', enterkeyhint: 'go' },
  });
  const nameError = h('div', { class: 'field-error', text: 'Enter a name to play.' });
  nameError.hidden = true;
  nameInput.addEventListener('input', () => {
    nameError.hidden = true;
  });

  // DESIGN.md 20: one of eight named pastel colours, remembered
  let color: Color = rememberedColor();
  const swatches = h('div', { class: 'swatches', attrs: { role: 'radiogroup', 'aria-label': 'Your colour' } });
  const swatchButtons = new Map<Color, HTMLButtonElement>();
  const syncSwatches = (): void => {
    for (const [c, b] of swatchButtons) b.setAttribute('aria-pressed', c === color ? 'true' : 'false');
  };
  for (const c of COLORS) {
    const b = h('button', {
      class: 'swatch',
      type: 'button',
      title: c,
      style: `background:${COLOR_HEX[c]}`,
      attrs: { 'aria-label': c, 'aria-pressed': 'false' },
      onClick: () => {
        color = c;
        remember(COLOR_KEY, c);
        syncSwatches();
      },
    });
    swatchButtons.set(c, b);
    swatches.appendChild(b);
  }
  syncSwatches();

  // DESIGN.md 20: the tournament code; the preview follows the typed world after a short pause
  const codeInput = h('input', {
    class: 'input',
    type: 'text',
    value: code,
    placeholder: 'Tournament code (optional)',
    attrs: { maxlength: String(CODE_MAX), autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', 'aria-label': 'Tournament code' },
  });
  let codeTimer: ReturnType<typeof setTimeout> | null = null;
  const applyCode = (): void => {
    code = codeInput.value.trim().slice(0, CODE_MAX);
    describeWorld();
    syncSeed();
  };
  codeInput.addEventListener('input', () => {
    if (codeTimer !== null) clearTimeout(codeTimer);
    codeTimer = setTimeout(applyCode, CODE_DEBOUNCE_MS);
  });
  codeInput.addEventListener('change', applyCode);

  const startBtn = h('button', { class: 'btn primary start-btn', type: 'submit', text: 'Start the clock' });
  const practiceBtn = h('button', { class: 'btn practice-btn', type: 'submit', text: 'Practice (not scored)', title: 'The same round on the same world; nothing is posted to the board.' });

  const form = h('form', { class: 'start-form', attrs: { novalidate: '' } },
    h('label', { class: 'field' }, h('span', { text: 'Your name' }), nameInput, nameError),
    h('div', { class: 'field' }, h('span', { text: 'Your colour' }), swatches),
    h('label', { class: 'field' }, h('span', { text: 'Tournament code' }), codeInput),
    h('div', { class: 'world' }, worldLabel, seedEl, worldCaption),
    h('div', { class: 'start-buttons' }, startBtn, practiceBtn));
  form.addEventListener('submit', (ev: SubmitEvent) => {
    ev.preventDefault();
    const name = nameInput.value.trim().slice(0, NAME_MAX);
    if (!name) {
      nameError.hidden = false;
      nameInput.focus();
      return;
    }
    remember(NAME_KEY, name);
    if (codeTimer !== null) {
      clearTimeout(codeTimer);
      codeTimer = null;
    }
    // the seed of the moment the clock starts, and the label with it
    applyCode();
    const practice = ev.submitter === practiceBtn;
    onStart({ seed, name, color, practice, code });
  });

  const minutes = Math.round(RULES.roundSeconds / 60);
  const room = CONFIG.rooms.size[RULES.roomSize];
  const cat = CONFIG.assets.catalogue;
  const rules = h('ul', { class: 'start-rules' },
    h('li', { text: `${minutes}:00 on the clock; one game month every ${RULES.secondsPerMonth} seconds. No pause: a card you leave open costs game months, not minutes.` }),
    h('li', { text: `You start in a garage with ${money(CONFIG.start.cash)}. Hire and fire in ${RULES.roles.length} departments; a desk, a laptop and a room of ${room.maxDesks} desks (${money(room.rent)}/mo) come with the hire, an emptied room closes by itself, and a full ground floor builds the second floor for ${money(cat.secondFloor.price)}.` }),
    h('li', { text: `Buy servers (${money(cat.server.price)}) and a demo room (${money(cat.demoRoom.price)}). Take or decline investors. Answer what happens.` }),
    h('li', { text: 'Score = company value × the share you still own when the buzzer goes. Out of cash scores 0.' }),
    h('li', { text: 'The clock never stops. If you leave the tab, the game catches up when you return; a card left open keeps the game paused while the clock runs.' }));

  // DESIGN.md 19: the speaker button, hidden when there is no AudioContext
  const audio = extras.audio;
  const speaker = h('button', { class: 'start-speaker', type: 'button', attrs: { 'aria-pressed': 'false' } });
  const syncSpeaker = (): void => {
    if (!audio || !audio.available) {
      speaker.hidden = true;
      return;
    }
    speaker.hidden = false;
    speaker.replaceChildren(icon(audio.enabled ? 'speakerOn' : 'speakerOff'), audio.enabled ? 'Sound on' : 'Sound off');
    speaker.setAttribute('aria-pressed', audio.enabled ? 'true' : 'false');
    speaker.title = audio.enabled ? 'Turn the sound off' : 'Turn the sound on';
  };
  speaker.addEventListener('click', () => {
    if (!audio) return;
    audio.setEnabled(!audio.enabled);
    syncSpeaker();
  });
  syncSpeaker();

  const howTo = h('button', { class: 'link', type: 'button', text: 'How to play', onClick: () => {
    if (playbook) return;
    playbook = openPlaybook(root, { onClose: () => { playbook = null; } });
  } });
  const links = h('div', { class: 'start-links' }, howTo, speaker);

  const tableWrap = h('div', { class: 'lb-wrap' });
  const caption = h('p', { class: 'caption' });
  caption.hidden = true;
  const unsubscribe = leaderboard.subscribe((entries) => {
    tableWrap.replaceChildren(leaderTable(entries));
  });
  const offCaption = watchCaption(leaderboard, caption, longCaption);
  // the preview: the world's players, live, before any run is registered
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

  describeWorld();
  const screen = h('div', { class: 'start-screen' },
    h('div', { class: 'start-hero' },
      h('div', { class: 'start-logo', text: GAME_TITLE }),
      h('p', { class: 'start-premise', text: `You build ${CONFIG.start.companyName}. ${minutes} minutes; the buzzer sells it.` })),
    form,
    links,
    rules,
    h('section', { class: 'sec' }, h('h3', { class: 'sec-title', text: 'Players on this world' }), tableWrap, caption));
  root.appendChild(screen);

  return () => {
    if (midnight !== null) clearTimeout(midnight);
    if (codeTimer !== null) clearTimeout(codeTimer);
    document.removeEventListener('visibilitychange', onVisible);
    window.removeEventListener('focus', syncSeed);
    playbook?.close();
    offCaption();
    unsubscribe();
    screen.remove();
  };
}
