/**
 * Balance harness (DESIGN.md section 16): every strategy × N seeds × M months,
 * headless, then a compact table and the DESIGN 16 targets with PASS / FAIL.
 *
 *   pnpm balance                                   # 5 strategies × 200 seeds × 60 months
 *   pnpm balance --seeds 50 --months 36 --strategy balanced
 *   pnpm balance --seed-base 1000 --strict        # --strict: exit code 1 when a target fails
 *
 * Dead runs count as $0 for value and score (the game over screen scores 0, DESIGN.md 12).
 */
import { STRATEGIES, runStrategy, strategyList } from './strategies';
import type { MonthTrace, Strategy } from './strategies';

// tsx runs this under Node; the project has no Node typings, so declare the two things we touch.
declare const process: { argv: string[]; exitCode?: number };

const DEFAULTS = { seeds: 200, months: 60, seedBase: 1 };

/** DESIGN.md 16 targets. */
const TARGET = {
  balancedSurvival: 0.70,
  recklessDeath: 0.50,
  idleValueCap: 500_000,
  balancedScoreMonth: 36,
  balancedScoreMin: 1_000_000,
  balancedScoreMax: 10_000_000,
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

interface RunRow {
  seed: number;
  status: 'playing' | 'gameOver' | 'sold' | 'error';
  /** closed months before the run ended */
  months: number;
  trace: MonthTrace[];
  equity: boolean;
  loan: boolean;
  error?: string;
}

function runOne(strategy: Strategy, seed: number, months: number): RunRow {
  try {
    const { state, trace } = runStrategy(seed, strategy, months, { drainVisuals: true });
    return {
      seed,
      status: state.status,
      months: state.history.length,
      trace,
      equity: state.rounds.length > 0,
      loan: state.loan !== null || state.history.some((b) => b.fin.loanIn > 0),
    };
  } catch (e) {
    return { seed, status: 'error', months: 0, trace: [], equity: false, loan: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ---------------------------------------------------------------- statistics

function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return Number.NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))];
}

const median = (xs: number[]): number => percentile(xs, 0.5);

/** Value at the close of month m (1-based); $0 once dead; NaN when the horizon is shorter than m. */
function valueAt(row: RunRow, m: number, horizon: number): number {
  if (horizon < m) return Number.NaN;
  return row.trace[m - 1]?.value ?? 0;
}

function scoreAt(row: RunRow, m: number, horizon: number): number {
  if (horizon < m) return Number.NaN;
  return row.trace[m - 1]?.score ?? 0;
}

interface Summary {
  name: string;
  n: number;
  survival: number;
  death: number;
  errors: number;
  monthsP10: number;
  monthsMed: number;
  value24: number;
  value36: number;
  value60: number;
  score36P10: number;
  score36Med: number;
  score36P90: number;
  equityRate: number;
  loanRate: number;
  /** highest value at any close over every seed */
  maxValue: number;
  seconds: number;
}

function summarize(name: string, rows: RunRow[], horizon: number, seconds: number): Summary {
  const n = rows.length;
  const dead = rows.filter((r) => r.status === 'gameOver').length;
  const errors = rows.filter((r) => r.status === 'error').length;
  const months = rows.map((r) => r.months);
  const m = TARGET.balancedScoreMonth;
  const score36 = rows.map((r) => scoreAt(r, m, horizon));
  let maxValue = 0;
  for (const r of rows) for (const t of r.trace) maxValue = Math.max(maxValue, t.value);
  return {
    name,
    n,
    survival: n ? (n - dead - errors) / n : Number.NaN,
    death: n ? dead / n : Number.NaN,
    errors,
    monthsP10: percentile(months, 0.1),
    monthsMed: median(months),
    value24: median(rows.map((r) => valueAt(r, 24, horizon))),
    value36: median(rows.map((r) => valueAt(r, 36, horizon))),
    value60: median(rows.map((r) => valueAt(r, 60, horizon))),
    score36P10: percentile(score36, 0.1),
    score36Med: median(score36),
    score36P90: percentile(score36, 0.9),
    equityRate: n ? rows.filter((r) => r.equity).length / n : Number.NaN,
    loanRate: n ? rows.filter((r) => r.loan).length / n : Number.NaN,
    maxValue,
    seconds,
  };
}

// ---------------------------------------------------------------- printing

function money(x: number): string {
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
  return Number.isFinite(x) ? x.toFixed(0) : 'n/a';
}

