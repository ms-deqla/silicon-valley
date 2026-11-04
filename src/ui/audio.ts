/**
 * Music and effects (DESIGN.md 19), Web Audio only: nothing is loaded, every sound is an
 * oscillator or a noise burst with an envelope. The loop is lo-fi at 84 BPM, 16 bars,
 * Cmaj7 – Am7 – Fmaj7 – G7: a triangle pad through a low-pass with a slow attack, a sine
 * bass on the roots, a sparse pentatonic pluck picked with a non-sim random each bar, a
 * soft kick (a sine drop) and a hat of filtered noise. Five effects (coin, knock, page,
 * buzzer, click) play through the same master.
 *
 * The AudioContext is created on start(), inside the Start tap (browsers refuse sound
 * before a gesture). The sequencer books notes on the context clock from a look-ahead
 * timer (25 ms period, 100 ms ahead: Chris Wilson's "two clocks"), so it never drifts;
 * its pure parts — the step grid, the note tables, the pluck picks, the due-step rule —
 * are exported and unit-tested without a context. The speaker flag is remembered under
 * `sv.audio` (default on). When no AudioContext exists `available` is false, the HUD
 * hides the button, and every sound method is a no-op.
 */
export type Sfx = 'coin' | 'knock' | 'page' | 'buzzer' | 'click';

export interface Audio {
  /** false when an AudioContext cannot be created: hide the button */
  readonly available: boolean;
  readonly enabled: boolean;
  setEnabled(on: boolean): void;
  /** call from a user gesture (the Start tap); starts the loop when enabled */
  start(): void;
  play(sfx: Sfx): void;
  destroy(): void;
}

// ---------------------------------------------------------------- the loop (pure)

/**
 * The loop's grid and the scheduler's clock (DESIGN.md 19). Audio-only numbers: the
 * player never reads them, so they live here rather than in CONFIG (DESIGN.md 15).
 */
export const LOOP = {
  bpm: 84,
  bars: 16,
  beatsPerBar: 4,
  /** eighth notes */
  stepsPerBeat: 2,
  barsPerChord: 2,
  /** the look-ahead timer: its period, and how far ahead of the context clock it books notes */
  timerMs: 25,
  lookaheadSec: 0.1,
  /** a hidden tab's timers run about once a second: book further ahead there */
  hiddenLookaheadSec: 1.2,
  /** a step the timer missed by more than this is skipped, not crammed into "now" */
  maxLateSec: 0.12,
  masterGain: 0.25,
  /** the fade on start and on every toggle */
  fadeSec: 1,
} as const;

export const STEPS_PER_BAR = LOOP.beatsPerBar * LOOP.stepsPerBeat;
export const LOOP_STEPS = LOOP.bars * STEPS_PER_BAR;

export interface Chord {
  name: string;
  /** the bass root, MIDI */
  root: number;
  /** the pad voicing, MIDI, close position around middle C */
  pad: readonly number[];
}

/** Cmaj7 – Am7 – Fmaj7 – G7: two bars each, so the progression runs twice per loop. */
export const CHORDS: readonly Chord[] = [
  { name: 'Cmaj7', root: 36, pad: [60, 64, 67, 71] },
  { name: 'Am7', root: 33, pad: [60, 64, 67, 69] },
  { name: 'Fmaj7', root: 41, pad: [60, 64, 65, 69] },
  { name: 'G7', root: 43, pad: [59, 62, 65, 67] },
];

/** C major pentatonic, C5 to C6: what the pluck picks from (it sits over all four chords). */
export const PENTATONIC: readonly number[] = [72, 74, 76, 79, 81, 84];

export type Voice = 'pad' | 'bass' | 'pluck' | 'kick' | 'hat';

export interface Note {
  voice: Voice;
  /** MIDI note; 0 for the drums */
  midi: number;
  /** length in steps (the drums have their own decay) */
  steps: number;
  /** 0..1, relative to the voice's level */
  level: number;
}

export function midiToFreq(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
}

/** Seconds per step: an eighth note at 84 BPM. */
export function stepSeconds(): number {
  return 60 / LOOP.bpm / LOOP.stepsPerBeat;
}

