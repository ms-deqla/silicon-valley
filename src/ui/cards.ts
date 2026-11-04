/**
 * The card modal: investor knocks and events (DESIGN.md sections 10, 11, 13, 17). The
 * sim stops game time while a card is open; the ten-minute countdown does not (DESIGN.md
 * 0), and the card's footer says so. Investor cards carry the dilution math before →
 * after and a decline that reads "Keep 69%"; every card carries the coach's badge with
 * the recommended choice and its reason (DESIGN.md 0, 18), drawn green. The player can
 * hide a card to check the Books and re-open it from the waiting chip. The result screen
 * lives in ./result.
 */
import { adviseCard } from '../sim';
import type { Card, CardChoice, GameState } from '../sim';
import type { ShellController } from './controller';
import { hashText, money, percent } from './format';
import { icon } from './icons';
import { h, svg } from './panels/dom';

export interface CardsUi {
  /** Show the card modal when state calls for it. */
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

/** DESIGN.md 17: the portrait circle, initials on a pastel blob. */
export function portrait(card: Card): SVGElement {
  const hue = hueOf(card);
  const seed = hashText(card.speaker ?? card.title);
  const el = svg('svg', { class: 'portrait', viewBox: '0 0 100 100', 'aria-hidden': 'true' },
    svg('circle', { cx: '50', cy: '50', r: '48', fill: `hsl(${hue} 70% 94%)` }),
    svg('path', { d: blobPath(seed), fill: `hsl(${hue} 70% 86%)` }),
    svg('path', { d: blobPath(seed ^ 0x9e3779b9), fill: `hsl(${hue} 65% 78%)`, transform: 'translate(50 50) scale(0.72) translate(-50 -50)', opacity: '0.9' }),
    svg('text', { x: '50', y: '58', 'text-anchor': 'middle', 'font-size': '30', 'font-weight': '800', fill: `hsl(${hue} 45% 30%)`, 'font-family': 'inherit' }, initialsOf(card)));
  return el;
}

/** The eyebrow (DESIGN.md 17: "INVESTOR" / "EVENT"; the CSS sets the case). */
function kindLabel(card: Card): string {
  switch (card.kind) {
    case 'event': return 'Event';
    case 'maturity': return 'The bank';
    case 'desperation': return 'Last resort';
    default: return 'Investor';
  }
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** The two investor card kinds, the ones that sell a slice (DESIGN.md 0: dilution math on cards). */
function isInvestorCard(card: Card): boolean {
  return card.kind === 'knock' || card.kind === 'desperation';
}

/** What a choice is called in the coach badge: "take it" for the money, "pass" for the decline, else the choice's own words. */
function coachVerb(choice: CardChoice): string {
  if (choice.id === 'equity' || choice.id === 'loan') return 'take it';
  if (choice.id === 'decline') return 'pass';
  const label = choice.label;
  // keep an acronym's capitals ("PR push"); lower the first letter of a plain phrase ("Press them")
  return /^[A-Z][A-Z]/.test(label) ? label : label.charAt(0).toLowerCase() + label.slice(1);
}

/**
 * DESIGN.md 0 (v2): before → after on every investor card. The value after the round is
 * today's value plus the cash that lands (the floor and the operating value both carry
 * cash one for one, DESIGN.md 10); your share multiplies by (1 − share sold); the stake
 * is the product. Null when the card has nothing to raise (amount 0).
 */
function dilutionBlock(state: GameState, card: Card): HTMLElement | null {
  const amount = num(card.data.amount);
  const share = num(card.data.share);
  if (amount < 1 || share <= 0) return null;
  const value = Math.max(0, state.valuation.value);
  const own = state.founderShare;
  const ownAfter = own * (1 - share);
  const valueAfter = value + amount;
  const row = (label: string, before: string, after: string, up: boolean): HTMLElement =>
    h('div', { class: 'dil-row' },
      h('span', { class: 'dil-label', text: label }),
      h('span', { class: 'dil-before', text: before }),
      h('span', { class: 'dil-arrow', text: '→', attrs: { 'aria-hidden': 'true' } }),
      h('span', { class: `dil-after ${up ? 'pos' : 'neg'}`, text: after }));
  const block = h('div', {
    class: 'dilution',
    attrs: { role: 'group', 'aria-label': 'Before and after the round' },
    title: `You own ${percent(own)} → ${percent(ownAfter)}. Your stake today ${money(value * own)} → ${money(valueAfter * ownAfter)}. Value ${money(value)} → ${money(valueAfter)}.`,
  },
  row('You own', percent(own), percent(ownAfter), false),
  row('Your stake today', money(value * own), money(valueAfter * ownAfter), valueAfter * ownAfter >= value * own),
  row('Value', money(value), money(valueAfter), true));
  return block;
}

export function createCards(controller: ShellController, layer: HTMLElement): CardsUi {
  let shownCardId: string | null = null;
  let hiddenCardId: string | null = null;
  const modal = h('div', { class: 'modal-backdrop' });

  function renderCard(state: GameState, card: Card): void {
    modal.className = `modal-backdrop kind-${card.kind}`;
    const advice = adviseCard(state, card);
    const recommended = advice ? card.choices.find((c) => c.id === advice.choiceId && !c.disabled) ?? null : null;
    const investor = isInvestorCard(card);

    const choices = h('div', { class: 'choices' });
    let primaryGiven = false;
    for (const c of card.choices) {
      // DESIGN.md 0 (v2): the decline on an investor card reads "Keep 69%"
      const label = investor && c.id === 'decline' ? `Keep ${percent(state.founderShare)}` : c.label;
      const isCoach = recommended !== null && c.id === recommended.id;
      // DESIGN.md 17: the recommended choice green, the other blue (the first money choice) or grey
      let tone: string;
      if (isCoach) tone = 'is-coach';
      else if (!primaryGiven && c.id !== 'decline' && !c.disabled) tone = 'primary';
      else tone = 'secondary';
      if (tone === 'primary') primaryGiven = true;
      const btn = h('button', { class: `choice ${tone}${c.disabled ? ' is-disabled' : ''}`, type: 'button', disabled: !!c.disabled, onClick: () => {
        if (c.disabled) return;
        controller.dispatch({ type: 'card', choiceId: c.id });
      } },
      h('span', { class: 'choice-text' },
        h('b', { text: label }),
        c.detail ? h('small', { text: c.detail }) : null,
        c.disabled && c.reason ? h('span', { class: 'vreason', text: c.reason }) : null),
      isCoach ? h('span', { class: 'choice-mark', attrs: { 'aria-label': "the coach's pick" } }, icon('trophy')) : null);
      choices.appendChild(btn);
    }

    // DESIGN.md 17: the coach badge, a pill with the trophy icon and "Coach: take it · <reason>"
    const badge = advice && recommended
      ? h('div', { class: 'coach-badge' },
        icon('trophy'),
        h('span', { class: 'coach-badge-text' },
          h('b', { text: `Coach: ${coachVerb(recommended)}` }),
          advice.reason ? ` · ${advice.reason}` : ''))
      : null;

    modal.replaceChildren(h('div', { class: 'modal card', attrs: { role: 'dialog', 'aria-modal': 'true' } },
      h('div', { class: 'card-top' },
        portrait(card),
        h('div', { class: 'card-titles' },
          h('div', { class: 'card-kind', text: kindLabel(card) }),
          h('h2', { class: 'card-title', text: card.title }),
          card.speaker ? h('div', { class: 'card-speaker', text: card.speaker }) : null)),
      card.quote ? h('blockquote', { class: 'card-quote', text: `“${card.quote}”` }) : null,
      h('p', { class: 'card-body', text: card.body }),
      investor ? dilutionBlock(state, card) : null,
      badge,
      choices,
      // DESIGN.md 0: cards stop the game clock, not the countdown; a slow decision costs game months.
      h('div', { class: 'card-foot' },
        h('span', { class: 'card-clock-note', text: 'Game time is stopped while this card waits. The countdown is not.' }),
        h('button', { class: 'link', type: 'button', text: 'Look around first', onClick: () => hide(card.id) }))));
  }

  function hide(cardId: string): void {
    hiddenCardId = cardId;
    shownCardId = null;
    modal.remove();
  }

  function update(state: GameState): void {
    const card = state.status === 'playing' ? state.card : null;
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
      renderCard(state, card);
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