function table(rows: string[][]): string {
  const widths: number[] = [];
  for (const row of rows) row.forEach((cell, i) => { widths[i] = Math.max(widths[i] ?? 0, cell.length); });
  return rows
    .map((row) => row.map((cell, i) => (i === 0 ? cell.padEnd(widths[i]) : cell.padStart(widths[i]))).join('  '))
    .join('\n');
}

function printTable(summaries: Summary[], horizon: number): void {
  const header = ['strategy', 'runs', 'survive', 'die', 'err', 'months p10/med', 'value@24', 'value@36', 'value@60', 'score@36 p10/med/p90', 'equity', 'loan', 'max value', 'time'];
  const rows = summaries.map((s) => [
    s.name,
    String(s.n),
    pct(s.survival),
    pct(s.death),
    String(s.errors),
    `${num(s.monthsP10)}/${num(s.monthsMed)}`,
    money(s.value24),
    money(s.value36),
    money(s.value60),
    `${money(s.score36P10)}/${money(s.score36Med)}/${money(s.score36P90)}`,
    pct(s.equityRate),
    pct(s.loanRate),
    money(s.maxValue),
    `${s.seconds.toFixed(1)}s`,
  ]);
  console.log(table([header, ...rows]));
  console.log(`(horizon ${horizon} months; dead runs count as $0 for value and score; months = closed months before the run ended)`);
}

interface Target {
  label: string;
  actual: string;
  /** null = not evaluated (strategy not run or horizon too short) */
  pass: boolean | null;
}

function evaluateTargets(summaries: Summary[], horizon: number): Target[] {
  const by = (name: string): Summary | undefined => summaries.find((s) => s.name === name);
  const balanced = by('balanced');
  const reckless = by('reckless');
  const idle = by('idle');
  const out: Target[] = [];

  out.push({
    label: `balanced survives ≥ ${pct(TARGET.balancedSurvival)} over ${horizon} months`,
    actual: balanced ? pct(balanced.survival) : 'not run',
    pass: balanced ? balanced.survival >= TARGET.balancedSurvival : null,
  });
  out.push({
    label: `reckless dies ≥ ${pct(TARGET.recklessDeath)} over ${horizon} months`,
    actual: reckless ? pct(reckless.death) : 'not run',
    pass: reckless ? reckless.death >= TARGET.recklessDeath : null,
  });
  out.push({
    label: 'idle never dies',
    actual: idle ? `${pct(idle.death)} died` : 'not run',
    pass: idle ? idle.death === 0 && idle.errors === 0 : null,
  });
  out.push({
    label: `idle value never exceeds ${money(TARGET.idleValueCap)} (max over every close and seed)`,
    actual: idle ? money(idle.maxValue) : 'not run',
    pass: idle ? idle.maxValue <= TARGET.idleValueCap : null,
  });
  const scoreOk = balanced !== undefined && horizon >= TARGET.balancedScoreMonth;
  out.push({
    label: `balanced median score at month ${TARGET.balancedScoreMonth} in [${money(TARGET.balancedScoreMin)}, ${money(TARGET.balancedScoreMax)}]`,
    actual: balanced ? (scoreOk ? money(balanced.score36Med) : `horizon ${horizon} < ${TARGET.balancedScoreMonth} months`) : 'not run',
    pass: scoreOk ? balanced.score36Med >= TARGET.balancedScoreMin && balanced.score36Med <= TARGET.balancedScoreMax : null,
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
    const rows = seeds.map((seed) => runOne(strategy, seed, args.months));
    const seconds = (performance.now() - t0) / 1000;
    const summary = summarize(strategy.name, rows, args.months, seconds);
    summaries.push(summary);
    const errors = rows.filter((r) => r.status === 'error');
    if (errors.length > 0) {
      console.log(`${strategy.name}: ${errors.length} run(s) threw; first: seed ${errors[0].seed}: ${errors[0].error}`);
    }
  }

  printTable(summaries, args.months);
  const targets = evaluateTargets(summaries, args.months);
  printTargets(targets);
  const failed = targets.filter((t) => t.pass === false).length;
  const errored = summaries.reduce((n, s) => n + s.errors, 0);
  console.log(`\n${failed} target(s) failed, ${targets.filter((t) => t.pass === true).length} passed, ${targets.filter((t) => t.pass === null).length} not evaluated; ${errored} run(s) threw.`);
  if (args.strict && (failed > 0 || errored > 0)) process.exitCode = 1;
}

main();
