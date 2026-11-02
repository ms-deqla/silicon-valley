/**
 * Entry point: the start screen, then the game shell — HUD, canvas + renderer,
 * the four action buttons, sheets, cards, toasts, the debug drawer, keyboard — and
 * the animation loop (controller.tick, then renderer.frame). DESIGN.md sections 2, 4, 13.
 */
import './ui/styles.css';
import type { GameState } from './sim';
import { createCards } from './ui/cards';
import { createController } from './ui/controller';
import type { ShellController, Tone } from './ui/controller';
import { createHud } from './ui/hud';
import { booksSheet } from './ui/panels/books';
import { buildSheet } from './ui/panels/build';
import { createDebugDrawer } from './ui/panels/debug';
import { h } from './ui/panels/dom';
import { hireSheet } from './ui/panels/hire';
import { investSheet } from './ui/panels/invest';
import { roomSheet } from './ui/panels/room';
import { sellSheet } from './ui/panels/sell';
import { leaderboardSheet, settingsSheet } from './ui/panels/settings';
import { createSheetHost } from './ui/panels/sheet';
import { createOfficeRenderer } from './ui/renderer';
import { mountStart } from './ui/start';
import type { StartOptions } from './ui/start';

/** Design size of the portrait column (DESIGN.md 2). */
const DESIGN_W = 420;
const DESIGN_H = 840;
/** Frame time handed to the renderer is capped so a hidden tab does not fast-forward animations. */
const MAX_RENDER_DT = 250;
const TOAST_MS = 3200;

const app = document.getElementById('app');
if (!app) throw new Error('#app missing');

function fitColumn(): void {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const s = Math.min(vw / DESIGN_W, vh / DESIGN_H);
  app!.style.setProperty('--s', s.toFixed(4));
  app!.classList.toggle('floating', vw - DESIGN_W * s > 12 || vh - DESIGN_H * s > 12);
}
fitColumn();
window.addEventListener('resize', fitColumn);
window.visualViewport?.addEventListener('resize', fitColumn);

interface Mounted {
  destroy(): void;
}

let game: Mounted | null = null;
let lastStart: Partial<StartOptions> = {};

function showStart(): void {
  game?.destroy();
  game = null;
  app!.replaceChildren();
  mountStart(app!, (opts) => {
    lastStart = opts;
    app!.replaceChildren();
    game = mountGame(opts);
  }, lastStart);
}

declare global {
  interface Window {
    /** Dev-only handle for poking the shell from the console (e.g. __brightbyte.selectRoom('garage')). */
    __brightbyte?: ShellController;
  }
}

