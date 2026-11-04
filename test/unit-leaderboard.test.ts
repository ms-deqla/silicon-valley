/**
 * The live leaderboard module against a fake `window.claude` (an in-memory store
 * implementing the db subset the module uses) and a Map-backed localStorage.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_ID, createLeaderboard, sortEntries, sortEntriesByBest } from '../src/ui/leaderboard';
import type { LeaderEntry, Leaderboard } from '../src/ui/leaderboard';
import { storeCaption } from '../src/ui/leaderstrip';

const SEED = 20261103;
const KEY = 'brightbyte.tournament.v1';

// ---------------------------------------------------------------- shims
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

interface FakeListener {
  collection: string;
  filters: [string, string, unknown][];
  next: (snap: QuerySnapshot) => void;
  error?: (e: DbError) => void;
}

interface FakeDb {
  db: DB;
  docs: Map<string, Record<string, unknown>>;
  listeners: Set<FakeListener>;
  setCalls: number;
  bodies: Record<string, unknown>[];
  /** decides per set() call (1-based) whether it rejects, and with which code */
  failSet: ((call: number) => DbErrorCode | null) | null;
  /** snapshots carry this provenance */
  fromCache: boolean;
  /** get() never answers (the store cannot be reached) */
  hangGet: boolean;
  /** another player's page wrote this document */
  put(path: string, body: Record<string, unknown>): void;
  /** the store terminates every listener with this code */
  fail(code: DbErrorCode): void;
}

function createFakeDb(): FakeDb {
  const docs = new Map<string, Record<string, unknown>>();
  const listeners = new Set<FakeListener>();
  const idOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1);
  const metadata = (): SnapshotMetadata => ({ fromCache: fake.fromCache, hasPendingWrites: false });
  const snapOf = (path: string, body: Record<string, unknown>): DocumentSnapshot => ({ id: idOf(path), exists: true, data: () => body, metadata: metadata() });
  const matches = (l: FakeListener, path: string, body: Record<string, unknown>): boolean => {
    const parts = path.split('/');
    if (parts.length !== 2 || parts[0] !== l.collection) return false;
    return l.filters.every(([field, op, value]) => op === '==' && body[field] === value);
  };
  const snapshotFor = (l: FakeListener): QuerySnapshot => {
    const list = [...docs.entries()].filter(([p, b]) => matches(l, p, b)).map(([p, b]) => snapOf(p, b));
    return { docs: list, size: list.length, empty: list.length === 0, docChanges: () => [], metadata: metadata() };
  };
  const notify = (): void => {
    for (const l of listeners) l.next(snapshotFor(l));
  };
  const docRef = (path: string): DocumentReference => ({
    id: idOf(path),
    path,
    get: async () => {
      if (fake.hangGet) await new Promise<never>(() => {});
      const b = docs.get(path);
      return { id: idOf(path), exists: b !== undefined, data: () => b, metadata: metadata() };
    },
    set: async (data) => {
      fake.setCalls++;
      fake.bodies.push(data);
      const code = fake.failSet ? fake.failSet(fake.setCalls) : null;
      await Promise.resolve(); // a real store answers later
      if (code) throw { code, message: `fake ${code}` } satisfies DbError;
      docs.set(path, JSON.parse(JSON.stringify(data)) as Record<string, unknown>);
      notify();
    },
    onSnapshot: () => {
      throw new Error('document listeners are not part of the subset');
    },
  });
  const query = (collection: string, filters: FakeListener['filters']): Query => ({
    where: (field, op, value) => query(collection, [...filters, [field, op, value]]),
    get: async () => snapshotFor({ collection, filters, next: () => {} }),
    onSnapshot: (next, error) => {
      const l: FakeListener = { collection, filters, next, error };
      listeners.add(l);
      next(snapshotFor(l));
      return () => {
        listeners.delete(l);
      };
    },
  });
  const db: DB = {
    doc: docRef,
    collection: (path) => ({ ...query(path, []), path, doc: (id?: string) => docRef(`${path}/${id ?? `d${docs.size + 1}`}`) }),
  };
  const fake: FakeDb = {
    db,
    docs,
    listeners,
    setCalls: 0,
    bodies: [],
    failSet: null,
    fromCache: false,
    hangGet: false,
    put(path, body) {
      docs.set(path, body);
      notify();
    },
    fail(code) {
      for (const l of [...listeners]) {
        listeners.delete(l);
        l.error?.({ code, message: `fake ${code}` });
      }
    },
  };
  return fake;
}

