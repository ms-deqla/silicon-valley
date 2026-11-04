/**
 * Live leaderboard (DESIGN.md 0). One document per player at `scores/<viewer id>` in
 * the artifact's shared store, readable by everyone and writable only by that
 * player (rules declared at publish: `scores` read 'view' / write 'owner',
 * `scores/{self}` write 'interact'). Reads come from one query subscription on the
 * current seed, opened by watch() (the start screen's preview of today's players)
 * or by start(); writes are the full document, one in flight at a time, only when
 * something changed.
 *
 * Two ways the shared store can fail this viewer, handled differently:
 * - the store refuses a write (a view-only member, a cap, a revoked grant): the page
 *   keeps reading the shared list, `canWrite` goes false so the caption says the run
 *   is not posted, and the run is kept in localStorage so its best survives a reload;
 * - the listener dies, or there is no store at all (local dev, a saved copy of the
 *   page, a signed-out viewer): `shared` goes false, the local player alone is shown
 *   from localStorage, and the caption says so.
 *
 * The live order (DESIGN.md 0): finished runs by score, then runs still going by
 * company value, last the runs left mid-round (a 'playing' document not updated for
 * two rounds, which cannot still be playing since the round clock never stops).
 * DESIGN is silent on how finished and running runs interleave; finished first is the
 * simplest rule that keeps a real score above a provisional value. Each document also
 * carries `best`, the player's best finished score on the seed, kept across Play again
 * and across page loads: the tables rank by it.
 *
 * A third transport, chosen at build time (DESIGN.md 0, the hosted game): when
 * `VITE_LEADERBOARD_URL` is set, the same documents go over HTTP to the leaderboard
 * service (server/): `PUT /scores/<device id>` with the whole document, coalesced
 * exactly like the store writes, and `GET /scores?seed=` polled every 5 s while
 * someone subscribes (and once after every write). The device id is minted once into
 * localStorage (a per-session id where storage is blocked). HTTP counts as the shared
 * store: `shared` and `canWrite` are true, a failed poll keeps the last list and is
 * retried on the next tick, and the list is `stale` after 10 s without a good answer.
 * The artifact store stays preferred when the page runs in the viewer and no URL is
 * set; the local fallback stays last.
 *
 * Nothing here touches sim state or the DOM (RULES is read for the round length):
 * localStorage, fetch and timers are the only browser APIs, and every localStorage
 * call is wrapped. Names and numbers that come back from the store are other people's input:
 * validated here, and the shell renders names with textContent.
 */
import { RULES } from '../sim';

export type LeaderStatus = 'playing' | 'sold' | 'dead';

/**
 * DESIGN.md 20: the eight named pastel colours a player picks from on the start screen,
 * stored as `color` in the player's document and used in the strip and the tables.
 */
export const COLORS = ['rose', 'peach', 'lemon', 'mint', 'sky', 'lilac', 'sand', 'slate'] as const;
export type Color = (typeof COLORS)[number];
export const COLOR_HEX: Record<Color, string> = {
  rose: '#f7b9c8',
  peach: '#f9cba8',
  lemon: '#f5e59b',
  mint: '#b7e8c7',
  sky: '#b9d8f7',
  lilac: '#d5c4f5',
  sand: '#e9d8b8',
  slate: '#c7d0da',
};
/** a document without a colour (written before colours existed, or a value the list does not know) reads as this */
export const DEFAULT_COLOR: Color = 'sky';

export function isColor(x: unknown): x is Color {
  return typeof x === 'string' && (COLORS as readonly string[]).includes(x);
}

