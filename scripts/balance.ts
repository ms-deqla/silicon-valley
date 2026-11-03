/**
 * Balance harness (DESIGN.md section 16): every strategy × N seeds × M months, headless, then a
 * compact table, a pacing table, a five-year table and the DESIGN 16 targets (balance at month 36,
 * pacing, five-year guard at month 60) with PASS / FAIL.
 *
 *   pnpm balance                                   # 5 strategies × 200 seeds × 60 months
 *   pnpm balance --seeds 50 --months 36 --strategy balanced   # the five-year guard prints n/a
 *   pnpm balance --seed-base 1000 --strict        # --strict: exit code 1 when a target fails
 *
 * Dead runs count as $0 for value and score (the game over screen scores 0, DESIGN.md 12).
 * test/balance.test.ts imports the statistics and the target list from here and runs them at
 * small scale, so the doc, the harness and the test share one definition of every target.
 */
import { STRATEGIES, runStrategy, strategyList } from './strategies';
import type { MonthTrace, Pacing, Strategy } from './strategies';
import { CONFIG } from '../src/sim';

// tsx runs this under Node; the project has no Node typings, so declare the two things we touch.
declare const process: { argv: string[]; exitCode?: number };

const D = CONFIG.time.daysPerMonth;

export const DEFAULTS = { seeds: 200, months: 60, seedBase: 1 };

/** DESIGN.md 16 targets: balance at month 36, pacing, and the five-year guard at month 60 (medians over the seed set). */
export const TARGET = {
  /** the month every balance target is read at */
  month: 36,
  balancedSurvival: 0.70,
  recklessDeath: 0.50,
  idleValueMedianMax: 1_500_000,
  balancedScoreMin: 1_000_000,
  balancedScoreMax: 15_000_000,
  balancedScoreP90Max: 50_000_000,
  /** balanced median score ≥ this × idle median value */
  balancedOverIdle: 3,
  /** pacing: the idle founder ships the first feature by this day */
  idleFirstFeatureDay: 45,
  /** pacing: the idle founder has a paying customer by the end of this month */
  idleFirstCustomerMonth: 4,
  /** pacing: a balanced player has an enterprise prospect in the lobby by this month */
  balancedFirstProspectMonth: 6,
  /** pacing: a balanced player signs the first enterprise deal by this month */
  balancedFirstDealMonth: 9,
  /** pacing: the first investor knock lands in this month range (inclusive) */
  firstKnockMonths: [3, 8] as const,
  /** pacing: at most one event card per three months on average for a sane (balanced) player */
  balancedEventsPerMonth: 1 / 3,
  /** five-year guard (DESIGN.md 1): the month it is read at; balanced must still survive balancedSurvival there */
  guardMonth: 60,
  /** five-year guard: balanced median company value at guardMonth stays under this (a business, not a unicorn) */
  balancedValue60MedianMax: 75_000_000,
  /** five-year guard: balanced p90 company value at guardMonth stays under this */
  balancedValue60P90Max: 100_000_000,
  /** five-year guard: idle median value at guardMonth stays under this */
  idleValue60MedianMax: 2_000_000,
};

interface Args {
  seeds: number;
  months: number;
  strategy: string | null;
  seedBase: number;
  strict: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { seeds: DEFAULTS.seeds, months: DEFAULTS.months, strategy: null, seedBase: DEFAULTS.seedBase, strict: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string => {
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`${a} needs a value`);
      i += 1;
      return v;
    };
    const int = (v: string): number => {
      const n = Number.parseInt(v, 10);
      if (!Number.isFinite(n) || n <= 0) throw new Error(`${a}: expected a positive integer, got "${v}"`);
      return n;
    };
    switch (a) {
      case '--seeds': args.seeds = int(next()); break;
      case '--months': args.months = int(next()); break;
      case '--strategy': args.strategy = next(); break;
      case '--seed-base': args.seedBase = int(next()); break;
      case '--strict': args.strict = true; break;
      case '--help': case '-h':
        console.log('usage: pnpm balance [--seeds N] [--months M] [--strategy name] [--seed-base S] [--strict]');
        console.log(`strategies: ${strategyList.map((s) => s.name).join(', ')}`);
        process.exitCode = 0;
        throw new Error('help');
      default:
        throw new Error(`unknown argument ${a}`);
    }
  }
  if (args.strategy !== null && !STRATEGIES[args.strategy]) {
    throw new Error(`unknown strategy "${args.strategy}"; pick one of ${strategyList.map((s) => s.name).join(', ')}`);
  }
  return args;
}