/** Bar and step within the loop for a step index that counts up forever. */
export function locate(index: number): { bar: number; step: number } {
  const i = ((index % LOOP_STEPS) + LOOP_STEPS) % LOOP_STEPS;
  return { bar: Math.floor(i / STEPS_PER_BAR), step: i % STEPS_PER_BAR };
}

export function chordAt(bar: number): Chord {
  const b = ((bar % LOOP.bars) + LOOP.bars) % LOOP.bars;
  return CHORDS[Math.floor(b / LOOP.barsPerChord) % CHORDS.length];
}

/** The pad: every chord tone, from the chord's first step for the chord's length (its release overlaps the next chord's attack). */
export function padAt(bar: number, step: number): Note[] {
  if (step !== 0 || bar % LOOP.barsPerChord !== 0) return [];
  return chordAt(bar).pad.map((midi) => ({ voice: 'pad', midi, steps: LOOP.barsPerChord * STEPS_PER_BAR, level: 1 }));
}

/** The bass: the root on the one (held) and on the and-of-three; on a chord's last bar the fifth on the and-of-four leads into the next chord. */
export function bassAt(bar: number, step: number): Note[] {
  const { root } = chordAt(bar);
  if (step === 0) return [{ voice: 'bass', midi: root, steps: 3, level: 1 }];
  if (step === 5) return [{ voice: 'bass', midi: root, steps: 2, level: 0.8 }];
  if (step === STEPS_PER_BAR - 1 && bar % LOOP.barsPerChord === LOOP.barsPerChord - 1) {
    return [{ voice: 'bass', midi: root + 7, steps: 1, level: 0.6 }];
  }
  return [];
}

/** The drums: a kick on one and three (a pickup on the and-of-four every fourth bar), a hat on every eighth with the off-beats softer; the loop's last half-bar breathes. */
export function drumsAt(bar: number, step: number): Note[] {
  const out: Note[] = [];
  if (step === 0 || step === STEPS_PER_BAR / 2) out.push({ voice: 'kick', midi: 0, steps: 1, level: step === 0 ? 1 : 0.8 });
  if (step === STEPS_PER_BAR - 1 && bar % 4 === 3) out.push({ voice: 'kick', midi: 0, steps: 1, level: 0.6 });
  const breath = bar === LOOP.bars - 1 && step >= STEPS_PER_BAR / 2;
  if (!breath) out.push({ voice: 'hat', midi: 0, steps: 1, level: step % 2 === 0 ? 0.7 : 0.4 });
  return out;
}

export interface Pluck {
  step: number;
  midi: number;
}

function pick(rand: () => number, n: number): number {
  return Math.min(n - 1, Math.max(0, Math.floor(rand() * n)));
}

/**
 * The pluck is sparse: a bar gets one note on a random eighth, sometimes two, sometimes
 * none, each a random pentatonic pitch, never two on one step; the bar a chord starts on
 * gets at most one, so the pad's attack is heard. `rand` is a non-sim random: Math.random
 * in the page, whatever the tests pass.
 */
export function pluckPlan(bar: number, rand: () => number): Pluck[] {
  const r = rand();
  let count = r < 0.2 ? 0 : r < 0.75 ? 1 : 2;
  if (bar % LOOP.barsPerChord === 0) count = Math.min(count, 1);
  const plan: Pluck[] = [];
  for (let tries = 0; plan.length < count && tries < 8; tries++) {
    const step = pick(rand, STEPS_PER_BAR);
    if (plan.some((p) => p.step === step)) continue;
    plan.push({ step, midi: PENTATONIC[pick(rand, PENTATONIC.length)] });
  }
  return plan.sort((a, b) => a.step - b.step);
}

/** Everything that starts on one step: the pad, the bass, this bar's plucks, the drums. */
export function notesAt(bar: number, step: number, plucks: readonly Pluck[]): Note[] {
  const pluckNotes: Note[] = plucks.filter((p) => p.step === step).map((p) => ({ voice: 'pluck', midi: p.midi, steps: 2, level: 1 }));
  return [...padAt(bar, step), ...bassAt(bar, step), ...pluckNotes, ...drumsAt(bar, step)];
}

// ---------------------------------------------------------------- the schedule (pure)

/** Where the sequencer is: step `index` plays at `origin + index × stepSeconds()`, never accumulated. */
export interface Cursor {
  origin: number;
  index: number;
}