/** A viewer: window.claude whose use('db') is the fake store and use('user') knows this id. */
function stubViewer(fake: FakeDb, userId: string | null = 'u1'): void {
  vi.stubGlobal('window', {
    claude: {
      use: async (name: string) => (name === 'db' ? fake.db : name === 'user' ? { id: async () => userId } : null),
    },
  });
}

/** Lets the write loop and the fake store's microtasks settle (works under fake timers too). */
async function flush(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

const doc = (over: Partial<Record<string, unknown>> = {}): Record<string, unknown> => ({
  name: 'Other',
  seed: SEED,
  value: 0,
  score: 0,
  month: 0,
  status: 'playing',
  updatedAt: 1,
  ...over,
});

const boards: Leaderboard[] = [];
function make(): Leaderboard {
  const lb = createLeaderboard();
  boards.push(lb);
  return lb;
}

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
});

afterEach(() => {
  for (const b of boards.splice(0)) b.destroy();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ---------------------------------------------------------------- shared store
describe('leaderboard on the shared store', () => {
  it('start creates this player\'s document at scores/<viewer id>', async () => {
    const fake = createFakeDb();
    stubViewer(fake);
    const lb = make();
    expect(lb.canWrite).toBe(false);
    await lb.ready;
    expect(lb.shared).toBe(true);
    expect(lb.canWrite).toBe(true);
    await lb.start('  Mike  ', SEED);
    await flush();
    expect(fake.setCalls).toBe(1);
    expect(fake.docs.get('scores/u1')).toEqual({ name: 'Mike', seed: SEED, value: 0, score: 0, best: 0, month: 0, status: 'playing', updatedAt: expect.any(Number) });
    expect(fake.listeners.size).toBe(1);
  });

  it('trims the typed name to 24 characters and never stores an empty one', async () => {
    const fake = createFakeDb();
    stubViewer(fake);
    const lb = make();
    await lb.start('abcdefghijklmnopqrstuvwxyz0123', SEED);
    await flush();
    expect(fake.docs.get('scores/u1')?.name).toBe('abcdefghijklmnopqrstuvwx');
    const lb2 = make();
    await lb2.start('   ', SEED);
    await flush();
    expect(fake.docs.get('scores/u1')?.name).toBe('Anonymous');
  });

  it('post coalesces a burst into one in-flight write and the latest state', async () => {
    const fake = createFakeDb();
    stubViewer(fake);
    const lb = make();
    await lb.start('Mike', SEED);
    await flush();
    const before = fake.setCalls;
    lb.post({ value: 100, score: 100, month: 1, status: 'playing' });
    lb.post({ value: 200, score: 200, month: 2, status: 'playing' });
    lb.post({ value: 300, score: 300, month: 3, status: 'playing' });
    await flush();
    const writes = fake.setCalls - before;
    expect(writes).toBeGreaterThanOrEqual(1);
    expect(writes).toBeLessThanOrEqual(2);
    expect(fake.docs.get('scores/u1')).toMatchObject({ name: 'Mike', seed: SEED, value: 300, score: 300, month: 3, status: 'playing' });
    // nothing changed: nothing written
    lb.post({ value: 300, score: 300, month: 3, status: 'playing' });
    await flush();
    expect(fake.setCalls).toBe(before + writes);
    // the end of the round
    lb.post({ value: 300, score: 150, month: 3, status: 'sold' });
    await flush();
    expect(fake.docs.get('scores/u1')).toMatchObject({ score: 150, status: 'sold' });
  });

  it('subscribe sorts every run by its standing (score), playing or finished, and flags me', async () => {
    const fake = createFakeDb();
    fake.put('scores/u2', doc({ name: 'Sold', status: 'sold', score: 500, value: 10 }));
    fake.put('scores/u3', doc({ name: 'Dead', status: 'dead', score: 0, value: 999 }));
    fake.put('scores/u4', doc({ name: 'Beta', value: 900, score: 450 }));
    fake.put('scores/u5', doc({ name: 'Elsewhere', value: 5000, score: 5000, seed: SEED + 1 }));
    fake.put('scores/u6', doc({ name: 'Alpha', value: 900, score: 450 }));
    fake.put('scores/u7', { name: 'Broken', seed: SEED, status: 'winning' });
    stubViewer(fake);
    const lb = make();
    const seen: LeaderEntry[][] = [];
    const off = lb.subscribe((entries) => seen.push(entries));
    expect(seen).toEqual([[]]); // fires once with what is known
    await lb.start('Mike', SEED);
    await flush();
    const last = seen[seen.length - 1];
    // 500, then the 450 tie by name, then the zeros (out of cash and a fresh start) by name
    expect(last.map((e) => e.id)).toEqual(['u2', 'u6', 'u4', 'u3', 'u1']);
    expect(last.map((e) => e.me)).toEqual([false, false, false, false, true]);
    expect(last.find((e) => e.me)).toMatchObject({ id: 'u1', name: 'Mike', seed: SEED, status: 'playing', value: 0, score: 0, best: 0 });
    // a run still going tops a finished one when the buzzer would pay more now
    lb.post({ value: 950, score: 900, month: 4, status: 'playing' });
    await flush();
    expect(seen[seen.length - 1].map((e) => e.id)).toEqual(['u1', 'u2', 'u6', 'u4', 'u3']);
    // another player's change arrives live
    fake.put('scores/u4', doc({ name: 'Beta', status: 'sold', score: 700 }));
    expect(seen[seen.length - 1].map((e) => e.id)).toEqual(['u1', 'u4', 'u2', 'u6', 'u3']);
    off();
    const count = seen.length;
    fake.put('scores/u6', doc({ name: 'Alpha', value: 1 }));
    expect(seen.length).toBe(count);
  });

  it('best keeps the top finished score across Play again and never goes down', async () => {
    const fake = createFakeDb();
    stubViewer(fake);
    const lb = make();
    await lb.start('Mike', SEED);
    await flush();
    lb.post({ value: 1000, score: 500, month: 3, status: 'sold' });
    await flush();
    expect(fake.docs.get('scores/u1')).toMatchObject({ score: 500, best: 500, status: 'sold' });
    // Play again: a fresh run that carries the best
    await lb.start('Mike', SEED);
    await flush();
    expect(fake.docs.get('scores/u1')).toMatchObject({ score: 0, best: 500, status: 'playing', month: 0 });
    lb.post({ value: 400, score: 300, month: 2, status: 'sold' });
    await flush();
    expect(fake.docs.get('scores/u1')).toMatchObject({ score: 300, best: 500 });
    // out of cash scores 0 and leaves the best alone
    await lb.start('Mike', SEED);
    lb.post({ value: 0, score: 0, month: 5, status: 'dead' });
    await flush();
    expect(fake.docs.get('scores/u1')).toMatchObject({ score: 0, best: 500, status: 'dead' });
    // a better finish raises it
    await lb.start('Mike', SEED);
    lb.post({ value: 1400, score: 700, month: 9, status: 'sold' });
    await flush();
    expect(fake.docs.get('scores/u1')).toMatchObject({ score: 700, best: 700 });
    // a run still going never counts, however high it stands
    await lb.start('Mike', SEED);
    lb.post({ value: 5000, score: 5000, month: 1, status: 'playing' });
    await flush();
    expect(fake.docs.get('scores/u1')).toMatchObject({ score: 5000, best: 700, status: 'playing' });
    // another seed starts from nothing
    await lb.start('Mike', SEED + 1);
    await flush();
    expect(fake.docs.get('scores/u1')).toMatchObject({ seed: SEED + 1, best: 0 });
  });

  it('a new page load reads the stored best before its first write, even with a post already waiting', async () => {
    const fake = createFakeDb();
    // written by an earlier page load today, before `best` existed: a finished score is that run's best
    fake.put('scores/u1', doc({ name: 'Mike', status: 'sold', score: 600, value: 1200, month: 12 }));
    stubViewer(fake);
    const lb = make();
    const seen: LeaderEntry[][] = [];
    lb.subscribe((entries) => seen.push(entries));
    const started = lb.start('Mike', SEED);
    lb.post({ value: 10, score: 10, month: 1, status: 'playing' });
    await started;
    await flush();
    expect(fake.setCalls).toBeGreaterThanOrEqual(1);
    expect(fake.bodies[0]).toMatchObject({ best: 600, score: 10, status: 'playing' });
    expect(fake.docs.get('scores/u1')).toMatchObject({ best: 600, score: 10, status: 'playing' });
    expect(seen[seen.length - 1].find((e) => e.me)).toMatchObject({ best: 600, score: 10 });
    lb.post({ value: 100, score: 50, month: 2, status: 'sold' });
    await flush();
    expect(fake.docs.get('scores/u1')).toMatchObject({ best: 600, score: 50, status: 'sold' });
  });

  it('a stored document that never arrives holds the first write for 5 s, no longer', async () => {
    vi.useFakeTimers();
    const fake = createFakeDb();
    fake.hangGet = true;
    stubViewer(fake);
    const lb = make();
    const started = lb.start('Mike', SEED);
    await flush();
    expect(fake.setCalls).toBe(0);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(fake.setCalls).toBe(0);
    await vi.advanceTimersByTimeAsync(1_100);
    await started;
    await flush();
    expect(fake.setCalls).toBe(1);
    expect(fake.docs.get('scores/u1')).toMatchObject({ name: 'Mike', seed: SEED, best: 0, status: 'playing' });
  });

  it('invalid_argument on a write flips canWrite and keeps reading', async () => {
    const fake = createFakeDb();
    fake.failSet = () => 'invalid_argument';
    stubViewer(fake);
    const lb = make();
    const seen: LeaderEntry[][] = [];
    lb.subscribe((entries) => seen.push(entries));
    await lb.start('Mike', SEED);
    await flush();
    expect(fake.setCalls).toBe(1);
    expect(lb.canWrite).toBe(false);
    expect(lb.shared).toBe(true);
    expect(fake.listeners.size).toBe(1);
    fake.put('scores/u2', doc({ name: 'Other', value: 10, score: 10 }));
    const last = seen[seen.length - 1];
    expect(last.map((e) => e.id)).toEqual(['u2', 'u1']);
    expect(last[1].me).toBe(true);
    lb.post({ value: 50, score: 50, month: 1, status: 'playing' });
    await flush();
    expect(fake.setCalls).toBe(1);
  });

  it('quota_exceeded stops writing and keeps reading', async () => {
    const fake = createFakeDb();
    fake.failSet = (call) => (call === 2 ? 'quota_exceeded' : null);
    stubViewer(fake);
    const lb = make();
    await lb.start('Mike', SEED);
    await flush();
    lb.post({ value: 50, score: 50, month: 1, status: 'playing' });
    await flush();
    expect(fake.setCalls).toBe(2);
    expect(lb.canWrite).toBe(false);
    expect(lb.shared).toBe(true);
    lb.post({ value: 60, score: 60, month: 2, status: 'playing' });
    await flush();
    expect(fake.setCalls).toBe(2);
  });

  it('unavailable retries once after a short delay, then gives up until the next post', async () => {
    vi.useFakeTimers();
    const fake = createFakeDb();
    fake.failSet = (call) => (call === 2 || call === 4 || call === 5 ? 'unavailable' : null);
    stubViewer(fake);
    const lb = make();
    await lb.start('Mike', SEED);
    await flush();
    expect(fake.setCalls).toBe(1);
    lb.post({ value: 100, score: 50, month: 1, status: 'playing' });
    await flush();
    expect(fake.setCalls).toBe(2); // refused once
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fake.setCalls).toBe(3); // the one retry landed
    expect(fake.docs.get('scores/u1')).toMatchObject({ value: 100, score: 50, month: 1 });
    expect(lb.canWrite).toBe(true);
    lb.post({ value: 200, score: 100, month: 2, status: 'playing' });
    await flush();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fake.setCalls).toBe(5); // refused twice: given up, no loop
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fake.setCalls).toBe(5);
    expect(fake.docs.get('scores/u1')).toMatchObject({ value: 100 });
    lb.post({ value: 300, score: 150, month: 3, status: 'playing' });
    await flush();
    expect(fake.setCalls).toBe(6);
    expect(fake.docs.get('scores/u1')).toMatchObject({ value: 300, month: 3 });
  });

  it('marks the list stale after 10 s without a confirmed snapshot', async () => {
    vi.useFakeTimers();
    const fake = createFakeDb();
    fake.fromCache = true;
    stubViewer(fake);
    const lb = make();
    const seen: LeaderEntry[][] = [];
    lb.subscribe((entries) => seen.push(entries));
    await lb.start('Mike', SEED);
    await flush();
    expect(lb.stale).toBe(false);
    const count = seen.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(lb.stale).toBe(true);
    expect(seen.length).toBe(count + 1);
    fake.fromCache = false;
    fake.put('scores/u2', doc());
    expect(lb.stale).toBe(false);
    expect(lb.shared).toBe(true);
  });

  it('a terminated listener falls back to the local player', async () => {
    const fake = createFakeDb();
    fake.put('scores/u2', doc({ value: 10, score: 10 }));
    stubViewer(fake);
    const lb = make();
    const seen: LeaderEntry[][] = [];
    lb.subscribe((entries) => seen.push(entries));
    await lb.start('Mike', SEED);
    await flush();
    expect(seen[seen.length - 1].map((e) => e.id)).toEqual(['u2', 'u1']);
    fake.fail('revoked');
    expect(lb.shared).toBe(false);
    expect(lb.canWrite).toBe(true);
    expect(fake.listeners.size).toBe(0);
    expect(seen[seen.length - 1].map((e) => e.id)).toEqual([LOCAL_ID]);
    const calls = fake.setCalls;
    lb.post({ value: 10, score: 10, month: 1, status: 'playing' });
    await flush();
    expect(fake.setCalls).toBe(calls);
    expect(JSON.parse(localStorage.getItem(KEY) as string)[String(SEED)]).toMatchObject({ name: 'Mike', value: 10, month: 1 });
  });

  it('a new seed replaces the listener; the same seed keeps it', async () => {
    const fake = createFakeDb();
    stubViewer(fake);
    const lb = make();
    await lb.start('Mike', SEED);
    await flush();
    const [first] = [...fake.listeners];
    await lb.start('Mike', SEED);
    await flush();
    expect([...fake.listeners]).toEqual([first]);
    await lb.start('Mike', SEED + 1);
    await flush();
    expect(fake.listeners.size).toBe(1);
    expect([...fake.listeners][0]).not.toBe(first);
    expect(fake.docs.get('scores/u1')).toMatchObject({ seed: SEED + 1, value: 0 });
  });

  it('destroy unsubscribes, stops the loop and silences subscribers', async () => {
    const fake = createFakeDb();
    stubViewer(fake);
    const lb = make();
    const seen: LeaderEntry[][] = [];
    lb.subscribe((entries) => seen.push(entries));
    await lb.start('Mike', SEED);
    await flush();
    const calls = fake.setCalls;
    const count = seen.length;
    lb.destroy();
    expect(fake.listeners.size).toBe(0);
    fake.put('scores/u2', doc());
    lb.post({ value: 10, score: 10, month: 1, status: 'playing' });
    await flush();
    expect(seen.length).toBe(count);
    expect(fake.setCalls).toBe(calls);
    expect(lb.subscribe(() => seen.push([]))).toBeTypeOf('function');
    expect(seen.length).toBe(count);
  });
});

