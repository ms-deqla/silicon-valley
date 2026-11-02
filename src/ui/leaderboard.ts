/**
 * Local leaderboard: localStorage only, top 10 by score (DESIGN.md 12).
 */
import { money, months } from './format';
import { h } from './panels/dom';

export interface LeaderboardEntry {
  name: string;
  score: number;
  seed: number;
  /** ISO date of the run */
  date: string;
  months: number;
  company?: string;
}

const KEY = 'brightbyte.leaderboard.v1';
export const LEADERBOARD_SIZE = 10;

function isEntry(x: unknown): x is LeaderboardEntry {
  if (!x || typeof x !== 'object') return false;
  const e = x as Record<string, unknown>;
  return typeof e.name === 'string' && typeof e.score === 'number' && typeof e.seed === 'number' && typeof e.date === 'string' && typeof e.months === 'number';
}

export function loadLeaderboard(): LeaderboardEntry[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isEntry).sort((a, b) => b.score - a.score).slice(0, LEADERBOARD_SIZE);
  } catch {
    return [];
  }
}

/** Adds an entry and returns the new top list; storage failures are swallowed (private mode). */
export function saveToLeaderboard(entry: LeaderboardEntry): LeaderboardEntry[] {
  const list = [...loadLeaderboard(), entry].sort((a, b) => b.score - a.score).slice(0, LEADERBOARD_SIZE);
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // storage unavailable: the list still shows for this session
  }
  return list;
}

export function clearLeaderboard(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}

export function renderLeaderboard(list: LeaderboardEntry[] = loadLeaderboard()): HTMLElement {
  if (list.length === 0) return h('p', { class: 'note muted', text: 'No runs saved yet. Sell a company to post a score.' });
  const table = h('table', { class: 'table lb' },
    h('thead', {}, h('tr', {}, h('th', { text: '#' }), h('th', { text: 'Name' }), h('th', { text: 'Score' }), h('th', { text: 'Months' }), h('th', { text: 'Seed' }), h('th', { text: 'Date' }))),
    h('tbody', {}, ...list.map((e, i) => h('tr', {},
      h('td', { text: String(i + 1) }),
      h('td', { class: 'lb-name', text: e.name || 'Anonymous' }),
      h('td', { text: money(e.score) }),
      h('td', { text: months(e.months) }),
      h('td', { class: 'mono', text: String(e.seed) }),
      h('td', { text: e.date.slice(0, 10) })))));
  return h('div', { class: 'table-wrap' }, table);
}
