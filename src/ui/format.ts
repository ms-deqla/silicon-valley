/**
 * Number and label formatting for the shell. Pure functions, no DOM, so they run
 * under Vitest (test/unit-format.test.ts).
 */

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

/** Stable 32-bit FNV-1a hash for cosmetic choices (names, blob shapes). Not game randomness. */
export function hashText(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const CUSTOMER_NAMES = [
  'Northwind', 'Globex', 'Initech', 'Hooli', 'Vandelay', 'Acme', 'Stark', 'Wayne', 'Umbrella', 'Tyrell',
  'Aperture', 'Cyberdyne', 'Dunder', 'Oscorp', 'Wonka', 'Soylent', 'Massive', 'Pied Piper', 'Gringotts', 'Bluth',
  'Sterling', 'Prestige', 'Octan', 'Monarch', 'Zorg', 'Virtucon', 'Oceanic', 'Nakatomi', 'Weyland', 'Gekko',
];

/** Cosmetic customer name derived from its id (deterministic, UI only). */
export function customerName(id: string): string {
  const n = CUSTOMER_NAMES[hashText(id) % CUSTOMER_NAMES.length];
  const num = id.replace(/\D/g, '');
  return num ? `${n} #${num}` : n;
}
