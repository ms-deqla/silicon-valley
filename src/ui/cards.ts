/**
 * The card modal (investor knocks, events, loan maturity) and the result screen
 * (sold / game over). DESIGN.md sections 10–13. The clock is stopped by the sim
 * while a card is open; the player can hide the card to look around and re-open it.
 */
import { selectors } from '../sim';
import type { Card, GameState, Result } from '../sim';
import type { ShellController } from './controller';
import { hashText, money, months, percent } from './format';
import { loadLeaderboard, renderLeaderboard, saveToLeaderboard } from './leaderboard';
import { h, svg } from './panels/dom';

export interface CardsUi {
  /** Show the card modal / result screen when state calls for it. */
  update(state: GameState): void;
  /** Re-open a card the player hid. */
  show(): void;
  readonly isShowing: boolean;
}

/** Hue per card kind / event type for the drawn portrait. */
function hueOf(card: Card): number {
  switch (card.kind) {
    case 'knock': return 190;
    case 'desperation': return 20;
    case 'maturity': return 40;
    case 'event':
      switch (card.eventType) {
        case 'latePayer': return 30;
        case 'outage': return 0;
        case 'press': return 280;
        case 'competitor': return 330;
        case 'poach': return 120;
        case 'recession': return 215;
        default: return 260;
      }
    case 'gameOver': return 0;
    case 'sold': return 48;
  }
}

const SMALL_WORDS = new Set(['a', 'an', 'the', 'at', 'of', 'from', 'your', 'our', 'in', 'on', 'and', 'for', 'to']);

function initialsOf(card: Card): string {
  const source = card.speaker ?? card.title;
  const words = source.split(/[^A-Za-z0-9]+/).filter((w) => w && !SMALL_WORDS.has(w.toLowerCase()));
  const caps = words.filter((w) => /^[A-Z]/.test(w));
  const pick = (caps.length >= 2 ? caps : words).slice(0, 2);
  const s = pick.map((w) => w[0].toUpperCase()).join('');
  return s || '?';
}