// ---------------------------------------------------------------- fallback
describe('leaderboard without the shared store', () => {
  it('without window.claude the local fallback stores and reads back', async () => {
    const lb = make();
    await lb.ready;
    expect(lb.shared).toBe(false);
    expect(lb.canWrite).toBe(true);
    const seen: LeaderEntry[][] = [];
    lb.subscribe((entries) => seen.push(entries));
    expect(seen).toEqual([[]]);
    await lb.start('Mike', SEED);
    lb.post({ value: 120, score: 90, month: 2, status: 'playing' });
    const stored = JSON.parse(localStorage.getItem(KEY) as string) as Record<string, Record<string, unknown>>;
    expect(stored[String(SEED)]).toEqual({ name: 'Mike', seed: SEED, value: 120, score: 90, best: 0, month: 2, status: 'playing', updatedAt: expect.any(Number) });
    const last = seen[seen.length - 1];
    expect(last).toHaveLength(1);
    expect(last[0]).toEqual({ id: LOCAL_ID, me: true, ...stored[String(SEED)] });
    lb.post({ value: 120, score: 60, month: 2, status: 'dead' });
    expect(JSON.parse(localStorage.getItem(KEY) as string)[String(SEED)]).toMatchObject({ status: 'dead', score: 60, best: 60 });
  });

  it('the local fallback keeps the best across start() and across page loads', async () => {
    const read = (): Record<string, unknown> => JSON.parse(localStorage.getItem(KEY) as string)[String(SEED)] as Record<string, unknown>;
    const lb = make();
    await lb.start('Mike', SEED);
    lb.post({ value: 100, score: 80, month: 2, status: 'sold' });
    expect(read()).toMatchObject({ score: 80, best: 80 });
    await lb.start('Mike', SEED);
    expect(read()).toMatchObject({ score: 0, best: 80, status: 'playing' });
    lb.post({ value: 50, score: 20, month: 1, status: 'sold' });
    expect(read()).toMatchObject({ score: 20, best: 80 });
    // a new page load reads it back from localStorage
    const lb2 = make();
    const seen: LeaderEntry[][] = [];
    lb2.subscribe((entries) => seen.push(entries));
    await lb2.start('Mike', SEED);
    expect(read()).toMatchObject({ score: 0, best: 80, status: 'playing' });
    expect(seen[seen.length - 1][0]).toMatchObject({ id: LOCAL_ID, me: true, best: 80 });
    lb2.post({ value: 300, score: 150, month: 4, status: 'sold' });
    expect(read()).toMatchObject({ score: 150, best: 150 });
  });

  it('a signed-out viewer with a store is local too', async () => {
    const fake = createFakeDb();
    stubViewer(fake, null);
    const lb = make();
    await lb.ready;
    expect(lb.shared).toBe(false);
    await lb.start('Mike', SEED);
    await flush();
    expect(fake.setCalls).toBe(0);
    expect(fake.listeners.size).toBe(0);
  });

  it('use() resolving null or throwing never rejects ready', async () => {
    vi.stubGlobal('window', { claude: { use: async () => null } });
    const lb = make();
    await expect(lb.ready).resolves.toBeUndefined();
    expect(lb.shared).toBe(false);
    vi.stubGlobal('window', {
      claude: {
        use: () => {
          throw new Error('boom');
        },
      },
    });
    const lb2 = make();
    await expect(lb2.ready).resolves.toBeUndefined();
    expect(lb2.shared).toBe(false);
    expect(lb2.canWrite).toBe(true);
  });

  it('survives a localStorage that throws', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    });
    const lb = make();
    await lb.start('Mike', SEED);
    lb.post({ value: 5, score: 5, month: 1, status: 'playing' });
    const seen: LeaderEntry[][] = [];
    lb.subscribe((entries) => seen.push(entries));
    expect(seen[0]).toHaveLength(1);
    expect(seen[0][0]).toMatchObject({ id: LOCAL_ID, me: true, value: 5 });
  });
});

