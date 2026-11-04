/**
 * The control board at the bottom of the column (DESIGN.md 0, 17): one tile per
 * department in RULES.roles — icon in a tinted circle, name and headcount line, − (let
 * the most recent hire go) pale, + filled in the department colour with the salary and
 * a caption for what the hire triggers (setup, a room's rent, the second floor) — then
 * the two asset tiles: servers (grey-blue) and the demo room (purple). The tile the coach
 * points at pulses and carries a "coach" chip (DESIGN.md 0, 18). Built once and patched
 * on every state change; a disabled button keeps taking taps so it can say why (the
 * sim's reason, as a toast). The click sound on an accepted action is the controller's
 * (DESIGN.md 19), so nothing here plays audio. Every tile carries a data-tour id for the
 * first-start tour (DESIGN.md 18).
 */
import { CONFIG, ROLE_JOB, ROLE_LABEL, RULES, advise, headcount, hireCosts, lastHire, selectors } from '../../sim';
import type { Action, GameState, Role, Verdict } from '../../sim';
import type { ShellController } from '../controller';
import { money, plural } from '../format';
import { ROLE_ICON, icon } from '../icons';
import type { IconName } from '../icons';
import { h } from './dom';
import type { Child } from './dom';

export interface Board {
  el: HTMLElement;
  /** Patch every row from state; called on state change only. */
  update(state: GameState): void;
}

/** What a tile is keyed on for the coach's pulse: advise(state).target. */
type TileKey = Role | 'server' | 'demo';

interface Gate {
  verdict: Verdict;
  action: Action;
}

interface GatedButton {
  el: HTMLButtonElement;
  set(gate: Gate): void;
}

/**
 * A board button. It is never natively disabled: a refused action keeps its tap so the
 * sim's reason can be toasted (DESIGN.md 13: "disabled with a reason").
 */
function gatedButton(controller: ShellController, cls: string, ariaLabel: string, ...content: Child[]): GatedButton {
  let gate: Gate | null = null;
  const el = h('button', {
    class: `board-btn ${cls}`,
    type: 'button',
    attrs: { 'aria-label': ariaLabel },
    onClick: () => {
      if (!gate) return;
      if (gate.verdict.ok) controller.dispatch(gate.action);
      else controller.toast(gate.verdict.reason ?? 'Not available right now.', 'bad');
    },
  }, ...content);
  return {
    el,
    set(next) {
      gate = next;
      el.classList.toggle('is-disabled', !next.verdict.ok);
      el.setAttribute('aria-disabled', next.verdict.ok ? 'false' : 'true');
    },
  };
}

function jobWord(role: Role): string {
  return ROLE_JOB[role].toLowerCase();
}

/** "an engineer", "a sales rep". */
function aJob(role: Role): string {
  const word = jobWord(role);
  return `${/^[aeiou]/.test(word) ? 'an' : 'a'} ${word}`;
}

/**
 * What a hire into a role triggers today, in dollars: desk and laptop capex, a new room's
 * monthly rent, the second floor's one-off price when the ground floor is full (DESIGN.md 0
 * v2). Read straight from the sim's hireCosts, the same record canHireRole prices the hire on.
 */
type HireCosts = ReturnType<typeof hireCosts>;

/** The caption's items, e.g. "setup $3k", "room $4.5k/mo", "+ $60k upstairs". */
function captionItems(costs: HireCosts): string[] {
  const items: string[] = [];
  if (costs.setup > 0) items.push(`setup ${money(costs.setup)}`);
  if (costs.rent > 0) items.push(`room ${money(costs.rent)}/mo`);
  if (costs.upstairs > 0) items.push(`+ ${money(costs.upstairs)} upstairs`);
  return items;
}

interface Tile {
  el: HTMLElement;
  key: TileKey;
  update(state: GameState): void;
}

/** DESIGN.md 17: the tile shell, with the coach chip every tile carries (shown while the coach points here). */
function tile(key: TileKey, cls: string, iconName: IconName, ...content: Child[]): HTMLElement {
  return h('div', { class: `tile ${cls}`, attrs: { 'data-key': key, 'data-tour': key } },
    h('span', { class: `tile-icon ${cls}`, attrs: { 'aria-hidden': 'true' } }, icon(iconName)),
    ...content,
    h('span', { class: 'coach-chip', text: 'coach', title: "The coach's pick" }));
}