// ---------------------------------------------------------------- runs

export interface RunRow {
  seed: number;
  status: 'playing' | 'gameOver' | 'sold' | 'error';
  /** closed months before the run ended */
  months: number;
  /** the day the run ended (the horizon, or the day of the game over) */
  endDay: number;
  trace: MonthTrace[];
  pacing: Pacing;
  equity: boolean;
  loan: boolean;
  error?: string;
}

function emptyPacing(): Pacing {
  return {
    firstFeatureDay: null, firstCustomerDay: null, firstProspectDay: null, firstDealDay: null,
    firstKnockDay: null, firstKnockKind: null,
    cards: { knock: 0, desperation: 0, maturity: 0, event: 0, gameOver: 0, sold: 0 },
  };
}

export function runOne(strategy: Strategy, seed: number, months: number): RunRow {
  try {
    const { state, trace, pacing } = runStrategy(seed, strategy, months, { drainVisuals: true });
    return {
      seed,
      status: state.status,
      months: state.history.length,
      endDay: state.day,
      trace,
      pacing,
      equity: state.rounds.length > 0,
      loan: state.loan !== null || state.history.some((b) => b.fin.loanIn > 0),
    };
  } catch (e) {
    return { seed, status: 'error', months: 0, endDay: 0, trace: [], pacing: emptyPacing(), equity: false, loan: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export function runRows(strategy: Strategy, seeds: readonly number[], months: number): RunRow[] {
  return seeds.map((seed) => runOne(strategy, seed, months));
}

// ---------------------------------------------------------------- statistics

export function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return Number.NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))];
}

export const median = (xs: number[]): number => percentile(xs, 0.5);

/** Was the run still alive after the close of month m? A game over on the close day of month m died at m; an error never survives. */
export function survivedTo(row: RunRow, m: number): boolean {
  if (row.status === 'error') return false;
  if (row.status === 'gameOver') return row.endDay > m * D;
  return true;
}

/** Value at the close of month m (1-based); $0 once dead; NaN when the horizon is shorter than m. */
function valueAt(row: RunRow, m: number, horizon: number): number {
  if (horizon < m) return Number.NaN;
  return row.trace[m - 1]?.value ?? 0;
}

function scoreAt(row: RunRow, m: number, horizon: number): number {
  if (horizon < m) return Number.NaN;
  return row.trace[m - 1]?.score ?? 0;
}

function shareAt(row: RunRow, m: number, horizon: number): number {
  if (horizon < m) return Number.NaN;
  return row.trace[m - 1]?.founderShare ?? 0;
}

function traceFieldAt(row: RunRow, m: number, horizon: number, field: 'customers' | 'people'): number {
  if (horizon < m) return Number.NaN;
  return row.trace[m - 1]?.[field] ?? 0;
}

/** 1-based calendar month a day falls in: day 1..30 → 1, day 31..60 → 2 (DESIGN.md 4). */
export function monthOfDay(day: number): number {
  return Math.max(1, Math.ceil(day / D));
}

export interface Quantiles {
  p10: number;
  med: number;
  p90: number;
}

/** Quantiles of a milestone over the runs; a run that never reached it counts as +∞. */
function quantiles(xs: (number | null)[]): Quantiles {
  const v = xs.map((x) => (x === null ? Number.POSITIVE_INFINITY : x));
  return { p10: percentile(v, 0.1), med: median(v), p90: percentile(v, 0.9) };
}

