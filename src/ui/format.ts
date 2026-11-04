/**
 * Number and label formatting for the shell, plus the few derived numbers the shell
 * draws that the sim does not keep (the cap table, the stake over time). Pure
 * functions, no DOM, so they run under Vitest (test/unit-format.test.ts).
 */
import { CONFIG } from '../sim';
import type { GameState, Round } from '../sim';

/** Typographic minus, so negatives read as −$6k rather than -$6k. */
export const MINUS = '−';

function trim1(x: number): string {
  return (Math.round(x * 10) / 10).toFixed(1).replace(/\.0$/, '');
}

function absMoney(a: number): string {
  if (a < 999.5) return `$${Math.round(a)}`;
  if (a < 999_500) {
    const k = a / 1000;
    return k < 9.95 ? `$${trim1(k)}k` : `$${Math.round(k)}k`;
  }
  const m = a / 1_000_000;
  if (m < 9.95) return `$${trim1(m)}M`;
  if (m < 999.5) return `$${Math.round(m)}M`;
  return `$${trim1(m / 1000)}B`;
}

/** $50k / $1.2M / −$6k — one decimal under $10k and under $10M, whole numbers otherwise. */
export function money(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (Math.abs(n) < 0.5) return '$0';
  const s = absMoney(Math.abs(n));
  return n < 0 ? MINUS + s : s;
}

/** +$5k / −$6k / $0. */
export function signedMoney(n: number): string {
  if (!Number.isFinite(n) || Math.abs(n) < 0.5) return '$0';
  return n > 0 ? `+${money(n)}` : money(n);
}

/** Whole dollars with thousands separators: $3,000. */
export function moneyFull(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const r = Math.round(Math.abs(n));
  const s = `$${String(r).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
  return n < 0 && r > 0 ? MINUS + s : s;
}

/** 0.24 → 24%; 0.1234 with one digit → 12.3%. */
export function percent(x: number, digits = 0): string {
  if (!Number.isFinite(x)) return '—';
  const v = Math.abs(x * 100).toFixed(digits);
  const neg = x < 0 && Number(v) > 0;
  return `${neg ? MINUS : ''}${v}%`;
}

/** 1 → "1 month", 7.5 → "7.5 months". */
export function months(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const v = Math.round(n * 10) / 10;
  return `${v} ${v === 1 ? 'month' : 'months'}`;
}

/** 1 → "1 day", 12 → "12 days". */
export function days(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const v = Math.round(n);
  return `${v} ${v === 1 ? 'day' : 'days'}`;
}

/** Invoice due-date wording relative to today: "due in 12 days" / "due today" / "late by 3 days". */
export function dueText(dueDay: number, today: number): string {
  if (dueDay < today) return `late by ${days(today - dueDay)}`;
  if (dueDay === today) return 'due today';
  return `due in ${days(dueDay - today)}`;
}

/** Skill 1..5 with at most one decimal. */
export function skillText(skill: number): string {
  return trim1(skill);
}

/** 2 → "2 engineers", 1 → "1 engineer", 0 → "0 engineers". */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * The round countdown as m:ss from milliseconds (DESIGN.md 0), rounded up so the
 * display reads 10:00 at the start and 0:01 until the clock really hits zero.
 */
export function clock(ms: number): string {
  const s = Math.max(0, Math.ceil((Number.isFinite(ms) ? ms : 0) / 1000));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

/** Stable 32-bit FNV-1a hash for cosmetic choices (names, blob shapes). Not game randomness. */
export function hashText(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Initials for a name that must fit a tiny label: the first letter of each word, small
 * words dropped, at most three. "Horizon Ventures" → "HV", "Ember & Oak" → "EO",
 * "Round 2" → "R2".
 */
const SMALL_WORDS = new Set(['a', 'an', 'the', 'of', 'and', 'at', 'for', 'in', 'on']);

export function initials(name: string, max = 3): string {
  const words = name.split(/[^A-Za-z0-9]+/).filter((w) => w && !SMALL_WORDS.has(w.toLowerCase()));
  const s = words.slice(0, max).map((w) => w[0].toUpperCase()).join('');
  return s || '?';
}

// ---------------------------------------------------------------- the cap table

export interface CapEntry {
  kind: 'you' | 'round';
  /** "You", or the fund's name when the log still has it, else "Round N" */
  label: string;
  initials: string;
  /** share of the company today, 0..1 */
  share: number;
  /** the equity round this slice came from; null for you */
  round: Round | null;
  /** 1-based round number; 0 for you */
  number: number;
}

/**
 * The fund behind a round, read from the log line capital.ts writes when the round
 * closes ("<fund> invested $X for Y%."): the sim keeps no fund on a Round. Null when
 * the line is gone (the log is capped) or was never there.
 */
export function fundOfRound(state: GameState, index: number): string | null {
  const round = state.rounds[index];
  if (!round) return null;
  // the k-th round of that day pairs with the k-th "invested" line of that day
  let k = 0;
  for (let i = 0; i < index; i++) if (state.rounds[i].day === round.day) k += 1;
  const lines = state.log.filter((e) => e.day === round.day && / invested \$/.test(e.text));
  const line = lines[k];
  if (!line) return null;
  const m = /^(.+?) invested \$/.exec(line.text);
  return m ? m[1] : null;
}

/**
 * Who owns the company today (DESIGN.md 0, "Your stake"): you first, then every
 * equity round in order. A round's share today is what it bought, diluted by every
 * round after it, so the slices add up to one and yours equals state.founderShare.
 */
export function capTable(state: GameState): CapEntry[] {
  const rounds = state.rounds;
  const entries: CapEntry[] = [{ kind: 'you', label: 'You', initials: 'You', share: state.founderShare, round: null, number: 0 }];
  for (let i = 0; i < rounds.length; i++) {
    let share = rounds[i].shareSold;
    for (let j = i + 1; j < rounds.length; j++) share *= 1 - rounds[j].shareSold;
    const fund = fundOfRound(state, i);
    const label = fund ?? `Round ${i + 1}`;
    entries.push({ kind: 'round', label, initials: initials(label), share, round: rounds[i], number: i + 1 });
  }
  return entries;
}

/**
 * The founder's share at the close on `closeDay`: every round signed before that day applied.
 * A round signed on a close day comes after that close (the knock opens and the month closes
 * in the same tick; the answer lands in the new month), so it does not count yet.
 */
export function shareAtClose(state: GameState, closeDay: number): number {
  let share = 1;
  for (const r of state.rounds) if (r.day < closeDay) share *= 1 - r.shareSold;
  return share;
}

/**
 * Your stake at each point of state.valueHistory (value × your share then): the
 * last entry is the latest close (or day 0 before the first), each earlier entry one
 * month before. The HUD sparkline draws this (DESIGN.md 0: the stake pill keeps the
 * sparkline, now of the stake).
 */
export function stakeHistory(state: GameState, daysPerMonth: number = CONFIG.time.daysPerMonth): number[] {
  const values = state.valueHistory;
  const closes = state.history.length;
  return values.map((v, j) => {
    const monthsBack = values.length - 1 - j;
    const day = Math.max(0, closes - monthsBack) * daysPerMonth;
    return Math.max(0, v) * shareAtClose(state, day);
  });
}

/**
 * A customer's name: the one the sim's cards and log lines use, so the Books invoice
 * tray names the late payer exactly as the card did. One naming function for the whole
 * screen.
 */
export { customerName } from '../sim';
