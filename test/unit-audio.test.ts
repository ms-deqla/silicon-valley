/**
 * The audio module's pure parts (DESIGN.md 19): the loop's grid, chord and note tables,
 * the pluck picks, the look-ahead schedule, and the speaker flag's persistence. No
 * AudioContext here: vitest runs in node, where createAudio() reports unavailable and
 * every sound method is a no-op.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AUDIO_STORAGE_KEY,
  CHORDS,
  LOOP,
  LOOP_STEPS,
  PENTATONIC,
  STEPS_PER_BAR,
  bassAt,
  chordAt,
  createAudio,
  drumsAt,
  dueSteps,
  locate,
  midiToFreq,
  notesAt,
  padAt,
  parseEnabled,
  pluckPlan,
  serializeEnabled,
  stepSeconds,
  timeOf,
} from '../src/ui/audio';
import type { Cursor, Note, Pluck } from '../src/ui/audio';

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k: string) => (m.has(k) ? (m.get(k) as string) : null),
    key: (i: number) => [...m.keys()][i] ?? null,
    removeItem: (k: string) => {
      m.delete(k);
    },
    setItem: (k: string, v: string) => {
      m.set(k, String(v));
    },
  };
}

/** A rand that replays a fixed sequence, then repeats it. */
function sequence(values: number[]): () => number {
  let i = 0;
  return () => values[i++ % values.length];
}

const pitchClass = (midi: number): number => ((midi % 12) + 12) % 12;
/** chord tones by pitch class, by name */
const TONES: Record<string, number[]> = {
  Cmaj7: [0, 4, 7, 11],
  Am7: [9, 0, 4, 7],
  Fmaj7: [5, 9, 0, 4],
  G7: [7, 11, 2, 5],
};
const PENTATONIC_CLASSES = [0, 2, 4, 7, 9];

// ---------------------------------------------------------------- grid
describe('the loop grid', () => {
  it('is 84 BPM, 16 bars of four beats on an eighth-note grid, two bars per chord', () => {
    expect(LOOP.bpm).toBe(84);
    expect(LOOP.bars).toBe(16);
    expect(STEPS_PER_BAR).toBe(8);
    expect(LOOP_STEPS).toBe(128);
    expect(stepSeconds()).toBeCloseTo(60 / 84 / 2, 12);
    // the whole loop is a little under 46 seconds
    expect(LOOP_STEPS * stepSeconds()).toBeCloseTo(45.714, 3);
    expect(LOOP.masterGain).toBe(0.25);
    expect(LOOP.fadeSec).toBe(1);
    expect(LOOP.timerMs).toBe(25);
    expect(LOOP.lookaheadSec).toBe(0.1);
  });

  it('locates a step index inside the loop and wraps forever', () => {
    expect(locate(0)).toEqual({ bar: 0, step: 0 });
    expect(locate(7)).toEqual({ bar: 0, step: 7 });
    expect(locate(8)).toEqual({ bar: 1, step: 0 });
    expect(locate(127)).toEqual({ bar: 15, step: 7 });
    expect(locate(128)).toEqual({ bar: 0, step: 0 });
    expect(locate(131)).toEqual({ bar: 0, step: 3 });
    expect(locate(128 * 1000 + 77)).toEqual(locate(77));
    expect(locate(-1)).toEqual({ bar: 15, step: 7 });
  });

  it('tunes MIDI to concert pitch', () => {
    expect(midiToFreq(69)).toBe(440);
    expect(midiToFreq(81)).toBe(880);
    expect(midiToFreq(60)).toBeCloseTo(261.63, 2);
  });
});