export interface DueStep {
  index: number;
  bar: number;
  step: number;
  time: number;
}

export function timeOf(cursor: Cursor, index: number): number {
  return cursor.origin + index * stepSeconds();
}

/**
 * The steps to book now: every one whose time falls before now + lookahead, in order, and
 * the cursor after them. A step the timer missed by more than maxLate (a throttled tab) is
 * skipped rather than crammed into "now"; one missed by less still plays, at once.
 */
export function dueSteps(cursor: Cursor, now: number, lookahead: number = LOOP.lookaheadSec, maxLate: number = LOOP.maxLateSec): { due: DueStep[]; cursor: Cursor } {
  const sec = stepSeconds();
  const firstLive = Math.ceil((now - maxLate - cursor.origin) / sec);
  let index = Math.max(cursor.index, firstLive);
  const due: DueStep[] = [];
  while (cursor.origin + index * sec < now + lookahead) {
    due.push({ index, ...locate(index), time: cursor.origin + index * sec });
    index++;
  }
  return { due, cursor: { origin: cursor.origin, index } };
}

// ---------------------------------------------------------------- the speaker flag

export const AUDIO_STORAGE_KEY = 'sv.audio';

/** The stored flag: anything but an explicit off means on, so a fresh device hears the music (DESIGN.md 19: default on). */
export function parseEnabled(raw: string | null | undefined): boolean {
  return !(raw === '0' || raw === 'off' || raw === 'false');
}

export function serializeEnabled(on: boolean): string {
  return on ? '1' : '0';
}

function readEnabled(): boolean {
  try {
    if (typeof localStorage === 'undefined') return true;
    return parseEnabled(localStorage.getItem(AUDIO_STORAGE_KEY));
  } catch {
    return true;
  }
}

function writeEnabled(on: boolean): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(AUDIO_STORAGE_KEY, serializeEnabled(on));
  } catch {
    // private mode or blocked storage: the flag lives for this page only
  }
}

// ---------------------------------------------------------------- the synth

/** Per-voice levels (linear gain before the master) and envelopes (seconds). */
const SYNTH = {
  pad: { level: 0.07, attack: 0.9, release: 0.8, detuneCents: 5, filterHz: 1200, filterQ: 0.7 },
  /** a quiet octave above the sine root so phone speakers hear the bass too */
  bass: { level: 0.5, octaveLevel: 0.35, attack: 0.02, release: 0.08 },
  pluck: { level: 0.3, attack: 0.004, decay: 0.35, filterHz: 2600 },
  kick: { level: 0.8, fromHz: 140, toHz: 42, drop: 0.1, decay: 0.28 },
  hat: { level: 0.14, filterHz: 6000, decay: 0.05 },
  /** the shared white-noise buffer; hits take a slice of it */
  noiseSec: 1,
  /** the loop starts this far after the context clock, so the first step is never late */
  leadSec: 0.05,
  /** envelopes decay to this, then the source stops */
  floor: 0.001,
} as const;

/** The effects (DESIGN.md 19): levels before the master, seconds. */
const FX = {
  /** two short sine blips, B5 then E6 */
  coin: { hz: [988, 1319], blip: 0.07, gap: 0.08, level: 0.35 },
  /** two taps of band-passed noise */
  knock: { hz: 320, q: 1.5, tap: 0.06, gap: 0.14, level: 0.9 },
  /** a noise sweep up through a band-pass */
  page: { fromHz: 400, toHz: 3600, q: 3, dur: 0.32, level: 0.5 },
  /** a square chord, one second: C4 E4 G4 */
  buzzer: { hz: [262, 330, 392], dur: 1, attack: 0.01, release: 0.15, filterHz: 1800, level: 0.1 },
  /** a tick: a tiny noise burst with a hint of tone */
  click: { noiseHz: 2500, noiseDur: 0.02, noiseLevel: 0.25, toneHz: 1800, toneDur: 0.015, toneLevel: 0.12 },
} as const;

type AudioContextCtor = new () => AudioContext;

function contextCtor(): AudioContextCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor };
  const ctor = w.AudioContext ?? w.webkitAudioContext;
  return typeof ctor === 'function' ? ctor : null;
}

interface Graph {
  ctx: AudioContext;
  master: GainNode;
  padFilter: BiquadFilterNode;
  pluckFilter: BiquadFilterNode;
  hatFilter: BiquadFilterNode;
  noise: AudioBuffer;
}