export interface PacingStats {
  /** day the first feature shipped */
  firstFeatureDay: Quantiles;
  /** month (1-based) of the first paying customer */
  firstCustomerMonth: Quantiles;
  firstProspectMonth: Quantiles;
  firstDealMonth: Quantiles;
  /** month of the first investor card of any kind */
  firstKnockMonth: Quantiles;
  /** share of runs whose first investor card was a desperation knock */
  firstKnockDesperate: number;
  /** event cards per closed month, averaged over the runs */
  eventsPerMonth: number;
  /** cards per run, averaged */
  knocksPerRun: number;
  desperationsPerRun: number;
  eventsPerRun: number;
}

function pacingOf(rows: RunRow[]): PacingStats {
  const n = rows.length;
  const month = (d: number | null): number | null => (d === null ? null : monthOfDay(d));
  const avg = (f: (r: RunRow) => number): number => (n ? rows.reduce((s, r) => s + f(r), 0) / n : Number.NaN);
  const withKnock = rows.filter((r) => r.pacing.firstKnockDay !== null);
  return {
    firstFeatureDay: quantiles(rows.map((r) => r.pacing.firstFeatureDay)),
    firstCustomerMonth: quantiles(rows.map((r) => month(r.pacing.firstCustomerDay))),
    firstProspectMonth: quantiles(rows.map((r) => month(r.pacing.firstProspectDay))),
    firstDealMonth: quantiles(rows.map((r) => month(r.pacing.firstDealDay))),
    firstKnockMonth: quantiles(rows.map((r) => month(r.pacing.firstKnockDay))),
    firstKnockDesperate: withKnock.length ? withKnock.filter((r) => r.pacing.firstKnockKind === 'desperation').length / withKnock.length : Number.NaN,
    // a run that ended early still played its closed months; a run with no closed month has no rate
    eventsPerMonth: avg((r) => (r.months > 0 ? r.pacing.cards.event / r.months : 0)),
    knocksPerRun: avg((r) => r.pacing.cards.knock),
    desperationsPerRun: avg((r) => r.pacing.cards.desperation),
    eventsPerRun: avg((r) => r.pacing.cards.event),
  };
}

export interface Summary {
  name: string;
  n: number;
  /** share of runs alive at the end of the horizon */
  survival: number;
  death: number;
  errors: number;
  monthsP10: number;
  monthsMed: number;
  /** share of runs alive after the close of TARGET.month (NaN when the horizon is shorter) */
  survival36: number;
  death36: number;
  /** the table's survive/die columns: at TARGET.month, or at the horizon when that is shorter */
  shownMonth: number;
  survivalShown: number;
  deathShown: number;
  value24: number;
  /** median value at TARGET.month */
  valueMed: number;
  /** p10 / median / p90 score at TARGET.month */
  scoreP10: number;
  scoreMed: number;
  scoreP90: number;
  /** median founder share at TARGET.month */
  shareMed: number;
  /** five-year guard, read at TARGET.guardMonth (NaN when the horizon is shorter) */
  survival60: number;
  value60P10: number;
  value60Med: number;
  value60P90: number;
  score60P10: number;
  score60Med: number;
  score60P90: number;
  customers60Med: number;
  people60Med: number;
  equityRate: number;
  loanRate: number;
  pacing: PacingStats;
  seconds: number;
}