// ---------------------------------------------------------------- chords
describe('the chord table', () => {
  it('runs Cmaj7 – Am7 – Fmaj7 – G7, two bars each, twice per loop', () => {
    expect(CHORDS.map((c) => c.name)).toEqual(['Cmaj7', 'Am7', 'Fmaj7', 'G7']);
    const names = Array.from({ length: LOOP.bars }, (_, bar) => chordAt(bar).name);
    expect(names).toEqual([
      'Cmaj7', 'Cmaj7', 'Am7', 'Am7', 'Fmaj7', 'Fmaj7', 'G7', 'G7',
      'Cmaj7', 'Cmaj7', 'Am7', 'Am7', 'Fmaj7', 'Fmaj7', 'G7', 'G7',
    ]);
    expect(chordAt(16).name).toBe('Cmaj7');
    expect(chordAt(-1).name).toBe('G7');
  });

  it('voices every chord from its own tones, with the root in the bass register', () => {
    for (const chord of CHORDS) {
      const tones = TONES[chord.name];
      expect(tones).toBeDefined();
      expect(pitchClass(chord.root)).toBe(tones[0]);
      expect(chord.root).toBeLessThan(48);
      expect(chord.pad).toHaveLength(4);
      for (const midi of chord.pad) {
        expect(tones).toContain(pitchClass(midi));
        expect(midi).toBeGreaterThanOrEqual(55);
        expect(midi).toBeLessThanOrEqual(76);
      }
      // the four voices are distinct tones: the whole seventh chord sounds
      expect(new Set(chord.pad.map(pitchClass)).size).toBe(4);
    }
  });

  it('keeps the pluck on the C major pentatonic, above the pad', () => {
    for (const midi of PENTATONIC) {
      expect(PENTATONIC_CLASSES).toContain(pitchClass(midi));
      expect(midi).toBeGreaterThan(71);
    }
  });
});