export interface LeaderEntry {
  /** the player's viewer id, or 'local' in the fallback */
  id: string;
  name: string;
  /** DESIGN.md 20: the colour the player chose, one of the eight names */
  color: Color;
  seed: number;
  value: number;
  /** the final score once finished; while playing, what the buzzer would pay now (value × founder share), posted for the record */
  score: number;
  /** the best finished score this player posted on this seed, across runs; 0 until a run finished */
  best: number;
  month: number;
  status: LeaderStatus;
  updatedAt: number;
  /** the local player */
  me: boolean;
  /** a run left mid-round: a 'playing' document not updated for two rounds (derived here, never stored; never true for this page's own run) */
  abandoned: boolean;
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
  /** this viewer can post (shared store writable, or the local fallback); false until `ready` resolves, and after the store refused a write (the run is then kept in this browser only) */
  readonly canWrite: boolean;
  /** the shared store has not confirmed the list within 10 s of subscribing (offline, blocked): what is shown may be out of date */
  readonly stale?: boolean;
  /**
   * reads today's players before a run starts (the start screen's preview): opens the seed's
   * query on the shared store, or shows this browser's stored run in the fallback; a later
   * start() on the same seed keeps the listener
   */
  watch(seed: number): void;
  /**
   * registers this player's run: status 'playing', value/score 0, month 0, `best` carried from this player's
   * earlier runs on the seed (this page load's, else the stored document's, read before the first write,
   * else the copy kept in this browser); resolves once the run is registered, the shared write proceeds in the background.
   * `color` (DESIGN.md 20) is the colour the player chose; DEFAULT_COLOR when omitted.
   */
  start(name: string, seed: number, color?: Color): Promise<void>;
  /** coalesced: at most one write in flight per document, the latest update wins, only when something changed; a finished score raises `best` */
  post(update: LeaderUpdate): void;
  /**
   * entries for the current seed in the live order (compareEntries); the local player flagged me=true
   * (this page's run, else this viewer's stored document); fires once with what is known and on every change
   */
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
/** a 'playing' document is counted as left mid-round after this many rounds without an update */
const ABANDONED_AFTER_ROUNDS = 2;
/** the HTTP transport polls the seed's list this often while someone subscribes */
const POLL_MS = 5_000;
/** one localStorage key for the device id the HTTP transport writes under */
const DEVICE_KEY = 'brightbyte.device.v1';
const DEVICE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const STATUSES: readonly LeaderStatus[] = ['playing', 'sold', 'dead'];

/** A document as the store holds it: plain JSON, numbers as numbers. */
type ScoreDoc = {
  name: string;
  color: Color;
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
    color: isColor(r.color) ? r.color : DEFAULT_COLOR,
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

function finished(status: LeaderStatus): boolean {
  return status !== 'playing';
}

/**
 * DESIGN.md 0: the round clock never stops, so a 'playing' document this old was left
 * mid-round; two rounds tolerate clock skew between players and a hidden tab's catch-up.
 */
function abandonedAfterMs(): number {
  return RULES.roundSeconds * 1000 * ABANDONED_AFTER_ROUNDS;
}

function isAbandoned(d: ScoreDoc, now: number): boolean {
  return d.status === 'playing' && now - d.updatedAt > abandonedAfterMs();
}

function toEntry(id: string, d: ScoreDoc, me: boolean, abandoned: boolean): LeaderEntry {
  return { id, ...d, me, abandoned };
}

function compareNames(a: LeaderEntry, b: LeaderEntry): number {
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** The number a run is ranked by live (DESIGN.md 0): its score once finished, its company value while playing. */
export function standing(e: LeaderEntry): number {
  // DESIGN.md 0: one standing for everyone, posted as `score`: the final score once finished,
  // what the buzzer would pay now (value × founder share) while playing
  return e.score;
}

/** The live tiers: every live or finished run first, runs left mid-round last. */
function tier(e: LeaderEntry): number {
  return e.abandoned ? 1 : 0;
}

/**
 * DESIGN.md 0, the live order: everyone by their standing (the score once finished,
 * what the buzzer would pay now while playing), so a run that went out of cash sinks;
 * runs left mid-round last; ties by name, then id.
 */
export function compareEntries(a: LeaderEntry, b: LeaderEntry): number {
  const t = tier(a) - tier(b);
  if (t !== 0) return t;
  const d = standing(b) - standing(a);
  if (d !== 0) return d;
  return compareNames(a, b);
}

export function sortEntries(entries: readonly LeaderEntry[]): LeaderEntry[] {
  return [...entries].sort(compareEntries);
}

/**
 * The number the best-of-the-day tables rank by: a finished player's best score today
 * (which falls back to the score, so a document without `best` still counts); a run
 * still going by what the buzzer would pay now, or by its earlier best when that is
 * higher; a run left mid-round by its earlier best alone, since its standing will never
 * be realised.
 */
export function bestOf(e: LeaderEntry): number {
  return e.abandoned ? e.best : Math.max(e.best, e.score);
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

/** This browser's stored run on the seed, if any. */
function localDoc(s: number): ScoreDoc | null {
  const d = readLocal()[String(s)];
  return d && d.seed === s ? d : null;
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

/** The leaderboard service's base URL, baked in at build time; null when the build has none. */
function httpUrl(): string | null {
  const raw: unknown = import.meta.env.VITE_LEADERBOARD_URL;
  const url = typeof raw === 'string' ? raw.trim().replace(/\/+$/, '') : '';
  return url || null;
}

function mintId(): string {
  const c = typeof crypto !== 'undefined' ? crypto : null;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `d-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** the id of this page load when storage is blocked: the same for every board of the session */
let sessionId: string | null = null;

/**
 * The HTTP transport's id for this browser: minted once into localStorage, so the best
 * of the day survives a reload; a per-session id where storage is blocked.
 */
function deviceId(): string {
  try {
    if (typeof localStorage !== 'undefined') {
      const kept = localStorage.getItem(DEVICE_KEY);
      if (kept && DEVICE_ID_RE.test(kept)) return kept;
      const id = mintId();
      localStorage.setItem(DEVICE_KEY, id);
      return id;
    }
  } catch {
    // storage unavailable: the session id below
  }
  sessionId ??= mintId();
  return sessionId;
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
  /** the leaderboard service's base URL when the HTTP transport is in use (then `db` stays null) */
  let http: string | null = null;
  /** the store's viewer id, or the HTTP transport's device id */
  let viewerId: string | null = null;
  let canWrite = false;
  let stale = false;
  let destroyed = false;

  /** this player's run on this page load: the freshest copy, ahead of whatever the store has */
  let me: ScoreDoc | null = null;
  /** this viewer's document as the store (or, in the fallback, localStorage) holds it: shown as the local player until a run starts */
  let mine: ScoreDoc | null = null;
  /** the registered run's seed */
  let seed: number | null = null;
  /** the seed watch() asked for */
  let watched: number | null = null;
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
  // the HTTP transport's poll: runs while someone subscribes
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  /** bumped by stopQuery(), so a poll answered after its seed was dropped steps aside */
  let pollSeq = 0;
  /** when the last poll succeeded (0: never) */
  let lastOk = 0;

  const listeners = new Set<(entries: LeaderEntry[]) => void>();

  // the write loop: one set() in flight, the latest state wins
  let writing = false;
  let dirty = false;
  let lastSent: string | null = null;
  let wake: (() => void) | null = null;

  function myId(): string {
    return mode === 'shared' && viewerId ? viewerId : LOCAL_ID;
  }

  /** The seed the board shows: the registered run's, else the watched one. */
  function viewSeed(): number | null {
    return seed ?? watched;
  }

  function current(): LeaderEntry[] {
    const now = Date.now();
    const out: LeaderEntry[] = [];
    if (mode === 'shared') for (const [id, d] of others) out.push(toEntry(id, d, false, isAbandoned(d, now)));
    // the local player: this page's run (live by definition), else this viewer's stored document
    if (me) out.push(toEntry(myId(), me, true, false));
    else if (mine) out.push(toEntry(myId(), mine, true, isAbandoned(mine, now)));
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
    const url = httpUrl();
    if (url) {
      // the hosted game: the leaderboard service, ahead of the artifact store
      http = url;
      viewerId = deviceId();
      mode = 'shared';
      canWrite = true;
      return;
    }
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
    stopPolling();
    pollSeq++;
    querySeed = null;
    confirmed = false;
    clearLoadTimer();
  }

  /** Marks the list stale once 10 s pass without the transport confirming it. */
  function armLoadTimer(): void {
    if (confirmed || loadTimer !== null) return;
    loadTimer = setTimeout(() => {
      loadTimer = null;
      if (destroyed || confirmed) return;
      stale = true;
      emit();
    }, LOAD_TIMEOUT_MS);
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
    const s = viewSeed();
    mine = s === null ? null : localDoc(s);
    emit();
  }

  function onSnap(snap: QuerySnapshot): void {
    if (destroyed || mode !== 'shared') return;
    const next = new Map<string, ScoreDoc>();
    let own: ScoreDoc | null = null;
    for (const doc of snap.docs) {
      if (!doc.exists) continue;
      const d = parseDoc(doc.data());
      if (!d || d.seed !== querySeed) continue;
      if (doc.id === viewerId) own = d;
      else next.set(doc.id, d);
    }
    others = next;
    // this viewer's own document: the store's copy, else the one kept in this browser (a refused write, an earlier fallback)
    mine = own ?? (querySeed === null ? null : localDoc(querySeed));
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

  // ---------------------------------------------------------------- the HTTP transport
  /** The service's rows for a seed, or null when it did not answer well (never rejects). */
  async function fetchRows(s: number): Promise<unknown[] | null> {
    if (!http) return null;
    try {
      const res = await fetch(`${http}/scores?seed=${encodeURIComponent(String(s))}`, { headers: { Accept: 'application/json' } });
      if (!res.ok) return null;
      const body: unknown = await res.json();
      return Array.isArray(body) ? body : null;
    } catch {
      return null;
    }
  }

  function rowId(raw: unknown): string | null {
    const id = raw && typeof raw === 'object' ? (raw as { deviceId?: unknown }).deviceId : null;
    return typeof id === 'string' && id ? id : null;
  }

  /** One answer from the service: the seed's list, this device's row set aside as `mine`. */
  function applyRows(rows: unknown[], s: number): void {
    const next = new Map<string, ScoreDoc>();
    let own: ScoreDoc | null = null;
    for (const raw of rows) {
      const id = rowId(raw);
      const d = parseDoc(raw);
      if (!id || !d || d.seed !== s) continue;
      if (id === viewerId) own = d;
      else next.set(id, d);
    }
    others = next;
    mine = own ?? localDoc(s);
    confirmed = true;
    stale = false;
    lastOk = Date.now();
    clearLoadTimer();
    emit();
  }

  /** One poll; a failure keeps the last list, and marks it stale once 10 s passed without a good answer. */
  async function poll(): Promise<void> {
    if (!http || destroyed || querySeed === null) return;
    const s = querySeed;
    const seq = pollSeq;
    const rows = await fetchRows(s);
    if (destroyed || seq !== pollSeq || querySeed !== s) return;
    if (rows) applyRows(rows, s);
    else if (confirmed && !stale && Date.now() - lastOk > LOAD_TIMEOUT_MS) {
      stale = true;
      emit();
    }
  }

  function startPolling(): void {
    if (!http || pollTimer !== null || querySeed === null || listeners.size === 0) return;
    pollTimer = setInterval(() => void poll(), POLL_MS);
    void poll();
  }

  function stopPolling(): void {
    if (pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  /** The HTTP transport's query: the seed to poll; a new seed drops the old list. */
  function ensureHttpQuery(s: number): void {
    if (querySeed === s) return;
    stopQuery();
    others = new Map();
    mine = null;
    querySeed = s;
    armLoadTimer();
    startPolling();
  }

  /** One PUT; a refused body stops writing, anything else is retried once. True when the write landed. */
  async function sendHttp(body: ScoreDoc, mayRetry: boolean): Promise<boolean> {
    if (!http || !viewerId) return false;
    let status = 0;
    try {
      const res = await fetch(`${http}/scores/${encodeURIComponent(viewerId)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.ok) return true;
      status = res.status;
    } catch {
      status = 0;
    }
    if (status === 400 || status === 413) {
      // a well-formed write refused: a document the service will not take; read-only from here on
      stopWriting();
      return false;
    }
    // unreachable, a 5xx, a rate limit: retry once after a short randomized delay
    if (!mayRetry) return false;
    await sleep(RETRY_DELAY_MS[0] + Math.random() * (RETRY_DELAY_MS[1] - RETRY_DELAY_MS[0]));
    if (destroyed || mode !== 'shared' || !canWrite) return false;
    return sendHttp(body, false);
  }

  /** Subscribe once per seed; a new seed (a new game) replaces the listener. */
  function ensureQuery(s: number): void {
    if (http) {
      ensureHttpQuery(s);
      return;
    }
    if (!db || (unsubscribeQuery && querySeed === s)) return;
    stopQuery();
    others = new Map();
    mine = null;
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
    armLoadTimer();
  }

  /** The store refused this viewer's writes: read-only from here on, the run kept in this browser so its best survives a reload. */
  function stopWriting(): void {
    canWrite = false;
    dirty = false;
    if (me && seed !== null) writeLocal(seed, me);
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
      while (dirty && !destroyed && mode === 'shared' && canWrite && (db || http) && viewerId && me && registering === 0) {
        dirty = false;
        const body: ScoreDoc = { ...me };
        const json = JSON.stringify(body);
        if (json === lastSent) continue;
        if (http || !db) {
          if (await sendHttp(body, true)) {
            lastSent = json;
            // the list the others see changed: read it back at once
            if (querySeed !== null) void poll();
          }
          continue;
        }
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
    if (http && viewerId) {
      try {
        const rows = await withTimeout(fetchRows(s), READ_TIMEOUT_MS);
        if (!rows) return 0;
        for (const raw of rows) {
          if (rowId(raw) !== viewerId) continue;
          const d = parseDoc(raw);
          return d && d.seed === s ? d.best : 0;
        }
      } catch {
        // slow: the run is registered without it
      }
      return 0;
    }
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

  function watch(s: number): void {
    if (destroyed) return;
    watched = s;
    void ready.then(() => {
      // superseded by a later watch(), or a run registered meanwhile on another seed: the board follows that
      if (destroyed || watched !== s || (seed !== null && seed !== s)) return;
      if (mode === 'shared') ensureQuery(s);
      else if (mode === 'local') mine = localDoc(s);
      emit();
    });
  }

  async function start(name: string, s: number, color: Color = DEFAULT_COLOR): Promise<void> {
    if (destroyed) return;
    const gen = ++generation;
    // best of the day (DESIGN.md 0): a new run on the same seed carries the best finished score so far
    const previous = me && me.seed === s ? me : null;
    seed = s;
    me = {
      name: cleanName(name),
      // DESIGN.md 20: the chosen colour travels with the score
      color: isColor(color) ? color : DEFAULT_COLOR,
      seed: s,
      value: 0,
      score: 0,
      best: previous ? previous.best : 0,
      month: 0,
      status: 'playing',
      updatedAt: Date.now(),
    };
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
        // a copy kept in this browser (a refused write, an earlier fallback) counts too
        const kept = localDoc(s);
        const best = Math.max(stored, kept ? kept.best : 0);
        if (me && best > me.best) me = { ...me, best };
      }
    }
    if (mode === 'shared') {
      requestWrite();
    } else if (mode === 'local' && me) {
      const stored = localDoc(s);
      if (stored && stored.best > me.best) me = { ...me, best: stored.best };
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
    // the local fallback, and a shared store that refused this viewer's writes: the run lives in this browser
    if (seed !== null && (mode === 'local' || (mode === 'shared' && !canWrite))) writeLocal(seed, me);
    emit();
    if (mode === 'shared') requestWrite();
  }

  function subscribe(cb: (entries: LeaderEntry[]) => void): () => void {
    if (destroyed) return () => {};
    listeners.add(cb);
    cb(current());
    startPolling();
    return () => {
      listeners.delete(cb);
      if (listeners.size === 0) stopPolling();
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
    watch,
    start,
    post,
    subscribe,
    destroy,
  };
}