export function summarize(name: string, rows: RunRow[], horizon: number, seconds = 0): Summary {
  const n = rows.length;
  const dead = rows.filter((r) => r.status === 'gameOver').length;
  const errors = rows.filter((r) => r.status === 'error').length;
  const months = rows.map((r) => r.months);
  const m = TARGET.month;
  const g = TARGET.guardMonth;
  const score = rows.map((r) => scoreAt(r, m, horizon));
  const score60 = rows.map((r) => scoreAt(r, g, horizon));
  const value60 = rows.map((r) => valueAt(r, g, horizon));
  const survivalAt = (month: number): number => (n && horizon >= month ? rows.filter((r) => survivedTo(r, month)).length / n : Number.NaN);
  const deathAt = (month: number): number => (n && horizon >= month ? rows.filter((r) => r.status === 'gameOver' && !survivedTo(r, month)).length / n : Number.NaN);
  return {
    name,
    n,
    survival: n ? (n - dead - errors) / n : Number.NaN,
    death: n ? dead / n : Number.NaN,
    errors,
    monthsP10: percentile(months, 0.1),
    monthsMed: median(months),
    survival36: survivalAt(m),
    death36: deathAt(m),
    shownMonth: Math.min(m, horizon),
    survivalShown: survivalAt(Math.min(m, horizon)),
    deathShown: deathAt(Math.min(m, horizon)),
    value24: median(rows.map((r) => valueAt(r, 24, horizon))),
    valueMed: median(rows.map((r) => valueAt(r, m, horizon))),
    scoreP10: percentile(score, 0.1),
    scoreMed: median(score),
    scoreP90: percentile(score, 0.9),
    shareMed: median(rows.map((r) => shareAt(r, m, horizon))),
    survival60: survivalAt(g),
    value60P10: percentile(value60, 0.1),
    value60Med: median(value60),
    value60P90: percentile(value60, 0.9),
    score60P10: percentile(score60, 0.1),
    score60Med: median(score60),
    score60P90: percentile(score60, 0.9),
    customers60Med: median(rows.map((r) => traceFieldAt(r, g, horizon, 'customers'))),
    people60Med: median(rows.map((r) => traceFieldAt(r, g, horizon, 'people'))),
    equityRate: n ? rows.filter((r) => r.equity).length / n : Number.NaN,
    loanRate: n ? rows.filter((r) => r.loan).length / n : Number.NaN,
    pacing: pacingOf(rows),
    seconds,
  };
}

// ---------------------------------------------------------------- printing