// ---------------------------------------------------------------- voices
describe('the note tables', () => {
  it('pad: all four chord tones start on the chord\'s first step and hold for its two bars', () => {
    const notes = padAt(0, 0);
    expect(notes).toHaveLength(4);
    expect(notes.map((n) => n.midi)).toEqual([...CHORDS[0].pad]);
    for (const n of notes) {
      expect(n.voice).toBe('pad');
      expect(n.steps).toBe(LOOP.barsPerChord * STEPS_PER_BAR);
      expect(n.level).toBe(1);
    }
    expect(padAt(2, 0).map((n) => n.midi)).toEqual([...CHORDS[1].pad]);
    expect(padAt(6, 0).map((n) => n.midi)).toEqual([...CHORDS[3].pad]);
    // nowhere else
    expect(padAt(1, 0)).toEqual([]);
    expect(padAt(0, 1)).toEqual([]);
    expect(padAt(0, 4)).toEqual([]);
    expect(padAt(15, 0)).toEqual([]);
  });

  it('bass: the root on the one and the and-of-three, the fifth leading into the next chord', () => {
    for (let bar = 0; bar < LOOP.bars; bar++) {
      const { root } = chordAt(bar);
      const one = bassAt(bar, 0);
      expect(one).toHaveLength(1);
      expect(one[0]).toMatchObject({ voice: 'bass', midi: root, level: 1 });
      expect(one[0].steps).toBeGreaterThanOrEqual(2);
      expect(bassAt(bar, 5)).toHaveLength(1);
      expect(bassAt(bar, 5)[0].midi).toBe(root);
      const lead = bassAt(bar, 7);
      if (bar % LOOP.barsPerChord === LOOP.barsPerChord - 1) {
        expect(lead).toHaveLength(1);
        expect(lead[0].midi).toBe(root + 7);
      } else {
        expect(lead).toEqual([]);
      }
      for (const step of [1, 2, 3, 4, 6]) expect(bassAt(bar, step)).toEqual([]);
    }
    // the fifth of G7 (D) leads back to C
    expect(bassAt(7, 7)[0].midi).toBe(CHORDS[3].root + 7);
    expect(pitchClass(bassAt(7, 7)[0].midi)).toBe(2);
    // every bass note stays low: A1 (the Am7 root) up to D3 (the fifth of G7)
    for (let bar = 0; bar < LOOP.bars; bar++) {
      for (let step = 0; step < STEPS_PER_BAR; step++) {
        for (const n of bassAt(bar, step)) {
          expect(n.midi).toBeGreaterThanOrEqual(33);
          expect(n.midi).toBeLessThanOrEqual(50);
        }
      }
    }
  });

  it('drums: a kick on one and three, a hat on every eighth with softer off-beats, a breath in the last half-bar', () => {
    const kicks = (bar: number, step: number): Note[] => drumsAt(bar, step).filter((n) => n.voice === 'kick');
    const hats = (bar: number, step: number): Note[] => drumsAt(bar, step).filter((n) => n.voice === 'hat');
    for (let bar = 0; bar < LOOP.bars; bar++) {
      expect(kicks(bar, 0)).toHaveLength(1);
      expect(kicks(bar, 0)[0].level).toBe(1);
      expect(kicks(bar, 4)).toHaveLength(1);
      for (const step of [1, 2, 3, 5, 6]) expect(kicks(bar, step)).toEqual([]);
      // the pickup only every fourth bar
      expect(kicks(bar, 7)).toHaveLength(bar % 4 === 3 ? 1 : 0);
      for (let step = 0; step < STEPS_PER_BAR; step++) {
        const h = hats(bar, step);
        if (bar === LOOP.bars - 1 && step >= 4) {
          expect(h).toEqual([]);
        } else {
          expect(h).toHaveLength(1);
          expect(h[0].level).toBe(step % 2 === 0 ? 0.7 : 0.4);
        }
      }
    }
    for (let bar = 0; bar < LOOP.bars; bar++) {
      for (let step = 0; step < STEPS_PER_BAR; step++) {
        for (const n of drumsAt(bar, step)) {
          expect(n.midi).toBe(0);
          expect(n.level).toBeGreaterThan(0);
          expect(n.level).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it('notesAt merges the pad, the bass, the bar\'s plucks and the drums for one step', () => {
    const plucks: Pluck[] = [{ step: 0, midi: 76 }, { step: 3, midi: 79 }];
    const downbeat = notesAt(0, 0, plucks);
    expect(downbeat.filter((n) => n.voice === 'pad')).toHaveLength(4);
    expect(downbeat.filter((n) => n.voice === 'bass')).toHaveLength(1);
    expect(downbeat.filter((n) => n.voice === 'pluck')).toEqual([{ voice: 'pluck', midi: 76, steps: 2, level: 1 }]);
    expect(downbeat.filter((n) => n.voice === 'kick')).toHaveLength(1);
    expect(downbeat.filter((n) => n.voice === 'hat')).toHaveLength(1);
    const three = notesAt(0, 3, plucks);
    expect(three.map((n) => n.voice)).toEqual(['pluck', 'hat']);
    expect(three[0].midi).toBe(79);
    expect(notesAt(0, 6, plucks).map((n) => n.voice)).toEqual(['hat']);
  });
});

// ---------------------------------------------------------------- pluck
describe('the pluck picks', () => {
  it('are sparse: none, one or two per bar, at most one on a chord\'s first bar', () => {
    // the first draw sets the count: under 0.2 none, under 0.75 one, else two
    expect(pluckPlan(1, sequence([0.1]))).toEqual([]);
    expect(pluckPlan(1, sequence([0.5, 0.25, 0.5]))).toEqual([{ step: 2, midi: PENTATONIC[3] }]);
    const two = pluckPlan(1, sequence([0.9, 0.125, 0, 0.875, 0.999]));
    expect(two).toEqual([{ step: 1, midi: PENTATONIC[0] }, { step: 7, midi: PENTATONIC[5] }]);
    // the same draws on a chord's first bar: one pluck, so the pad's attack is heard
    expect(pluckPlan(0, sequence([0.9, 0.125, 0, 0.875, 0.999]))).toEqual([{ step: 1, midi: PENTATONIC[0] }]);
    expect(pluckPlan(2, sequence([0.9, 0.125, 0, 0.875, 0.999]))).toHaveLength(1);
  });

  it('never puts two plucks on one step and never loops forever on a stuck random', () => {
    const stuck = pluckPlan(3, () => 0.99);
    expect(stuck).toHaveLength(1);
    expect(stuck[0]).toEqual({ step: 7, midi: PENTATONIC[5] });
    // a random that returns exactly 1 still lands inside the tables
    const edge = pluckPlan(3, () => 1);
    expect(edge).toEqual([{ step: 7, midi: PENTATONIC[5] }]);
    expect(pluckPlan(3, () => 0)).toEqual([]);
  });

  it('stays on the pentatonic and inside the bar for any random, sorted by step', () => {
    let seed = 12345;
    const rand = (): number => {
      // a small LCG: the module never sees Math.random here
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const counts = [0, 0, 0];
    for (let bar = 0; bar < 400; bar++) {
      const plan = pluckPlan(bar, rand);
      counts[plan.length]++;
      expect(plan.length).toBeLessThanOrEqual(bar % LOOP.barsPerChord === 0 ? 1 : 2);
      expect(new Set(plan.map((p) => p.step)).size).toBe(plan.length);
      for (let i = 1; i < plan.length; i++) expect(plan[i].step).toBeGreaterThan(plan[i - 1].step);
      for (const p of plan) {
        expect(Number.isInteger(p.step)).toBe(true);
        expect(p.step).toBeGreaterThanOrEqual(0);
        expect(p.step).toBeLessThan(STEPS_PER_BAR);
        expect(PENTATONIC).toContain(p.midi);
      }
    }
    // sparse, not silent: every count shows up
    expect(counts[0]).toBeGreaterThan(20);
    expect(counts[1]).toBeGreaterThan(100);
    expect(counts[2]).toBeGreaterThan(10);
  });
});

// ---------------------------------------------------------------- schedule
describe('the look-ahead schedule', () => {
  const sec = stepSeconds();

  it('books a step at origin + index × step, never accumulated', () => {
    const cursor: Cursor = { origin: 3.25, index: 0 };
    expect(timeOf(cursor, 0)).toBe(3.25);
    expect(timeOf(cursor, 1)).toBeCloseTo(3.25 + sec, 12);
    expect(timeOf(cursor, 10_000)).toBeCloseTo(3.25 + 10_000 * sec, 9);
  });

  it('books every step before now + lookahead, in order, and moves the cursor past them', () => {
    const start = dueSteps({ origin: 10, index: 0 }, 10);
    expect(start.due.map((d) => d.index)).toEqual([0]);
    expect(start.due[0]).toEqual({ index: 0, bar: 0, step: 0, time: 10 });
    expect(start.cursor).toEqual({ origin: 10, index: 1 });
    // nothing new 25 ms later: step 1 is 357 ms away
    const next = dueSteps(start.cursor, 10.025);
    expect(next.due).toEqual([]);
    expect(next.cursor).toEqual({ origin: 10, index: 1 });
    // it comes due once it is within the look-ahead
    const later = dueSteps(next.cursor, 10 + sec - 0.09);
    expect(later.due.map((d) => d.index)).toEqual([1]);
    expect(later.due[0].time).toBeCloseTo(10 + sec, 12);
  });

  it('driven every 25 ms for a minute it books each step exactly once, 75 to 100 ms early, with no drift', () => {
    let cursor: Cursor = { origin: 0.05, index: 0 };
    const booked: { index: number; time: number; now: number }[] = [];
    for (let tickNo = 0; tickNo * 0.025 < 60; tickNo++) {
      const now = tickNo * 0.025;
      const r = dueSteps(cursor, now);
      cursor = r.cursor;
      for (const d of r.due) booked.push({ index: d.index, time: d.time, now });
    }
    const expected = Math.ceil((60 - 0.025 + LOOP.lookaheadSec - 0.05) / sec);
    expect(booked).toHaveLength(expected);
    booked.forEach((b, i) => {
      expect(b.index).toBe(i);
      expect(b.time).toBeCloseTo(0.05 + i * sec, 12);
      const early = b.time - b.now;
      // the first step sits on the lead (50 ms after the origin); after that the timer is never more than 25 ms behind the window
      expect(early).toBeGreaterThan((i === 0 ? 0.05 : 0.075) - 1e-9);
      expect(early).toBeLessThan(LOOP.lookaheadSec + 1e-9);
    });
    // the last booked step is still exactly on the grid: no accumulated error
    const last = booked[booked.length - 1];
    expect(last.time - 0.05 - last.index * sec).toBeCloseTo(0, 12);
    // and the cursor wraps the loop the same way
    expect(locate(last.index)).toEqual({ bar: Math.floor((last.index % LOOP_STEPS) / STEPS_PER_BAR), step: last.index % STEPS_PER_BAR });
  });

  it('after a stall it skips what was missed by more than maxLate and keeps the step that is only slightly late', () => {
    // the timer slept from step 10 to t = 20.05; step 56 is at exactly 20.0
    const r = dueSteps({ origin: 0, index: 10 }, 20.05);
    expect(r.due.map((d) => d.index)).toEqual([56]);
    expect(r.due[0].time).toBeCloseTo(20, 12);
    expect(r.cursor.index).toBe(57);
    // a step more than maxLate behind is gone: at t = 20.2 step 56 (0.2 s late) is skipped and the cursor
    // jumps to 57 (20.357), which is not yet inside the window and comes due 100 ms before its time
    const late = dueSteps({ origin: 0, index: 10 }, 20.2);
    expect(late.due).toEqual([]);
    expect(late.cursor.index).toBe(57);
    const then = dueSteps(late.cursor, 20.27);
    expect(then.due.map((d) => d.index)).toEqual([57]);
    expect(then.due[0].time).toBeCloseTo(57 * sec, 12);
    // a long stall never bursts: at most the window's worth of steps come out of one tick
    for (const now of [100.123, 1000.5, 3600.001]) {
      const r = dueSteps({ origin: 0, index: 0 }, now);
      expect(r.due.length).toBeLessThanOrEqual(Math.ceil((LOOP.lookaheadSec + LOOP.maxLateSec) / sec) + 1);
      for (const d of r.due) expect(d.time).toBeGreaterThanOrEqual(now - LOOP.maxLateSec - 1e-9);
      expect(r.cursor.index * sec).toBeGreaterThanOrEqual(now + LOOP.lookaheadSec - 1e-9);
    }
  });

  it('a wider look-ahead (a hidden tab) books more steps at once', () => {
    const r = dueSteps({ origin: 0, index: 0 }, 0, LOOP.hiddenLookaheadSec);
    expect(r.due.map((d) => d.index)).toEqual([0, 1, 2, 3]);
    expect(r.cursor.index).toBe(4);
  });

  it('a cursor ahead of a future origin waits', () => {
    const r = dueSteps({ origin: 5, index: 0 }, 4);
    expect(r.due).toEqual([]);
    expect(r.cursor).toEqual({ origin: 5, index: 0 });
  });
});

// ---------------------------------------------------------------- the flag
describe('the speaker flag', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', memoryStorage());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('parses: only an explicit off is off', () => {
    expect(parseEnabled(null)).toBe(true);
    expect(parseEnabled(undefined)).toBe(true);
    expect(parseEnabled('1')).toBe(true);
    expect(parseEnabled('garbage')).toBe(true);
    expect(parseEnabled('0')).toBe(false);
    expect(parseEnabled('off')).toBe(false);
    expect(parseEnabled('false')).toBe(false);
    expect(serializeEnabled(true)).toBe('1');
    expect(serializeEnabled(false)).toBe('0');
    expect(AUDIO_STORAGE_KEY).toBe('sv.audio');
  });

  it('defaults to on and remembers a toggle under sv.audio across instances', () => {
    const a = createAudio();
    expect(a.enabled).toBe(true);
    expect(localStorage.getItem(AUDIO_STORAGE_KEY)).toBeNull();
    a.setEnabled(false);
    expect(a.enabled).toBe(false);
    expect(localStorage.getItem(AUDIO_STORAGE_KEY)).toBe('0');
    const b = createAudio();
    expect(b.enabled).toBe(false);
    b.setEnabled(true);
    expect(b.enabled).toBe(true);
    expect(localStorage.getItem(AUDIO_STORAGE_KEY)).toBe('1');
    expect(createAudio().enabled).toBe(true);
    // the same value again writes nothing new
    localStorage.removeItem(AUDIO_STORAGE_KEY);
    b.setEnabled(true);
    expect(localStorage.getItem(AUDIO_STORAGE_KEY)).toBeNull();
    a.destroy();
    b.destroy();
  });

  it('reads a flag stored before the page loaded', () => {
    localStorage.setItem(AUDIO_STORAGE_KEY, '0');
    expect(createAudio().enabled).toBe(false);
    localStorage.setItem(AUDIO_STORAGE_KEY, '1');
    expect(createAudio().enabled).toBe(true);
  });

  it('survives a localStorage that throws, and none at all', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    });
    const a = createAudio();
    expect(a.enabled).toBe(true);
    expect(() => a.setEnabled(false)).not.toThrow();
    expect(a.enabled).toBe(false);
    vi.stubGlobal('localStorage', undefined);
    const b = createAudio();
    expect(b.enabled).toBe(true);
    expect(() => b.setEnabled(false)).not.toThrow();
    expect(b.enabled).toBe(false);
  });
});

// ---------------------------------------------------------------- no context
describe('createAudio without an AudioContext (node)', () => {
  it('reports unavailable and every sound method is a safe no-op', () => {
    expect(typeof window).toBe('undefined');
    const a = createAudio();
    expect(a.available).toBe(false);
    expect(() => a.start()).not.toThrow();
    expect(() => a.play('coin')).not.toThrow();
    expect(() => a.play('buzzer')).not.toThrow();
    expect(() => a.setEnabled(false)).not.toThrow();
    expect(() => a.setEnabled(true)).not.toThrow();
    expect(() => a.destroy()).not.toThrow();
    expect(() => a.destroy()).not.toThrow();
    expect(() => a.start()).not.toThrow();
    expect(() => a.play('click')).not.toThrow();
  });

  it('reports unavailable when window exists but has no AudioContext', () => {
    vi.stubGlobal('window', {});
    try {
      const a = createAudio();
      expect(a.available).toBe(false);
      expect(() => a.start()).not.toThrow();
      expect(() => a.play('page')).not.toThrow();
      a.destroy();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
