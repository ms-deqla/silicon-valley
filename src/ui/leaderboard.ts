/**
 * Live leaderboard (DESIGN.md 0). One document per player at `scores/<viewer id>` in
 * the artifact's shared store, readable by everyone and writable only by that
 * player (rules declared at publish: `scores` read 'view' / write 'owner',
 * `scores/{self}` write 'interact'). Reads come from one query subscription on the
 * current seed; writes are the full document, one in flight at a time, only when
 * something changed. Where the store is absent (local dev, a saved copy of the
 * page), the viewer is signed out, or the store refuses, the local player alone is
 * kept in localStorage and `shared` says so.
 *
 * Every entry is ranked by one standing, `score`: what the buzzer would pay now
 * (value × founder share) while playing, the final score once finished, so a run out
 * of cash (0) sinks to the bottom. Each document also carries `best`, the player's best
 * finished score on the seed, kept across Play again and across page loads: the tables
 * rank by it.
 *
 * Nothing here touches sim state or the DOM: localStorage and timers are the only
 * browser APIs, and every localStorage call is wrapped. Names and numbers that come
 * back from the store are other people's input: validated here, and the shell
 * renders names with textContent.
 */

export type LeaderStatus = 'playing' | 'sold' | 'dead';

export interface LeaderEntry {
  /** the player's viewer id, or 'local' in the fallback */
  id: string;
  name: string;
  seed: number;
  value: number;
  /** the standing: the final score once finished, value × founder share while playing */
  score: number;
  /** the best finished score this player posted on this seed, across runs; 0 until a run finished */
  best: number;
  month: number;
  status: LeaderStatus;
  updatedAt: number;
  /** the local player */
  me: boolean;
}

export interface LeaderUpdate {
  value: number;
  score: number;
  month: number;
  status: LeaderStatus;
}

export interface Leaderboard {
  /** resolves once we know whether the shared store is available (never rejects) */
  readonly ready: Promise<void>;
  /** the shared store answers reads for this viewer */
  readonly shared: boolean;
  /** this viewer can post (shared store writable, or the local fallback); false until `ready` resolves, and after the store refused a write */
  readonly canWrite: boolean;
  /** the shared store has not confirmed the list within 10 s of subscribing (offline, blocked): what is shown may be out of date */
  readonly stale?: boolean;
  /**
   * registers this player's run: status 'playing', value/score 0, month 0, `best` carried from this player's
   * earlier runs on the seed (this page load's, else the stored document's, read before the first write);
   * resolves once the run is registered, the shared write proceeds in the background
   */
  start(name: string, seed: number): Promise<void>;
  /** coalesced: at most one write in flight per document, the latest update wins, only when something changed; a finished score raises `best` */
  post(update: LeaderUpdate): void;
  /** entries for the current seed, sorted by score desc (the live standing), ties by name; the local player flagged me=true; fires once with what is known and on every change */
  subscribe(cb: (entries: LeaderEntry[]) => void): () => void;
  destroy(): void;
}

/** the collection every player's document lives in */
const COLLECTION = 'scores';
/** the local player's id in the fallback */
export const LOCAL_ID = 'local';
/** one localStorage key for the fallback: `{ [seed]: document }` */
const STORAGE_KEY = 'brightbyte.tournament.v1';
/** the typed player name is trimmed to this many characters */
export const NAME_MAX = 24;
const FALLBACK_NAME = 'Anonymous';
/** a listener that has heard nothing from the store for this long may be offline or blocked (db contract) */
const LOAD_TIMEOUT_MS = 10_000;
/** a write refused as 'unavailable' is retried once after a delay in this range (db contract) */
const RETRY_DELAY_MS: readonly [number, number] = [250, 1_250];
/** the read of this player's stored document at start() waits at most this long before the run is registered without it */
const READ_TIMEOUT_MS = 5_000;

const STATUSES: readonly LeaderStatus[] = ['playing', 'sold', 'dead'];

/** A document as the store holds it: plain JSON, numbers as numbers. */
type ScoreDoc = {
  name: string;
  seed: number;
  value: number;
  score: number;
  best: number;
  month: number;
  status: LeaderStatus;
  updatedAt: number;
};

function cleanName(raw: unknown): string {
  const s = typeof raw === 'string' ? raw.trim().slice(0, NAME_MAX) : '';
  return s || FALLBACK_NAME;
}

function num(x: unknown, fallback = 0): number {
  return typeof x === 'number' && Number.isFinite(x) ? x : fallback;
}

function isStatus(x: unknown): x is LeaderStatus {
  return typeof x === 'string' && (STATUSES as readonly string[]).includes(x);
}

