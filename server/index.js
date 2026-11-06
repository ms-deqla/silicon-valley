/**
 * Silicon Valley leaderboard API. One row per (device, seed); everyone on a seed reads
 * the whole list. No auth: seven friends, honest inputs clamped, writes rate-limited.
 *
 *   GET  /health                -> "ok"
 *   GET  /scores?seed=<int>     -> JSON array of rows on that seed
 *   GET  /stats                 -> {players, runs, finished, days}: all-time totals for the board page
 *   PUT  /scores/<deviceId>     -> upsert {name, seed, value, score, month, status, best, color, updatedAt}; returns the stored row
 *
 * Storage: Postgres when DATABASE_URL is set (the table is created on startup), else an
 * in-memory map so `node index.js` boots for local dev and tests.
 */
import http from 'node:http';
import pg from 'pg';

const PORT = Number(process.env.PORT) || 8787;
const DATABASE_URL = process.env.DATABASE_URL || '';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://siliconvalley.party,https://www.siliconvalley.party,http://localhost:5173')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const BODY_LIMIT = 4 * 1024;
const NAME_MAX = 24;
const COLOR_MAX = 16;
const DEVICE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const STATUSES = new Set(['playing', 'sold', 'dead']);
/** writes per IP per window */
const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60_000;
/** rows nobody touched for this long are dropped on startup */
const KEEP_DAYS = 30;

// ---------------------------------------------------------------- storage
function makeMemoryStore() {
  const rows = new Map();
  /** all-time counters (the board page's "people have played"): a run is one (device, seed) row ever created */
  const players = new Map();
  let runs = 0;
  let finished = 0;
  const days = new Set();
  return {
    kind: 'memory',
    async init() {},
    async list(seed) {
      return [...rows.values()].filter((r) => r.seed === seed);
    },
    async upsert(row) {
      const key = `${row.deviceId}\u0000${row.seed}`;
      const old = rows.get(key);
      const next = { ...row, best: Math.max(row.best, old ? old.best : 0) };
      rows.set(key, next);
      if (!old) runs += 1;
      if (row.status !== 'playing' && (!old || old.status === 'playing')) finished += 1;
      if (!players.has(row.deviceId)) players.set(row.deviceId, Date.now());
      days.add(row.seed);
      return next;
    },
    async stats() {
      return { players: players.size, runs, finished, days: days.size };
    },
  };
}

function makePgStore(connectionString) {
  const pool = new pg.Pool({ connectionString, max: 5 });
  const toRow = (r) => ({
    deviceId: r.device_id,
    name: r.name,
    seed: Number(r.seed),
    value: Number(r.value),
    score: Number(r.score),
    month: r.month,
    status: r.status,
    best: Number(r.best),
    color: r.color,
    updatedAt: new Date(r.updated_at).getTime(),
  });
  return {
    kind: 'postgres',
    async init() {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS scores (
          device_id text NOT NULL,
          seed bigint NOT NULL,
          name text NOT NULL,
          value double precision NOT NULL,
          score double precision NOT NULL,
          month int NOT NULL,
          status text NOT NULL,
          best double precision NOT NULL,
          color text NOT NULL,
          updated_at timestamptz NOT NULL,
          PRIMARY KEY (device_id, seed)
        )`);
      await pool.query('CREATE INDEX IF NOT EXISTS scores_seed_idx ON scores (seed)');
      // all-time totals survive the 30-day prune of scores: one row per device, one counter per run
      await pool.query(`
        CREATE TABLE IF NOT EXISTS players (
          device_id text PRIMARY KEY,
          first_seen timestamptz NOT NULL,
          last_seen timestamptz NOT NULL,
          runs int NOT NULL DEFAULT 0,
          finished int NOT NULL DEFAULT 0
        )`);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS days (
          seed bigint PRIMARY KEY,
          first_seen timestamptz NOT NULL
        )`);
      await pool.query(`DELETE FROM scores WHERE updated_at < now() - interval '${KEEP_DAYS} days'`);
    },
    async list(seed) {
      const { rows } = await pool.query('SELECT * FROM scores WHERE seed = $1 ORDER BY score DESC, name ASC', [seed]);
      return rows.map(toRow);
    },
    async upsert(row) {
      const { rows } = await pool.query(
        `INSERT INTO scores (device_id, seed, name, value, score, month, status, best, color, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, to_timestamp($10 / 1000.0))
         ON CONFLICT (device_id, seed) DO UPDATE SET
           name = EXCLUDED.name, value = EXCLUDED.value, score = EXCLUDED.score, month = EXCLUDED.month,
           status = EXCLUDED.status, best = GREATEST(scores.best, EXCLUDED.best), color = EXCLUDED.color,
           updated_at = EXCLUDED.updated_at
         RETURNING *, (xmax = 0) AS inserted, (SELECT status FROM scores s WHERE s.device_id = $1 AND s.seed = $2) AS prev_status`,
        [row.deviceId, row.seed, row.name, row.value, row.score, row.month, row.status, row.best, row.color, row.updatedAt],
      );
      const r = rows[0];
      const newRun = r.inserted ? 1 : 0;
      // prev_status is read before the update inside the same statement, so it is the old status (null for a new row)
      const newlyFinished = row.status !== 'playing' && (r.inserted || r.prev_status === 'playing') ? 1 : 0;
      await pool.query(
        `INSERT INTO players (device_id, first_seen, last_seen, runs, finished) VALUES ($1, now(), now(), $2, $3)
         ON CONFLICT (device_id) DO UPDATE SET last_seen = now(), runs = players.runs + $2, finished = players.finished + $3`,
        [row.deviceId, newRun, newlyFinished],
      );
      await pool.query('INSERT INTO days (seed, first_seen) VALUES ($1, now()) ON CONFLICT DO NOTHING', [row.seed]);
      return toRow(r);
    },
    async stats() {
      const { rows } = await pool.query(
        `SELECT (SELECT count(*) FROM players) AS players,
                (SELECT coalesce(sum(runs), 0) FROM players) AS runs,
                (SELECT coalesce(sum(finished), 0) FROM players) AS finished,
                (SELECT count(*) FROM days) AS days`,
      );
      const r = rows[0];
      return { players: Number(r.players), runs: Number(r.runs), finished: Number(r.finished), days: Number(r.days) };
    },
  };
}