function mountGame(opts: StartOptions): Mounted {
  const controller = createController(opts.seed, opts.companyName);
  if (import.meta.env.DEV) window.__brightbyte = controller;

  // ---- stage: canvas, overlays
  const canvas = h('canvas', { attrs: { 'aria-label': 'Office floor' } });
  const toasts = h('div', { class: 'toasts' });
  const banner = h('div', { class: 'banner' },
    h('span', { text: 'Tap a highlighted spot' }),
    h('button', { class: 'btn small', type: 'button', text: 'Cancel', onClick: () => controller.setPlacement(null) }));
  banner.hidden = true;
  const waiting = h('button', { class: 'waiting-chip', type: 'button', text: 'A card is waiting', onClick: () => cards.show() });
  waiting.hidden = true;
  const stage = h('div', { class: 'stage' }, canvas, toasts, banner, waiting);

  // ---- layers for sheets and cards (cards above sheets)
  const sheetLayer = h('div', { class: 'layer' });
  const cardLayer = h('div', { class: 'layer' });

  const sheets = createSheetHost(sheetLayer, () => controller.state);
  const cards = createCards(controller, cardLayer);

  const hud = createHud(controller, {
    onBooks: () => sheets.toggle(booksSheet(controller)),
    onGear: () => sheets.toggle(settingsSheet(controller, { onNewGame: showStart, onLeaderboard: () => sheets.open(leaderboardSheet()) })),
  });
  const debug = createDebugDrawer(controller, hud);

  const openBuild = (): void => sheets.open(buildSheet(controller, sheets));
  const actionButtons: Record<string, HTMLButtonElement> = {};
  const act = (id: string, label: string, sub: string, onClick: () => void): HTMLButtonElement => {
    const b = h('button', { class: `act ${id}`, type: 'button', onClick }, h('span', { text: label }), h('small', { text: sub }));
    actionButtons[id] = b;
    return b;
  };
  const actions = h('div', { class: 'actions' },
    act('hire', 'Hire', 'people', () => sheets.toggle(hireSheet(controller))),
    act('build', 'Build', 'rooms', () => sheets.toggle(buildSheet(controller, sheets))),
    act('invest', 'Invest', 'assets · capital', () => sheets.toggle(investSheet(controller, { showCard: () => cards.show(), openBuild }))),
    act('sell', 'Sell', 'the company', () => sheets.toggle(sellSheet(controller))));

  const column = h('div', { class: 'shell', style: 'display:contents' }, debug.el, hud.el, stage, actions, sheetLayer, cardLayer);
  app!.appendChild(column);

  // ---- renderer
  const renderer = createOfficeRenderer(canvas, controller);
  const ro = new ResizeObserver(() => renderer.resize());
  ro.observe(stage);
  const onResize = (): void => renderer.resize();
  window.addEventListener('resize', onResize);
  renderer.resize();

  // ---- toasts
  function showToast(text: string, tone: Tone): void {
    const t = h('div', { class: `toast ${tone}`, text });
    toasts.appendChild(t);
    while (toasts.childElementCount > 4) toasts.firstElementChild?.remove();
    setTimeout(() => {
      t.classList.add('leaving');
      setTimeout(() => t.remove(), 320);
    }, TOAST_MS);
  }
  const offToast = controller.onToast(showToast);

  // ---- placement banner, room selection
  const offPlacement = controller.onPlacement((mode) => {
    banner.hidden = !mode;
    if (mode) sheets.close();
  });
  const offSelect = controller.onSelect((roomId) => {
    if (roomId) sheets.open(roomSheet(controller, roomId));
    else if (sheets.openId?.startsWith('room:')) sheets.close();
  });

  // ---- state → DOM (only on state change, never per frame)
  const refresh = (state: GameState): void => {
    hud.update(state);
    sheets.update();
    cards.update(state);
    debug.update(state);
    waiting.hidden = !(state.status === 'playing' && state.card && !cards.isShowing);
    for (const [id, b] of Object.entries(actionButtons)) b.classList.toggle('open', sheets.openId === id);
  };
  const offState = controller.subscribe(refresh);
  refresh(controller.state);
  const syncButtons = (): void => {
    for (const [id, b] of Object.entries(actionButtons)) b.classList.toggle('open', sheets.openId === id);
    waiting.hidden = !(controller.state.status === 'playing' && controller.state.card && !cards.isShowing);
  };
  sheetLayer.addEventListener('click', syncButtons);
  actions.addEventListener('click', () => setTimeout(syncButtons, 0));
  cardLayer.addEventListener('click', () => setTimeout(syncButtons, 0));

  // ---- keyboard
  const onKey = (ev: KeyboardEvent): void => {
    const t = ev.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    switch (ev.key) {
      case ' ':
        ev.preventDefault();
        controller.togglePause();
        hud.refreshSpeed();
        break;
      case '1':
        controller.speed = 1;
        hud.refreshSpeed();
        break;
      case '3':
        controller.speed = 3;
        hud.refreshSpeed();
        break;
      case 'd':
      case 'D':
        debug.toggle();
        break;
      case 'Escape':
        if (controller.placement) controller.setPlacement(null);
        else sheets.close();
        syncButtons();
        break;
      default:
        return;
    }
  };
  window.addEventListener('keydown', onKey);

  // ---- the loop: sim ticks on wall-clock, then one frame
  let last = performance.now();
  let raf = 0;
  const loop = (now: number): void => {
    const dt = Math.max(0, now - last);
    last = now;
    controller.tick(dt);
    renderer.frame(Math.min(dt, MAX_RENDER_DT));
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);

  return {
    destroy() {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener('resize', onResize);
      window.removeEventListener('keydown', onKey);
      offToast();
      offPlacement();
      offSelect();
      offState();
      renderer.destroy();
      sheets.destroy();
      column.remove();
      if (window.__brightbyte === controller) delete window.__brightbyte;
    },
  };
}

showStart();
