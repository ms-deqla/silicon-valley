/**
 * Ambient types for the claude.ai artifact runtime: the subset leaderboard.ts uses,
 * copied from the artifact-capabilities contract 0.2.96 (claude.d.ts, db.d.ts,
 * user.d.ts). A declaration file, imported nowhere: it adds `window.claude` and the
 * `db` / `user` namespaces as globals, exactly as the platform's typed authoring
 * would. One deliberate difference from the contract: `Window.claude` is optional
 * here, because this page also runs outside the viewer (local dev, a saved copy,
 * tests), where the contract itself says there is no `window.claude` at all, so
 * every use goes through `typeof window !== 'undefined' && window.claude?.use`.
 * Nothing but `use` is promised on it: never read `window.claude.db`.
 */

/** Rejection shape for every db method and the `onSnapshot` error callback. */
type DbError = {
  code: DbErrorCode;
  message: string;
};

/**
 * Stable error codes. Branch on `code`, never on message text; treat unknown codes
 * as "unavailable". Store codes: `invalid_argument` (fix the call; also a write the
 * rules refuse), `resource_exhausted` (a budget), `quota_exceeded` (a cap),
 * `unavailable` (transient: retry once after a short randomized delay), `revoked`
 * (terminal for the page load). Lifecycle codes from the runtime: `not_granted`,
 * `capability_disabled`, `capability_removed`, `transform_error` (like
 * `invalid_argument`).
 */
type DbErrorCode =
  | 'invalid_argument'
  | 'resource_exhausted'
  | 'quota_exceeded'
  | 'unavailable'
  | 'revoked'
  | 'not_granted'
  | 'capability_disabled'
  | 'capability_removed'
  | 'transform_error';

/** Snapshot provenance: `fromCache: true` marks a view the store has not confirmed. */
type SnapshotMetadata = {
  fromCache: boolean;
  hasPendingWrites: boolean;
};

/** One document, as reads and snapshots deliver it (frozen; clone before editing). */
type DocumentSnapshot = {
  /** The last segment of the document's path. */
  id: string;
  /** False covers both a missing document and one this viewer cannot see. */
  exists: boolean;
  /** The document body; `undefined` when `exists` is false. */
  data(): Record<string, unknown> | undefined;
  metadata: SnapshotMetadata;
};

/** One ordered-view transition inside a query snapshot. */
type DocumentChange = {
  type: 'added' | 'modified' | 'removed';
  doc: DocumentSnapshot;
  oldIndex: number;
  newIndex: number;
};

/** A query's matched set, in query order. */
type QuerySnapshot = {
  docs: DocumentSnapshot[];
  size: number;
  empty: boolean;
  /** The changes since the previous snapshot of this listener (the first is all-`added`). */
  docChanges(): DocumentChange[];
  metadata: SnapshotMetadata;
};

/** Stop receiving snapshots. Idempotent; after it returns, the callbacks never fire again. */
type Unsubscribe = () => void;

/** A reference to one document: pure and synchronous to create (a malformed path throws a TypeError). */
type DocumentReference = {
  /** The last path segment. */
  id: string;
  path: string;
  /** Read once. Absence is NOT an error: branch on `exists`. */
  get(): Promise<DocumentSnapshot>;
  /**
   * Write the WHOLE document, creating it if absent (a full replace). ONE WRITE AT A
   * TIME per document, only when its data changed: await each `set` before the next
   * to the same document; never write from render code, a snapshot callback or a
   * timer. Writes are last-writer-wins.
   */
  set(data: Record<string, unknown>): Promise<void>;
  /**
   * Subscribe to this document. `error` receives at most one terminal DbError, after
   * which the subscription is dead.
   */
  onSnapshot(next: (snap: DocumentSnapshot) => void, error?: (e: DbError) => void): Unsubscribe;
};

/** A filtered view of one collection. Builders are pure; terminal calls do the work. */
type Query = {
  /** Add a filter (up to 10). Operators: `==`, `!=`, `<`, `<=`, `>`, `>=`, `in`, `not-in`, `array-contains`. */
  where(field: string, op: string, value: unknown): Query;
  /** Read the matched set once, in query order. */
  get(): Promise<QuerySnapshot>;
  /**
   * Subscribe to the matched set: SUBSCRIBE ONCE per query, keep the `Unsubscribe`.
   * While the store cannot be reached the listener may hear nothing, so time-limit
   * loading with a timer of about 10 s; the first snapshot with `fromCache: false`
   * clears it. `error` receives at most one terminal DbError (`invalid_argument`,
   * `resource_exhausted`, `revoked`, or `unavailable` when the host stopped
   * answering), after which the subscription is dead and a fresh `onSnapshot` is
   * the only recovery. At most 64 active subscriptions per view.
   */
  onSnapshot(next: (snap: QuerySnapshot) => void, error?: (e: DbError) => void): Unsubscribe;
};

/** A collection: a Query over everything in it, plus document access. */
type CollectionReference = Query & {
  path: string;
  /** A document in this collection. */
  doc(id?: string): DocumentReference;
};

/**
 * The store surface. Refs are pure path holders; only the calls on them touch the
 * network. Document bodies are plain-JSON objects, at most 256 KiB.
 */
type DB = {
  /** A document reference (an even number of path segments, e.g. `scores/u_1`). */
  doc(path: string): DocumentReference;
  /** A collection reference (an odd number of path segments, e.g. `scores`). */
  collection(path: string): CollectionReference;
};

declare namespace Claude {
  namespace user {
    /**
     * The viewer's id: an opaque token, stable within the organization that owns the
     * artifact, the value `db` recognizes as this viewer. null = no identity here
     * (signed out, a guest the platform gives none, or the capability undeclared).
     * Never rejects.
     */
    function id(): Promise<string | null>;
  }
}

interface ClaudeCapabilityMap {
  db: DB;
  user: typeof Claude.user;
}

interface Claude {
  /**
   * The one way to reach a capability. Resolves the namespace once this view can run
   * it, or `null` when it cannot (not served, not granted, failed to load, or a host
   * that never answers, after 10 s). Memoized per served capability.
   */
  use<K extends keyof ClaudeCapabilityMap & string>(name: K): Promise<ClaudeCapabilityMap[K] | null>;
}

interface Window {
  /** Present inside the viewer before any script runs; absent on every other copy of the page. */
  claude?: Claude;
}