const store = DATABASE_URL ? makePgStore(DATABASE_URL) : makeMemoryStore();

// ---------------------------------------------------------------- validation
function finite(x, fallback = 0) {
  const n = typeof x === 'number' ? x : typeof x === 'string' && x.trim() !== '' ? Number(x) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

function parseSeed(x) {
  const n = finite(x, NaN);
  return Number.isSafeInteger(n) ? n : null;
}

/** The row to store, from a client body: every field checked and clamped; null when the body cannot be a row. */
function cleanRow(deviceId, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const seed = parseSeed(body.seed);
  if (seed === null) return null;
  if (!STATUSES.has(body.status)) return null;
  const name = (typeof body.name === 'string' ? body.name.trim().slice(0, NAME_MAX) : '') || 'Anonymous';
  const color = typeof body.color === 'string' ? body.color.trim().slice(0, COLOR_MAX) : '';
  const clampMoney = (x) => Math.max(0, Math.min(1e15, finite(x)));
  return {
    deviceId,
    name,
    seed,
    value: clampMoney(body.value),
    score: clampMoney(body.score),
    month: Math.max(0, Math.min(10_000, Math.round(finite(body.month)))),
    status: body.status,
    best: clampMoney(body.best),
    color: color || 'sky',
    // the server's clock, so players with skewed clocks still compare
    updatedAt: Date.now(),
  };
}

// ---------------------------------------------------------------- rate limit
const buckets = new Map();
function rateLimited(ip) {
  const now = Date.now();
  let b = buckets.get(ip);
  if (!b || now - b.start >= RATE_WINDOW_MS) {
    b = { start: now, count: 0 };
    buckets.set(ip, b);
  }
  b.count++;
  if (buckets.size > 10_000) for (const [k, v] of buckets) if (now - v.start >= RATE_WINDOW_MS) buckets.delete(k);
  return b.count > RATE_LIMIT;
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd) return fwd.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

// ---------------------------------------------------------------- http
function cors(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '600');
  }
}

function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(json);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > BODY_LIMIT) return reject(Object.assign(new Error('too large'), { status: 413 }));
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > BODY_LIMIT) {
        reject(Object.assign(new Error('too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handle(req, res) {
  cors(req, res);
  const url = new URL(req.url || '/', 'http://localhost');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end('ok');
    return;
  }
  if (req.method === 'GET' && url.pathname === '/stats') {
    return send(res, 200, { ...(await store.stats()), updatedAt: Date.now() });
  }
  if (req.method === 'GET' && url.pathname === '/scores') {
    const seed = parseSeed(url.searchParams.get('seed'));
    if (seed === null) return send(res, 400, { error: 'seed must be an integer' });
    return send(res, 200, await store.list(seed));
  }
  const m = url.pathname.match(/^\/scores\/([^/]+)$/);
  if (req.method === 'PUT' && m) {
    const deviceId = decodeURIComponent(m[1]);
    if (!DEVICE_ID_RE.test(deviceId)) return send(res, 400, { error: 'bad device id' });
    if (rateLimited(clientIp(req))) return send(res, 429, { error: 'too many writes' });
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch (e) {
      return send(res, e && e.status === 413 ? 413 : 400, { error: e && e.status === 413 ? 'body over 4 KB' : 'bad json' });
    }
    const row = cleanRow(deviceId, body);
    if (!row) return send(res, 400, { error: 'seed (integer) and status (playing|sold|dead) are required' });
    return send(res, 200, await store.upsert(row));
  }
  send(res, 404, { error: 'not found' });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    console.error(e);
    if (!res.headersSent) send(res, 500, { error: 'server error' });
    else res.end();
  });
});

store
  .init()
  .then(() => {
    server.listen(PORT, () => console.log(`silicon-valley-api listening on :${PORT} (${store.kind})`));
  })
  .catch((e) => {
    console.error('storage init failed', e);
    process.exit(1);
  });

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)));