function deptTile(controller: ShellController, role: Role): Tile {
  const spec = RULES.hire[role];
  const meta = h('span', { class: 'tile-meta' });
  const minus = gatedButton(controller, 'minus', `Let the newest ${jobWord(role)} go`, icon('personMinus'));
  const cap = h('small', { class: 'board-cap' });
  const plus = gatedButton(controller, `plus ${role}`, `Hire ${aJob(role)} at ${money(spec.salary)} a month`,
    h('b', { text: `+ ${money(spec.salary)}/mo` }), cap);
  const el = tile(role, `dept ${role}`, ROLE_ICON[role],
    h('span', { class: 'tile-main' }, h('b', { class: 'tile-name', text: ROLE_LABEL[role] }), meta),
    minus.el,
    plus.el);

  return {
    el,
    key: role,
    update(state) {
      const n = headcount(state, role);
      meta.textContent = `${plural(n, jobWord(role))} · ${money(n * spec.salary)}/mo`;

      const fire: Action = { type: 'fireRole', role };
      const fireV = controller.can(fire);
      minus.set({ verdict: fireV, action: fire });
      const last = lastHire(state, role);
      minus.el.title = last
        ? `Let ${last.name} go · ${money(selectors.severanceOf(state, last))} severance (${CONFIG.people.severanceMonths} months' salary)`
        : fireV.reason ?? 'Nobody to let go.';

      const hire: Action = { type: 'hireRole', role };
      const hireV = controller.can(hire);
      plus.set({ verdict: hireV, action: hire });
      const extras = captionItems(hireCosts(state, role));
      cap.textContent = extras.join(' · ');
      cap.hidden = extras.length === 0;
      plus.el.title = hireV.ok
        ? `Hire ${aJob(role)}: ${money(spec.salary)}/mo${extras.length ? `, plus ${extras.join(' and ')}` : ''}`
        : hireV.reason ?? 'Not available right now.';
    },
  };
}

function serverTile(controller: ShellController): Tile {
  const cfg = CONFIG.assets.catalogue.server;
  const meta = h('span', { class: 'tile-meta' });
  const btn = gatedButton(controller, 'buy server', `Buy a server for ${money(cfg.price)}`,
    h('b', { text: 'Buy' }), h('small', { class: 'board-cap', text: money(cfg.price) }));
  const el = tile('server', 'asset server', 'server',
    h('span', { class: 'tile-main' }, h('b', { class: 'tile-name', text: 'Servers' }), meta),
    btn.el);
  return {
    el,
    key: 'server',
    update(state) {
      const owned = selectors.serversOwned(state);
      const needed = selectors.serversNeeded(state);
      meta.textContent = `${owned} of ${needed} needed`;
      const short = owned < needed;
      el.classList.toggle('short', short);
      el.title = `One server per ${CONFIG.assets.customersPerServer} customers (${state.customers.length} now). Each missing server risks an outage every month.`;
      const buy: Action = { type: 'buyAsset', kind: 'server' };
      const v = controller.can(buy);
      btn.set({ verdict: v, action: buy });
      btn.el.title = v.ok ? `${money(cfg.price)} once. Profit sees ${money(cfg.price / cfg.lifeMonths)} a month of it.` : v.reason ?? '';
    },
  };
}

function demoTile(controller: ShellController): Tile {
  const cfg = CONFIG.assets.catalogue.demoRoom;
  const meta = h('span', { class: 'tile-meta', text: `Deals ×${CONFIG.assets.demoRoomMult}` });
  const cap = h('small', { class: 'board-cap', text: money(cfg.price) });
  const word = h('b', { text: 'Buy' });
  const btn = gatedButton(controller, 'buy demo', `Buy the demo room for ${money(cfg.price)}`, word, cap);
  const el = tile('demo', 'asset demo', 'screen',
    h('span', { class: 'tile-main' }, h('b', { class: 'tile-name', text: 'Demo room' }), meta),
    btn.el);
  return {
    el,
    key: 'demo',
    update(state) {
      const buy: Action = { type: 'buyDemoRoom' };
      const v = controller.can(buy);
      const built = selectors.hasDemoRoom(state);
      btn.set({ verdict: v, action: buy });
      el.classList.toggle('built', built);
      word.textContent = built ? 'Built' : 'Buy';
      cap.textContent = built ? 'no rent' : money(cfg.price);
      meta.textContent = built ? `Enterprise deals ×${CONFIG.assets.demoRoomMult}` : `Deals ×${CONFIG.assets.demoRoomMult}`;
      btn.el.title = built
        ? `Built. Enterprise deals ×${CONFIG.assets.demoRoomMult}.`
        : v.ok ? `${money(cfg.price)} once, no rent. Enterprise deals ×${CONFIG.assets.demoRoomMult}.` : v.reason ?? '';
    },
  };
}

export function createBoard(controller: ShellController): Board {
  const depts = RULES.roles.map((role) => deptTile(controller, role));
  const server = serverTile(controller);
  const demo = demoTile(controller);
  const tiles: Tile[] = [...depts, server, demo];

  const el = h('div', { class: 'board', attrs: { 'aria-label': 'Control board' } },
    ...depts.map((t) => t.el),
    h('div', { class: 'tile-pair', attrs: { 'data-tour': 'assets' } }, server.el, demo.el));

  function update(state: GameState): void {
    for (const t of tiles) t.update(state);
    // DESIGN.md 0, 18: the coach's recommended tile pulses and shows the chip
    const target = state.status === 'playing' ? advise(state).target : null;
    for (const t of tiles) t.el.classList.toggle('is-coach', target !== null && t.key === target);
  }

  return { el, update };
}