export function money(x: number): string {
  if (!Number.isFinite(x)) return 'n/a';
  const sign = x < 0 ? '-' : '';
  const abs = Math.abs(x);
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(0)}k`;
  return `${sign}$${abs.toFixed(0)}`;
}

function pct(x: number): string {
  return Number.isFinite(x) ? `${(x * 100).toFixed(0)}%` : 'n/a';
}

function num(x: number): string {
  if (Number.isNaN(x)) return 'n/a';
  if (!Number.isFinite(x)) return 'never';
  return x.toFixed(0);
}

function q(v: Quantiles): string {
  return `${num(v.p10)}/${num(v.med)}/${num(v.p90)}`;
}

function table(rows: string[][]): string {
  const widths: number[] = [];
  for (const row of rows) row.forEach((cell, i) => { widths[i] = Math.max(widths[i] ?? 0, cell.length); });
  return rows
    .map((row) => row.map((cell, i) => (i === 0 ? cell.padEnd(widths[i]) : cell.padStart(widths[i]))).join('  '))
    .join('\n');
}

function printTable(summaries: Summary[], horizon: number): void {
  const m = TARGET.month;
  const shown = Math.min(m, horizon);
  const header = ['strategy', 'runs', `survive@${shown}`, `die@${shown}`, 'err', 'months p10/med', 'value@24', `value@${m}`, `score@${m} p10/med/p90`, `share@${m}`, 'equity', 'loan', 'time'];
  const rows = summaries.map((s) => [
    s.name,
    String(s.n),
    pct(s.survivalShown),
    pct(s.deathShown),
    String(s.errors),
    `${num(s.monthsP10)}/${num(s.monthsMed)}`,
    money(s.value24),
    money(s.valueMed),
    `${money(s.scoreP10)}/${money(s.scoreMed)}/${money(s.scoreP90)}`,
    pct(s.shareMed),
    pct(s.equityRate),
    pct(s.loanRate),
    `${s.seconds.toFixed(1)}s`,
  ]);
  console.log(table([header, ...rows]));
  console.log(`(horizon ${horizon} months; medians over seeds; dead runs count as $0 for value and score; months = closed months before the run ended)`);
}

function printPacing(summaries: Summary[]): void {
  const header = ['pacing (p10/med/p90)', 'feature day', 'customer month', 'prospect month', 'deal month', 'knock month', 'desperate first', 'events/month', 'cards/run knock+desp+event'];
  const rows = summaries.map((s) => {
    const p = s.pacing;
    return [
      s.name,
      q(p.firstFeatureDay),
      q(p.firstCustomerMonth),
      q(p.firstProspectMonth),
      q(p.firstDealMonth),
      q(p.firstKnockMonth),
      pct(p.firstKnockDesperate),
      Number.isFinite(p.eventsPerMonth) ? p.eventsPerMonth.toFixed(2) : 'n/a',
      `${p.knocksPerRun.toFixed(1)}+${p.desperationsPerRun.toFixed(1)}+${p.eventsPerRun.toFixed(1)}`,
    ];
  });
  console.log('\n' + table([header, ...rows]));
  console.log('(first feature / customer / enterprise prospect / signed deal / investor card over the seed set; "never" = not reached by the horizon)');
}

function printFiveYear(summaries: Summary[], horizon: number): void {
  const g = TARGET.guardMonth;
  if (horizon < g) {
    console.log(`\n(five-year table and guard need --months ${g}; horizon is ${horizon})`);
    return;
  }
  const header = [`five-year (month ${g})`, `survive@${g}`, `value@${g} p10/med/p90`, `score@${g} p10/med/p90`, `customers@${g}`, `people@${g}`];
  const rows = summaries.map((s) => [
    s.name,
    pct(s.survival60),
    `${money(s.value60P10)}/${money(s.value60Med)}/${money(s.value60P90)}`,
    `${money(s.score60P10)}/${money(s.score60Med)}/${money(s.score60P90)}`,
    num(s.customers60Med),
    num(s.people60Med),
  ]);
  console.log('\n' + table([header, ...rows]));
  console.log('(DESIGN.md 1: a five-year run is playable without trivially winning or dying; medians over seeds, dead runs count as $0)');
}

export interface Target {
  label: string;
  actual: string;
  /** null = not evaluated (strategy not run or horizon too short) */
  pass: boolean | null;
}

/** The DESIGN.md 16 target list (balance, pacing, five-year guard), evaluated on the summaries at hand. */
export function evaluateTargets(summaries: Summary[], horizon: number): Target[] {
  const by = (name: string): Summary | undefined => summaries.find((s) => s.name === name);
  const balanced = by('balanced');
  const reckless = by('reckless');
  const idle = by('idle');
  const T = TARGET;
  const m = T.month;
  const atMonth = horizon >= m;
  const short = `horizon ${horizon} < ${m} months`;
  const out: Target[] = [];

  out.push({
    label: `balanced survives ≥ ${pct(T.balancedSurvival)} over ${m} months`,
    actual: balanced ? (atMonth ? pct(balanced.survival36) : short) : 'not run',
    pass: balanced && atMonth ? balanced.survival36 >= T.balancedSurvival : null,
  });
  out.push({
    label: `reckless dies ≥ ${pct(T.recklessDeath)} over ${m} months`,
    actual: reckless ? (atMonth ? pct(reckless.death36) : short) : 'not run',
    pass: reckless && atMonth ? reckless.death36 >= T.recklessDeath : null,
  });
  out.push({
    label: 'idle never dies',
    actual: idle ? `${pct(idle.death)} died, ${idle.errors} threw` : 'not run',
    pass: idle ? idle.death === 0 && idle.errors === 0 : null,
  });
  out.push({
    label: `idle median value at month ${m} under ${money(T.idleValueMedianMax)}`,
    actual: idle ? (atMonth ? money(idle.valueMed) : short) : 'not run',
    pass: idle && atMonth ? idle.valueMed < T.idleValueMedianMax : null,
  });
  out.push({
    label: `balanced median score at month ${m} in [${money(T.balancedScoreMin)}, ${money(T.balancedScoreMax)}]`,
    actual: balanced ? (atMonth ? money(balanced.scoreMed) : short) : 'not run',
    pass: balanced && atMonth ? balanced.scoreMed >= T.balancedScoreMin && balanced.scoreMed <= T.balancedScoreMax : null,
  });
  out.push({
    label: `balanced p90 score at month ${m} under ${money(T.balancedScoreP90Max)}`,
    actual: balanced ? (atMonth ? money(balanced.scoreP90) : short) : 'not run',
    pass: balanced && atMonth ? balanced.scoreP90 < T.balancedScoreP90Max : null,
  });
  out.push({
    label: `balanced median score ≥ ${T.balancedOverIdle} × idle median value (month ${m})`,
    actual: balanced && idle ? (atMonth ? `${money(balanced.scoreMed)} vs ${T.balancedOverIdle} × ${money(idle.valueMed)}` : short) : 'not run',
    pass: balanced && idle && atMonth ? balanced.scoreMed >= T.balancedOverIdle * idle.valueMed : null,
  });

  // pacing: medians over the seed set, the first horizon months are enough
  const pacingHorizon = horizon >= T.balancedFirstDealMonth;
  const shortPacing = `horizon ${horizon} < ${T.balancedFirstDealMonth} months`;
  const medP90 = (v: Quantiles, unit: string): string => `median ${unit} ${num(v.med)} (p90 ${num(v.p90)})`;
  out.push({
    label: `idle ships the first feature by day ${T.idleFirstFeatureDay}`,
    actual: idle ? medP90(idle.pacing.firstFeatureDay, 'day') : 'not run',
    pass: idle ? idle.pacing.firstFeatureDay.med <= T.idleFirstFeatureDay : null,
  });
  out.push({
    label: `idle has a paying customer by the end of month ${T.idleFirstCustomerMonth}`,
    actual: idle ? medP90(idle.pacing.firstCustomerMonth, 'month') : 'not run',
    pass: idle ? idle.pacing.firstCustomerMonth.med <= T.idleFirstCustomerMonth : null,
  });
  out.push({
    label: `balanced has an enterprise prospect in the lobby by month ${T.balancedFirstProspectMonth}`,
    actual: balanced ? (pacingHorizon ? medP90(balanced.pacing.firstProspectMonth, 'month') : shortPacing) : 'not run',
    pass: balanced && pacingHorizon ? balanced.pacing.firstProspectMonth.med <= T.balancedFirstProspectMonth : null,
  });
  out.push({
    label: `balanced signs the first enterprise deal by month ${T.balancedFirstDealMonth}`,
    actual: balanced ? (pacingHorizon ? medP90(balanced.pacing.firstDealMonth, 'month') : shortPacing) : 'not run',
    pass: balanced && pacingHorizon ? balanced.pacing.firstDealMonth.med <= T.balancedFirstDealMonth : null,
  });
  const [kLo, kHi] = T.firstKnockMonths;
  out.push({
    label: `balanced's first investor knock lands between month ${kLo} and month ${kHi}`,
    actual: balanced
      ? (pacingHorizon ? `p10/median/p90 month ${q(balanced.pacing.firstKnockMonth)}, ${pct(balanced.pacing.firstKnockDesperate)} desperation first` : shortPacing)
      : 'not run',
    pass: balanced && pacingHorizon ? balanced.pacing.firstKnockMonth.med >= kLo && balanced.pacing.firstKnockMonth.med <= kHi : null,
  });
  out.push({
    label: `balanced sees at most one event card per ${Math.round(1 / T.balancedEventsPerMonth)} months on average`,
    actual: balanced ? `${balanced.pacing.eventsPerMonth.toFixed(2)} per month` : 'not run',
    pass: balanced ? balanced.pacing.eventsPerMonth <= T.balancedEventsPerMonth : null,
  });

  // five-year guard (DESIGN.md 1 and 16): read at guardMonth, n/a on a shorter horizon
  const g = T.guardMonth;
  const atGuard = horizon >= g;
  const shortGuard = `horizon ${horizon} < ${g} months`;
  out.push({
    label: `balanced survives ≥ ${pct(T.balancedSurvival)} over ${g} months`,
    actual: balanced ? (atGuard ? pct(balanced.survival60) : shortGuard) : 'not run',
    pass: balanced && atGuard ? balanced.survival60 >= T.balancedSurvival : null,
  });
  out.push({
    label: `balanced median value at month ${g} under ${money(T.balancedValue60MedianMax)}`,
    actual: balanced ? (atGuard ? money(balanced.value60Med) : shortGuard) : 'not run',
    pass: balanced && atGuard ? balanced.value60Med < T.balancedValue60MedianMax : null,
  });
  out.push({
    label: `balanced p90 value at month ${g} under ${money(T.balancedValue60P90Max)}`,
    actual: balanced ? (atGuard ? money(balanced.value60P90) : shortGuard) : 'not run',
    pass: balanced && atGuard ? balanced.value60P90 < T.balancedValue60P90Max : null,
  });
  out.push({
    label: `idle median value at month ${g} under ${money(T.idleValue60MedianMax)}`,
    actual: idle ? (atGuard ? money(idle.value60Med) : shortGuard) : 'not run',
    pass: idle && atGuard ? idle.value60Med < T.idleValue60MedianMax : null,
  });
  return out;
}