function buildGraph(ctx: AudioContext): Graph {
  const master = ctx.createGain();
  master.gain.value = 0;
  master.connect(ctx.destination);

  const padFilter = ctx.createBiquadFilter();
  padFilter.type = 'lowpass';
  padFilter.frequency.value = SYNTH.pad.filterHz;
  padFilter.Q.value = SYNTH.pad.filterQ;
  padFilter.connect(master);

  const pluckFilter = ctx.createBiquadFilter();
  pluckFilter.type = 'lowpass';
  pluckFilter.frequency.value = SYNTH.pluck.filterHz;
  pluckFilter.connect(master);

  const hatFilter = ctx.createBiquadFilter();
  hatFilter.type = 'highpass';
  hatFilter.frequency.value = SYNTH.hat.filterHz;
  hatFilter.connect(master);

  const noise = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * SYNTH.noiseSec), ctx.sampleRate);
  const data = noise.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;

  return { ctx, master, padFilter, pluckFilter, hatFilter, noise };
}

export function createAudio(): Audio {
  const Ctor = contextCtor();
  let enabled = readEnabled();
  let graph: Graph | null = null;
  let started = false;
  let destroyed = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let suspendTimer: ReturnType<typeof setTimeout> | null = null;
  let cursor: Cursor | null = null;
  /** the current bar's pluck picks, keyed by the absolute bar so every pass through the loop re-rolls */
  let plan: { bar: number; plucks: Pluck[] } | null = null;
  /** every source booked so far and not yet ended: a stop silences them together */
  const live = new Set<AudioScheduledSourceNode>();

  function track(node: AudioScheduledSourceNode): void {
    live.add(node);
    node.onended = () => {
      live.delete(node);
    };
  }

  /** An oscillator into `dest` with a linear attack and an exponential decay. */
  function blip(g: Graph, dest: AudioNode, type: OscillatorType, hz: number, at: number, peak: number, attack: number, decay: number): void {
    const env = g.ctx.createGain();
    env.gain.setValueAtTime(0, at);
    env.gain.linearRampToValueAtTime(peak, at + attack);
    env.gain.exponentialRampToValueAtTime(SYNTH.floor, at + attack + decay);
    env.connect(dest);
    const osc = g.ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = hz;
    osc.connect(env);
    osc.start(at);
    osc.stop(at + attack + decay + 0.02);
    track(osc);
  }

  /** A slice of noise into `dest` (a filter or the master) with a linear attack and an exponential decay. */
  function burst(g: Graph, dest: AudioNode, at: number, peak: number, attack: number, decay: number): void {
    const env = g.ctx.createGain();
    if (attack > 0) {
      env.gain.setValueAtTime(0, at);
      env.gain.linearRampToValueAtTime(peak, at + attack);
    } else {
      env.gain.setValueAtTime(peak, at);
    }
    env.gain.exponentialRampToValueAtTime(SYNTH.floor, at + attack + decay);
    env.connect(dest);
    const src = g.ctx.createBufferSource();
    src.buffer = g.noise;
    src.loop = true;
    src.connect(env);
    // a random slice, so two hits never sound the same (a non-sim random: the UI may)
    src.start(at, Math.random() * SYNTH.noiseSec * 0.5);
    src.stop(at + attack + decay + 0.01);
    track(src);
  }

  function bookPad(g: Graph, midi: number, at: number, dur: number, level: number): void {
    const { pad } = SYNTH;
    const peak = pad.level * level;
    const env = g.ctx.createGain();
    env.gain.setValueAtTime(0, at);
    env.gain.linearRampToValueAtTime(peak, at + pad.attack);
    env.gain.setValueAtTime(peak, at + dur);
    env.gain.linearRampToValueAtTime(0, at + dur + pad.release);
    env.connect(g.padFilter);
    for (const cents of [-pad.detuneCents, pad.detuneCents]) {
      const osc = g.ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = midiToFreq(midi);
      osc.detune.value = cents;
      osc.connect(env);
      osc.start(at);
      osc.stop(at + dur + pad.release + 0.05);
      track(osc);
    }
  }

  function bookBass(g: Graph, midi: number, at: number, dur: number, level: number): void {
    const { bass } = SYNTH;
    for (const [note, gain] of [[midi, bass.level], [midi + 12, bass.level * bass.octaveLevel]] as const) {
      const peak = gain * level;
      const env = g.ctx.createGain();
      env.gain.setValueAtTime(0, at);
      env.gain.linearRampToValueAtTime(peak, at + bass.attack);
      env.gain.setValueAtTime(peak, at + dur - bass.release);
      env.gain.linearRampToValueAtTime(0, at + dur);
      env.connect(g.master);
      const osc = g.ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = midiToFreq(note);
      osc.connect(env);
      osc.start(at);
      osc.stop(at + dur + 0.02);
      track(osc);
    }
  }

  function bookPluck(g: Graph, midi: number, at: number, level: number): void {
    const { pluck } = SYNTH;
    blip(g, g.pluckFilter, 'triangle', midiToFreq(midi), at, pluck.level * level, pluck.attack, pluck.decay);
  }

  function bookKick(g: Graph, at: number, level: number): void {
    const { kick } = SYNTH;
    const env = g.ctx.createGain();
    env.gain.setValueAtTime(kick.level * level, at);
    env.gain.exponentialRampToValueAtTime(SYNTH.floor, at + kick.decay);
    env.connect(g.master);
    const osc = g.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(kick.fromHz, at);
    osc.frequency.exponentialRampToValueAtTime(kick.toHz, at + kick.drop);
    osc.connect(env);
    osc.start(at);
    osc.stop(at + kick.decay + 0.02);
    track(osc);
  }

  function bookHat(g: Graph, at: number, level: number): void {
    burst(g, g.hatFilter, at, SYNTH.hat.level * level, 0, SYNTH.hat.decay);
  }

  function bookStep(g: Graph, d: DueStep): void {
    const absBar = Math.floor(d.index / STEPS_PER_BAR);
    if (!plan || plan.bar !== absBar) plan = { bar: absBar, plucks: pluckPlan(d.bar, Math.random) };
    const sec = stepSeconds();
    for (const n of notesAt(d.bar, d.step, plan.plucks)) {
      switch (n.voice) {
        case 'pad':
          bookPad(g, n.midi, d.time, n.steps * sec, n.level);
          break;
        case 'bass':
          bookBass(g, n.midi, d.time, n.steps * sec, n.level);
          break;
        case 'pluck':
          bookPluck(g, n.midi, d.time, n.level);
          break;
        case 'kick':
          bookKick(g, d.time, n.level);
          break;
        case 'hat':
          bookHat(g, d.time, n.level);
          break;
      }
    }
  }

  /** The look-ahead timer's tick: book every step due before now + lookahead, on the context clock. */
  function tick(): void {
    if (!graph || !cursor) return;
    const hidden = typeof document !== 'undefined' && document.hidden;
    const { due, cursor: next } = dueSteps(cursor, graph.ctx.currentTime, hidden ? LOOP.hiddenLookaheadSec : LOOP.lookaheadSec);
    cursor = next;
    for (const d of due) bookStep(graph, d);
  }

  /** Ramp the master to `to` over the fade from wherever it is now, cancelling any ramp in flight. */
  function fade(g: Graph, to: number): void {
    const now = g.ctx.currentTime;
    const from = g.master.gain.value;
    g.master.gain.cancelScheduledValues(now);
    g.master.gain.setValueAtTime(from, now);
    g.master.gain.linearRampToValueAtTime(to, now + LOOP.fadeSec);
  }

  function resume(g: Graph): void {
    if (g.ctx.state !== 'running') void g.ctx.resume().catch(() => undefined);
  }

  function startLoop(g: Graph): void {
    if (suspendTimer !== null) {
      clearTimeout(suspendTimer);
      suspendTimer = null;
    }
    resume(g);
    if (timer !== null) return;
    cursor = { origin: g.ctx.currentTime + SYNTH.leadSec, index: 0 };
    plan = null;
    fade(g, LOOP.masterGain);
    timer = setInterval(tick, LOOP.timerMs);
    tick();
  }

  /** Fade out, book nothing more, stop what is booked once the fade is over, then let the context idle. */
  function stopLoop(g: Graph): void {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
    cursor = null;
    plan = null;
    fade(g, 0);
    const at = g.ctx.currentTime + LOOP.fadeSec + SYNTH.leadSec;
    for (const node of live) {
      try {
        node.stop(at);
      } catch {
        // already stopped
      }
    }
    if (suspendTimer !== null) clearTimeout(suspendTimer);
    suspendTimer = setTimeout(() => {
      suspendTimer = null;
      if (!destroyed && !enabled) void g.ctx.suspend().catch(() => undefined);
    }, (LOOP.fadeSec + 2 * SYNTH.leadSec) * 1000);
  }

  /** iOS and friends interrupt the context when the tab goes away: pick it up again when it comes back. */
  const onVisibility = (): void => {
    if (!graph || destroyed || !started || !enabled) return;
    if (!document.hidden) resume(graph);
  };

  // ---- effects

  function coin(g: Graph, at: number): void {
    const { coin: c } = FX;
    c.hz.forEach((hz, i) => blip(g, g.master, 'sine', hz, at + i * c.gap, c.level, 0.005, c.blip));
  }

  function knock(g: Graph, at: number): void {
    const { knock: k } = FX;
    const bp = g.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = k.hz;
    bp.Q.value = k.q;
    bp.connect(g.master);
    burst(g, bp, at, k.level, 0, k.tap);
    burst(g, bp, at + k.gap, k.level * 0.8, 0, k.tap);
  }

  function page(g: Graph, at: number): void {
    const { page: p } = FX;
    const bp = g.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = p.q;
    bp.frequency.setValueAtTime(p.fromHz, at);
    bp.frequency.exponentialRampToValueAtTime(p.toHz, at + p.dur);
    bp.connect(g.master);
    burst(g, bp, at, p.level, 0.04, p.dur - 0.04);
  }

  function buzzer(g: Graph, at: number): void {
    const { buzzer: b } = FX;
    const lp = g.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = b.filterHz;
    lp.connect(g.master);
    for (const hz of b.hz) {
      const env = g.ctx.createGain();
      env.gain.setValueAtTime(0, at);
      env.gain.linearRampToValueAtTime(b.level, at + b.attack);
      env.gain.setValueAtTime(b.level, at + b.dur - b.release);
      env.gain.linearRampToValueAtTime(0, at + b.dur);
      env.connect(lp);
      const osc = g.ctx.createOscillator();
      osc.type = 'square';
      osc.frequency.value = hz;
      osc.connect(env);
      osc.start(at);
      osc.stop(at + b.dur + 0.02);
      track(osc);
    }
  }

  function click(g: Graph, at: number): void {
    const { click: c } = FX;
    const bp = g.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = c.noiseHz;
    bp.connect(g.master);
    burst(g, bp, at, c.noiseLevel, 0, c.noiseDur);
    blip(g, g.master, 'sine', c.toneHz, at, c.toneLevel, 0.002, c.toneDur);
  }

  return {
    available: Ctor !== null,
    get enabled() {
      return enabled;
    },
    setEnabled(on) {
      if (on === enabled) return;
      enabled = on;
      writeEnabled(on);
      if (!graph || !started || destroyed) return;
      if (on) startLoop(graph);
      else stopLoop(graph);
    },
    start() {
      if (!Ctor || destroyed) return;
      if (!graph) {
        try {
          graph = buildGraph(new Ctor());
        } catch {
          return;
        }
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);
      }
      started = true;
      if (enabled) startLoop(graph);
      else void graph.ctx.suspend().catch(() => undefined);
    },
    play(sfx) {
      if (!graph || !started || !enabled || destroyed || graph.ctx.state !== 'running') return;
      const at = graph.ctx.currentTime;
      switch (sfx) {
        case 'coin':
          coin(graph, at);
          break;
        case 'knock':
          knock(graph, at);
          break;
        case 'page':
          page(graph, at);
          break;
        case 'buzzer':
          buzzer(graph, at);
          break;
        case 'click':
          click(graph, at);
          break;
      }
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      started = false;
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      if (suspendTimer !== null) {
        clearTimeout(suspendTimer);
        suspendTimer = null;
      }
      cursor = null;
      plan = null;
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
      const g = graph;
      graph = null;
      if (!g) return;
      for (const node of live) {
        try {
          node.stop();
        } catch {
          // never started
        }
      }
      live.clear();
      void g.ctx.close().catch(() => undefined);
    },
  };
}