/** A closed smooth blob around a circle; shape from a hash so each speaker gets their own. */
function blobPath(seed: number): string {
  const n = 8;
  let s = (seed >>> 0) || 1;
  const rnd = (): number => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const pts: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const r = 38 + rnd() * 10;
    pts.push([50 + Math.cos(a) * r, 50 + Math.sin(a) * r]);
  }
  let d = `M${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n];
    const p1 = pts[i];
    const p2 = pts[(i + 1) % n];
    const p3 = pts[(i + 2) % n];
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C${c1[0].toFixed(1)} ${c1[1].toFixed(1)} ${c2[0].toFixed(1)} ${c2[1].toFixed(1)} ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
  }
  return `${d}Z`;
}

export function portrait(card: Card): SVGElement {
  const hue = hueOf(card);
  const seed = hashText(card.speaker ?? card.title);
  const el = svg('svg', { class: 'portrait', viewBox: '0 0 100 100', 'aria-hidden': 'true' },
    svg('path', { d: blobPath(seed), fill: `hsl(${hue} 70% 86%)` }),
    svg('path', { d: blobPath(seed ^ 0x9e3779b9), fill: `hsl(${hue} 65% 78%)`, transform: 'translate(50 50) scale(0.72) translate(-50 -50)', opacity: '0.9' }),
    svg('text', { x: '50', y: '58', 'text-anchor': 'middle', 'font-size': '30', 'font-weight': '800', fill: `hsl(${hue} 45% 30%)`, 'font-family': 'inherit' }, initialsOf(card)));
  return el;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function createCards(controller: ShellController, layer: HTMLElement): CardsUi {
  let shownCardId: string | null = null;
  let hiddenCardId: string | null = null;
  let shownResult: Result | null = null;
  let saved = false;
  const modal = h('div', { class: 'modal-backdrop' });

  function renderCard(card: Card): void {
    modal.className = `modal-backdrop kind-${card.kind}`;
    const choices = h('div', { class: 'choices' });
    for (const c of card.choices) {
      const btn = h('button', { class: `choice${c.disabled ? ' is-disabled' : ''}`, type: 'button', disabled: !!c.disabled, onClick: () => {
        if (c.disabled) return;
        controller.dispatch({ type: 'card', choiceId: c.id });
      } },
      h('b', { text: c.label }),
      c.detail ? h('small', { text: c.detail }) : null,
      c.disabled && c.reason ? h('span', { class: 'vreason', text: c.reason }) : null);
      choices.appendChild(btn);
    }
    const hideable = card.kind !== 'gameOver' && card.kind !== 'sold';
    modal.replaceChildren(h('div', { class: 'modal card', attrs: { role: 'dialog', 'aria-modal': 'true' } },
      h('div', { class: 'card-top' },
        portrait(card),
        h('div', { class: 'card-titles' },
          h('div', { class: 'card-kind', text: card.kind === 'event' ? 'Event' : card.kind === 'maturity' ? 'The bank' : card.kind === 'desperation' ? 'Last resort' : 'Investor' }),
          h('h2', { class: 'card-title', text: card.title }),
          card.speaker ? h('div', { class: 'card-speaker', text: card.speaker }) : null)),
      card.quote ? h('blockquote', { class: 'card-quote', text: `“${card.quote}”` }) : null,
      h('p', { class: 'card-body', text: card.body }),
      choices,
      hideable ? h('button', { class: 'link', type: 'button', text: 'Look around first (the clock stays stopped)', onClick: () => hide(card.id) }) : null));
  }

  function hide(cardId: string): void {
    hiddenCardId = cardId;
    shownCardId = null;
    modal.remove();
  }

  function renderResult(state: GameState, result: Result): void {
    modal.className = `modal-backdrop kind-${result.kind}`;
    const sold = result.kind === 'sold';
    const name = h('input', { class: 'input', type: 'text', placeholder: 'Your name', value: '', attrs: { maxlength: '24', 'aria-label': 'Name for the leaderboard' } });
    const lbWrap = h('div', { class: 'lb-wrap' }, renderLeaderboard(loadLeaderboard()));
    const saveBtn = h('button', { class: 'btn primary', type: 'button', text: 'Save to leaderboard', onClick: () => {
      if (saved) return;
      saved = true;
      const list = saveToLeaderboard({
        name: name.value.trim() || 'Anonymous',
        score: result.score,
        seed: state.seed,
        date: new Date().toISOString(),
        months: state.history.length,
        company: state.companyName,
      });
      lbWrap.replaceChildren(renderLeaderboard(list));
      saveBtn.textContent = 'Saved';
      saveBtn.disabled = true;
      name.disabled = true;
    } });
    const monthsPlayed = state.history.length;
    modal.replaceChildren(h('div', { class: 'modal result', attrs: { role: 'dialog', 'aria-modal': 'true' } },
      h('div', { class: 'result-emblem', text: sold ? '🏁' : '💸' }),
      h('h2', { class: 'result-headline', text: sold ? `You sold ${state.companyName}` : 'Game over' }),
      h('p', { class: 'result-reason', text: result.reason }),
      h('div', { class: 'result-grid' },
        stat('Offer', money(result.offer)),
        stat('Your share', percent(result.founderShare, 1)),
        stat('Debt', money(result.debt)),
        stat('Score', money(result.score), 'big'),
        stat('Months played', String(monthsPlayed)),
        stat('Ended', selectors.calendar(result.day).label)),
      h('p', { class: 'note muted', text: `${monthsPlayed > 0 ? months(monthsPlayed) : 'Less than a month'} · seed ${state.seed} · ${plural(state.customers.length, 'customer')} · ${plural(state.people.length, 'person', 'people')} at the end.` }),
      h('div', { class: 'save-row' }, name, saveBtn),
      lbWrap,
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn primary', type: 'button', text: 'Play again · same seed', onClick: () => controller.newGame(state.seed) }),
        h('button', { class: 'btn', type: 'button', text: 'Play again · new seed', onClick: () => controller.newGame(Math.floor(Math.random() * 2_147_483_647)) }))));
  }

  function stat(label: string, value: string, cls = ''): HTMLElement {
    return h('div', { class: `stat ${cls}`.trim() }, h('span', { class: 'stat-label', text: label }), h('b', { class: 'stat-value', text: value }));
  }

  function update(state: GameState): void {
    if (state.status !== 'playing' && state.result) {
      if (shownResult !== state.result) {
        shownResult = state.result;
        saved = false;
        shownCardId = null;
        hiddenCardId = null;
        renderResult(state, state.result);
      }
      if (!modal.isConnected) layer.appendChild(modal);
      return;
    }
    shownResult = null;
    const card = state.card;
    if (!card) {
      shownCardId = null;
      hiddenCardId = null;
      modal.remove();
      return;
    }
    if (card.id === hiddenCardId) return;
    if (card.id !== shownCardId) {
      shownCardId = card.id;
      hiddenCardId = null;
      renderCard(card);
    }
    if (!modal.isConnected) layer.appendChild(modal);
  }

  return {
    update,
    show() {
      hiddenCardId = null;
      update(controller.state);
    },
    get isShowing() {
      return modal.isConnected;
    },
  };
}
