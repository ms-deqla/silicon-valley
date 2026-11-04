/**
 * The result screen (DESIGN.md 0 and 12): when the buzzer sells the company or the cash
 * runs out, a full-column page with the company value, your share, the score, two lines
 * on what drove it (the valuation in force: floor or forecast; the why line), the final
 * leaderboard table (best of the day) and Play again. The controller posts the final
 * standing before any listener runs, so the table already carries this run when the
 * screen draws.
 */
import { CONFIG, whyLine } from '../sim';
import type { GameState, Result } from '../sim';
import type { ShellController } from './controller';
import { money, months, percent, plural } from './format';
import { leaderTable, longCaption, unposted, watchCaption } from './leaderstrip';
import { h } from './panels/dom';

export interface ResultScreen {
  /** Draw the screen when the run has ended; remove it when a new run starts. */
  update(state: GameState): void;
  destroy(): void;
}

export interface ResultHooks {
  /** A new round on the same world with the same name. */
  onPlayAgain(): void;
}

function stat(label: string, value: string, cls = ''): HTMLElement {
  return h('div', { class: `stat ${cls}`.trim() }, h('span', { class: 'stat-label', text: label }), h('b', { class: 'stat-value', text: value }));
}

/** Two lines on what drove the number: the valuation in force (DESIGN.md 10), then the why line (DESIGN.md 13). */
function explain(state: GameState, result: Result): [string, string] {
  const v = state.valuation;
  const first = result.kind === 'gameOver'
    ? `${result.reason} Running out of cash scores 0.`
    : v.floor >= v.operating
      ? `The value is the floor: cash, ${percent(CONFIG.valuation.arRecovery)} of receivables, ${percent(CONFIG.valuation.assetRecovery)} of assets at book and a team worth ${money(v.acquihire)}. The cash-flow forecast (${money(v.dcf)}) came to less.`
      : `The value is the cash-flow forecast plus net cash: ${money(v.runRate)}/mo of operating cash flow, growing ${percent(v.growth, 1)}/mo, at the ${percent(v.r, 1)} a year investors wanted.`;
  // At a month end the live book is empty, so the month just closed speaks for the bars.
  const atClose = state.day % CONFIG.time.daysPerMonth === 0 && state.history.length > 0;
  const whyState: GameState = atClose ? { ...state, book: state.history[state.history.length - 1] } : state;
  return [first, whyLine(whyState)];
}

export function createResult(controller: ShellController, layer: HTMLElement, hooks: ResultHooks): ResultScreen {
  let shown: Result | null = null;
  let unsubscribe: (() => void) | null = null;
  const screen = h('div', { class: 'result-screen', attrs: { role: 'dialog', 'aria-modal': 'true' } });

  function render(state: GameState, result: Result): void {
    unsubscribe?.();
    const sold = result.kind === 'sold';
    screen.className = `result-screen ${sold ? 'sold' : 'dead'}`;
    const [line1, line2] = explain(state, result);
    const value = sold ? result.offer : Math.max(0, state.valuation.value);

    const tableWrap = h('div', { class: 'lb-wrap' });
    const caption = h('p', { class: 'caption' });
    caption.hidden = true;

    screen.replaceChildren(
      h('div', { class: 'result-kind', text: sold ? 'The buzzer' : 'Game over' }),
      h('h1', { class: 'result-headline', text: sold ? "Time's up" : 'Out of cash' }),
      h('div', { class: 'result-stats' },
        stat('Company value', money(value)),
        stat('Your share', percent(result.founderShare, 1)),
        stat('Score · value × your share', money(result.score), 'big')),
      h('div', { class: 'result-why' }, h('p', { text: line1 }), h('p', { text: line2 })),
      h('section', { class: 'sec' }, h('h3', { class: 'sec-title', text: "Today's world" }), tableWrap, caption),
      h('p', { class: 'result-meta', text: `${months(state.history.length)} played · ${plural(state.customers.length, 'customer')} · ${plural(state.people.length, 'person', 'people')} · world ${state.seed}` }),
      h('div', { class: 'result-actions' },
        h('button', { class: 'btn primary again', type: 'button', text: 'Play again', onClick: () => hooks.onPlayAgain() }),
        h('p', { class: 'caption', text: 'Same world, same name. A new run replaces this score on the board.' })));

    const lb = controller.leaderboard;
    const offTable = lb.subscribe((entries) => {
      tableWrap.replaceChildren(leaderTable(entries, { unposted: unposted(lb) }));
    });
    const offCaption = watchCaption(lb, caption, longCaption);
    unsubscribe = () => {
      offTable();
      offCaption();
    };
  }

  function remove(): void {
    unsubscribe?.();
    unsubscribe = null;
    screen.remove();
  }

  function update(state: GameState): void {
    if (state.status === 'playing' || !state.result) {
      if (shown) {
        shown = null;
        remove();
      }
      return;
    }
    if (shown !== state.result) {
      shown = state.result;
      render(state, state.result);
    }
    if (!screen.isConnected) layer.appendChild(screen);
  }

  return {
    update,
    destroy() {
      shown = null;
      remove();
    },
  };
}