/** A document from the store or localStorage: someone else's input, so every field is checked. */
function parseDoc(raw: unknown): ScoreDoc | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.seed !== 'number' || !Number.isFinite(r.seed) || !isStatus(r.status)) return null;
  const score = num(r.score);
  return {
    name: cleanName(r.name),
    seed: r.seed,
    value: num(r.value),
    score,
    // a document from before `best` existed: a finished score is that run's best
    best: Math.max(0, num(r.best), finished(r.status) ? score : 0),
    month: num(r.month),
    status: r.status,
    updatedAt: num(r.updatedAt),
  };
}

function toEntry(id: string, d: ScoreDoc, me: boolean): LeaderEntry {
  return { id, ...d, me };
}

function finished(status: LeaderStatus): boolean {
  return status !== 'playing';
}

function compareNames(a: LeaderEntry, b: LeaderEntry): number {
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * DESIGN.md 0, the live order: every run by what the buzzer would pay now (the score:
 * value × founder share while playing, the final score once finished), so a run out of
 * cash sinks to the bottom; ties by name, then id. Status is a flag, not a tier.
 */
export function compareEntries(a: LeaderEntry, b: LeaderEntry): number {
  const d = b.score - a.score;
  if (d !== 0) return d;
  return compareNames(a, b);
}

export function sortEntries(entries: readonly LeaderEntry[]): LeaderEntry[] {
  return [...entries].sort(compareEntries);
}

/**
 * The number the best-of-the-day tables rank by: a finished player's best score today
 * (which falls back to the score, so a document without `best` still counts); a run
 * still going by its standing, or by its earlier best when that is higher.
 */
export function bestOf(e: LeaderEntry): number {
  return Math.max(e.best, e.score);
}

/** The best-of-the-day order (start screen preview, result screen): bestOf desc, then the live order. */
export function compareBest(a: LeaderEntry, b: LeaderEntry): number {
  const d = bestOf(b) - bestOf(a);
  if (d !== 0) return d;
  return compareEntries(a, b);
}

export function sortEntriesByBest(entries: readonly LeaderEntry[]): LeaderEntry[] {
  return [...entries].sort(compareBest);
}

/** Resolves with the promise's value, or rejects as 'unavailable' once `ms` passed without it; the timer is cleared either way. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject({ code: 'unavailable', message: 'read timed out' } satisfies DbError), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

// ---------------------------------------------------------------- local fallback
type LocalStore = Record<string, ScoreDoc>;

function readLocal(): LocalStore {
  try {
    if (typeof localStorage === 'undefined') return {};
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: LocalStore = {};
    for (const [seed, value] of Object.entries(parsed as Record<string, unknown>)) {
      const d = parseDoc(value);
      if (d) out[seed] = d;
    }
    return out;
  } catch {
    return {};
  }
}

function writeLocal(seed: number, doc: ScoreDoc): void {
  try {
    if (typeof localStorage === 'undefined') return;
    const all = readLocal();
    all[String(seed)] = doc;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    // storage unavailable (private window, quota, blocked site data): the in-memory copy still shows
  }
}

/** The platform's `use`, or null outside the viewer. Nothing but `use` is read from `window.claude`. */
function platform(): Claude | null {
  if (typeof window === 'undefined') return null;
  const c = window.claude;
  return c && typeof c.use === 'function' ? c : null;
}

/** The code of a rejected call; anything without a string code counts as 'unavailable' (db contract). */
function errorCode(e: unknown): string {
  if (e && typeof e === 'object' && typeof (e as { code?: unknown }).code === 'string') return (e as { code: string }).code;
  return 'unavailable';
}

// ---------------------------------------------------------------- the board
export function createLeaderboard(): Leaderboard {
  type Mode = 'pending' | 'shared' | 'local';
  let mode: Mode = 'pending';
  let db: DB | null = null;
  let viewerId: string | null = null;
  let canWrite = false;
  let stale = false;
  let destroyed = false;

  /** this player's run: the freshest copy, ahead of whatever the store has */
  let me: ScoreDoc | null = null;
  let seed: number | null = null;
  /** bumped by every start() and by destroy(), so an older start's continuation steps aside */
  let generation = 0;
  /** the generation whose start() is still reading the stored document; writes wait for it (0: none) */
  let registering = 0;

  /** the store's documents for the current seed, by id, this viewer excluded */
  let others = new Map<string, ScoreDoc>();
  let unsubscribeQuery: Unsubscribe | null = null;
  let querySeed: number | null = null;
  let confirmed = false;
  let loadTimer: ReturnType<typeof setTimeout> | null = null;

  const listeners = new Set<(entries: LeaderEntry[]) => void>();

  // the write loop: one set() in flight, the latest state wins
  let writing = false;
  let dirty = false;
  let lastSent: string | null = null;
  let wake: (() => void) | null = null;

  function myId(): string {
    return mode === 'shared' && viewerId ? viewerId : LOCAL_ID;
  }

  function current(): LeaderEntry[] {
    const out: LeaderEntry[] = [];
    if (mode === 'shared') for (const [id, d] of others) out.push(toEntry(id, d, false));
    if (me) out.push(toEntry(myId(), me, true));
    return sortEntries(out);
  }

  function emit(): void {
    if (destroyed || listeners.size === 0) return;
    const entries = current();
    for (const cb of listeners) {
      try {
        cb(entries);
      } catch (e) {
        // one listener's failure must not stop the feed for the others
        console.error(e);
      }
    }
  }

  const ready: Promise<void> = (async () => {
    const claude = platform();
    if (claude) {
      try {
        const [store, user] = await Promise.all([claude.use('db'), claude.use('user')]);
        const id = store && user ? await user.id() : null;
        if (destroyed) return;
        if (store && id) {
          db = store;
          viewerId = id;
          mode = 'shared';
          canWrite = true;
          return;
        }
      } catch {
        // a host that misbehaves counts as no store
      }
    }
    if (destroyed) return;
    mode = 'local';
    canWrite = true;
  })();

  function clearLoadTimer(): void {
    if (loadTimer !== null) {
      clearTimeout(loadTimer);
      loadTimer = null;
    }
  }

  function stopQuery(): void {
    if (unsubscribeQuery) {
      const unsub = unsubscribeQuery;
      unsubscribeQuery = null;
      try {
        unsub();
      } catch {
        // already dead
      }
    }
    querySeed = null;
    confirmed = false;
    clearLoadTimer();
  }

  /** The store refused or stopped answering: the local player alone, in localStorage, from here on. */
  function fallBack(): void {
    stopQuery();
    db = null;
    mode = 'local';
    stale = false;
    canWrite = true;
    dirty = false;
    others = new Map();
    if (me && seed !== null) writeLocal(seed, me);
    emit();
  }

  function onSnap(snap: QuerySnapshot): void {
    if (destroyed || mode !== 'shared') return;
    const next = new Map<string, ScoreDoc>();
    for (const doc of snap.docs) {
      if (!doc.exists || doc.id === viewerId) continue;
      const d = parseDoc(doc.data());
      if (d && d.seed === querySeed) next.set(doc.id, d);
    }
    others = next;
    if (!snap.metadata || !snap.metadata.fromCache) {
      confirmed = true;
      stale = false;
      clearLoadTimer();
    }
    emit();
  }

  function onSnapError(_e: DbError): void {
    // the listener is dead whatever the code (invalid_argument, resource_exhausted, revoked, or a host that stopped answering)
    if (destroyed) return;
    fallBack();
  }

  /** Subscribe once per seed; a new seed (a new game) replaces the listener. */
  function ensureQuery(s: number): void {
    if (!db || (unsubscribeQuery && querySeed === s)) return;
    stopQuery();
    others = new Map();
    querySeed = s;
    let unsub: Unsubscribe;
    try {
      unsub = db.collection(COLLECTION).where('seed', '==', s).onSnapshot(onSnap, onSnapError);
    } catch {
      // a path the builder refuses is a programming error; the page still shows the local player
      fallBack();
      return;
    }
    if (mode !== 'shared') {
      // the error callback fired during subscribe
      try {
        unsub();
      } catch {
        // already dead
      }
      return;
    }
    unsubscribeQuery = unsub;
    if (!confirmed) {
      loadTimer = setTimeout(() => {
        loadTimer = null;
        if (destroyed || confirmed) return;
        stale = true;
        emit();
      }, LOAD_TIMEOUT_MS);
    }
  }

  function stopWriting(): void {
    canWrite = false;
    dirty = false;
    emit();
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        wake = null;
        resolve();
      }, ms);
      wake = () => {
        clearTimeout(t);
        wake = null;
        resolve();
      };
    });
  }

  /** One set(), with the db contract's handling of a rejection by code. True when the write landed. */
  async function send(ref: DocumentReference, body: ScoreDoc, mayRetry: boolean): Promise<boolean> {
    try {
      await ref.set(body);
      return true;
    } catch (e) {
      switch (errorCode(e)) {
        case 'invalid_argument':
        case 'transform_error':
          // a well-formed write refused: this viewer may not write (a view-only member); read-only from here on
          stopWriting();
          return false;
        case 'resource_exhausted':
        case 'quota_exceeded':
          // a budget or a cap: stop writing, keep reading
          stopWriting();
          return false;
        case 'revoked':
        case 'not_granted':
        case 'capability_disabled':
        case 'capability_removed':
          // terminal for this page load: calls reject from here on
          stopWriting();
          return false;
        default:
          // 'unavailable' and anything unknown: retry once after a short randomized delay
          if (!mayRetry) return false;
          await sleep(RETRY_DELAY_MS[0] + Math.random() * (RETRY_DELAY_MS[1] - RETRY_DELAY_MS[0]));
          if (destroyed || mode !== 'shared' || !canWrite) return false;
          return send(ref, body, false);
      }
    }
  }

  function requestWrite(): void {
    dirty = true;
    void pump();
  }

  /**
   * The loop: awaits each set() before sending the next; a burst of posts collapses into
   * the latest state. Nothing is sent while start() is still reading the stored document,
   * so the first write never replaces the best it carries.
   */
  async function pump(): Promise<void> {
    if (writing) return;
    writing = true;
    try {
      while (dirty && !destroyed && mode === 'shared' && canWrite && db && viewerId && me && registering === 0) {
        dirty = false;
        const body: ScoreDoc = { ...me };
        const json = JSON.stringify(body);
        if (json === lastSent) continue;
        let ref: DocumentReference;
        try {
          ref = db.doc(`${COLLECTION}/${viewerId}`);
        } catch {
          stopWriting();
          break;
        }
        if (await send(ref, body, true)) lastSent = json;
      }
    } finally {
      writing = false;
    }
  }

  /**
   * This player's document as the store holds it, for the best from an earlier page
   * load today; 0 when there is none, it is on another seed, or it cannot be read in time.
   */
  async function storedBest(s: number): Promise<number> {
    if (!db || !viewerId) return 0;
    let ref: DocumentReference;
    try {
      ref = db.doc(`${COLLECTION}/${viewerId}`);
    } catch {
      return 0;
    }
    try {
      const snap = await withTimeout(ref.get(), READ_TIMEOUT_MS);
      if (!snap.exists) return 0;
      const d = parseDoc(snap.data());
      return d && d.seed === s ? d.best : 0;
    } catch {
      // refused, unreachable or slow: the run is registered without it; a later finish still keeps the max of what is known
      return 0;
    }
  }

  async function start(name: string, s: number): Promise<void> {
    if (destroyed) return;
    const gen = ++generation;
    // best of the day (DESIGN.md 0): a new run on the same seed carries the best finished score so far
    const previous = me && me.seed === s ? me : null;
    seed = s;
    me = { name: cleanName(name), seed: s, value: 0, score: 0, best: previous ? previous.best : 0, month: 0, status: 'playing', updatedAt: Date.now() };
    lastSent = null;
    emit();
    await ready;
    if (destroyed || gen !== generation) return;
    if (mode === 'shared') {
      ensureQuery(s);
      if (mode === 'shared' && !previous) {
        // the first run on this seed in this page load: an earlier page load's best is in the store, read before the first write replaces it
        registering = gen;
        const stored = await storedBest(s);
        if (registering === gen) registering = 0;
        if (destroyed || gen !== generation) return;
        if (me && stored > me.best) me = { ...me, best: stored };
      }
    }
    if (mode === 'shared') {
      requestWrite();
    } else if (mode === 'local' && me) {
      const stored = readLocal()[String(s)];
      if (stored && stored.seed === s && stored.best > me.best) me = { ...me, best: stored.best };
      writeLocal(s, me);
    }
    emit();
  }

  function post(u: LeaderUpdate): void {
    if (destroyed || !me) return;
    const status = isStatus(u.status) ? u.status : me.status;
    const score = Math.round(num(u.score));
    const next: ScoreDoc = {
      ...me,
      value: Math.round(num(u.value)),
      score,
      month: Math.round(num(u.month)),
      status,
      // best of the day (DESIGN.md 0): a finished score counts toward the best, which never goes down
      best: finished(status) ? Math.max(me.best, score) : me.best,
    };
    if (next.value === me.value && next.score === me.score && next.month === me.month && next.status === me.status && next.best === me.best) return;
    next.updatedAt = Date.now();
    me = next;
    if (mode === 'local' && seed !== null) writeLocal(seed, me);
    emit();
    if (mode === 'shared') requestWrite();
  }

  function subscribe(cb: (entries: LeaderEntry[]) => void): () => void {
    if (destroyed) return () => {};
    listeners.add(cb);
    cb(current());
    return () => {
      listeners.delete(cb);
    };
  }

  function destroy(): void {
    if (destroyed) return;
    destroyed = true;
    generation++;
    stopQuery();
    if (wake) wake();
    dirty = false;
    listeners.clear();
    db = null;
  }

  return {
    ready,
    get shared() {
      return mode === 'shared';
    },
    get canWrite() {
      return canWrite;
    },
    get stale() {
      return stale;
    },
    start,
    post,
    subscribe,
    destroy,
  };
}