function printTargets(targets: Target[]): void {
  console.log('\nDESIGN.md 16 targets');
  const rows = targets.map((t) => [`  ${t.label}`, t.actual, t.pass === null ? 'n/a' : t.pass ? 'PASS' : 'FAIL']);
  console.log(table(rows));
}

// ---------------------------------------------------------------- main

function main(): void {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    if (e instanceof Error && e.message === 'help') return;
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 2;
    return;
  }
  const strategies = args.strategy ? [STRATEGIES[args.strategy]] : [...strategyList];
  const seeds = Array.from({ length: args.seeds }, (_, i) => args.seedBase + i);
  console.log(`BrightByte balance: ${strategies.map((s) => s.name).join(', ')} × ${args.seeds} seeds (${seeds[0]}..${seeds[seeds.length - 1]}) × ${args.months} months\n`);

  const summaries: Summary[] = [];
  for (const strategy of strategies) {
    const t0 = performance.now();
    const rows = runRows(strategy, seeds, args.months);
    const seconds = (performance.now() - t0) / 1000;
    summaries.push(summarize(strategy.name, rows, args.months, seconds));
    const errors = rows.filter((r) => r.status === 'error');
    if (errors.length > 0) {
      console.log(`${strategy.name}: ${errors.length} run(s) threw; first: seed ${errors[0].seed}: ${errors[0].error}`);
    }
  }

  printTable(summaries, args.months);
  printPacing(summaries);
  printFiveYear(summaries, args.months);
  const targets = evaluateTargets(summaries, args.months);
  printTargets(targets);
  const failed = targets.filter((t) => t.pass === false).length;
  const errored = summaries.reduce((n, s) => n + s.errors, 0);
  console.log(`\n${failed} target(s) failed, ${targets.filter((t) => t.pass === true).length} passed, ${targets.filter((t) => t.pass === null).length} not evaluated; ${errored} run(s) threw.`);
  if (args.strict && (failed > 0 || errored > 0)) process.exitCode = 1;
}

/** Run only when invoked as a script (`tsx scripts/balance.ts`), not when the test imports the evaluator. */
function invokedAsScript(): boolean {
  const script = process.argv[1] ?? '';
  return /balance\.[cm]?[jt]s$/.test(script);
}

if (invokedAsScript()) main();