describe('sortEntries', () => {
  const entry = (over: Partial<LeaderEntry>): LeaderEntry => ({ id: 'x', name: 'x', seed: SEED, value: 0, score: 0, best: 0, month: 0, status: 'playing', updatedAt: 0, me: false, ...over });

  it('every run by score, status only a flag, ties by name then id', () => {
    const sorted = sortEntries([
      entry({ id: 'a', name: 'A', value: 200, score: 100 }),
      entry({ id: 'b', name: 'B', value: 900, score: 900 }),
      entry({ id: 'c', name: 'C', status: 'dead', score: 0, value: 5000 }),
      entry({ id: 'd', name: 'D', status: 'sold', score: 50 }),
      entry({ id: 'e', name: 'B', value: 900, score: 900 }),
      entry({ id: 'f', name: 'A', value: 1800, score: 900 }),
    ]);
    expect(sorted.map((e) => e.id)).toEqual(['f', 'b', 'e', 'a', 'd', 'c']);
  });

  it('the tables rank by the best of the day: a finished player\'s best (or score), a run still going by the higher of its standing and its earlier best', () => {
    const sorted = sortEntriesByBest([
      entry({ id: 'a', name: 'A', score: 100 }),
      entry({ id: 'b', name: 'B', score: 200, best: 800 }),
      entry({ id: 'c', name: 'C', status: 'dead', score: 0, best: 300 }),
      entry({ id: 'd', name: 'D', status: 'sold', score: 500, best: 500 }),
      entry({ id: 'e', name: 'E', status: 'sold', score: 50 }),
      entry({ id: 'f', name: 'F', score: 300 }),
    ]);
    // the 300 tie (an earlier best vs a standing) breaks like the live order: by score
    expect(sorted.map((e) => e.id)).toEqual(['b', 'd', 'f', 'c', 'a', 'e']);
  });
});

describe('storeCaption', () => {
  const lb = (over: Partial<Pick<Leaderboard, 'shared' | 'canWrite' | 'stale'>>): Leaderboard =>
    ({ shared: true, canWrite: true, stale: false, ...over }) as unknown as Leaderboard;

  it('says when the list is local, unavailable or may be out of date', () => {
    expect(storeCaption(lb({}))).toBe('');
    expect(storeCaption(lb({ stale: true }))).toBe('Leaderboard may be out of date');
    expect(storeCaption(lb({ shared: false, stale: true }))).toBe('Local only');
    expect(storeCaption(lb({ shared: false, canWrite: false }))).toBe('Leaderboard unavailable');
  });
});
