# silicon-valley-api

The shared leaderboard behind https://siliconvalley.party. Node 22, `node:http`, `pg`.
One row per (device, seed); everyone on a seed reads the whole list. No auth: inputs
are clamped, writes are rate-limited, that is all.

## Run

```sh
cd server
npm install
npm start            # in-memory store on :8787 (no DATABASE_URL)
DATABASE_URL=postgres://user:pass@host:5432/db npm start
```

## Environment

| Variable          | Default                                                                                   | Meaning |
|-------------------|-------------------------------------------------------------------------------------------|---------|
| `PORT`            | `8787`                                                                                    | Render sets it. |
| `DATABASE_URL`    | unset → in-memory store (rows vanish on restart)                                          | Render Postgres connection string (`fromDatabase` in `render.yaml`). The `scores` table is created on startup; rows untouched for 30 days are dropped on startup. |
| `ALLOWED_ORIGINS` | `https://siliconvalley.party,https://www.siliconvalley.party,http://localhost:5173`      | Comma-separated CORS origins. |

## Endpoints

```sh
curl -s localhost:8787/health
# ok

curl -s 'localhost:8787/scores?seed=20261104'
# []

curl -s localhost:8787/stats
# {"players":3,"runs":4,"finished":3,"days":2,"updatedAt":1762250000000}
# all-time totals for the board page (/board.html): distinct devices, (device, seed) rows ever created,
# runs that reached sold/dead, distinct worlds. Kept in the players/days tables, which the 30-day prune never touches.

curl -s -X PUT localhost:8787/scores/dev-1 \
  -H 'Content-Type: application/json' \
  -d '{"name":"Mike","seed":20261104,"value":120000,"score":84000,"month":3,"status":"playing","best":0,"color":"mint","updatedAt":0}'
# {"deviceId":"dev-1","name":"Mike","seed":20261104,"value":120000,"score":84000,"month":3,"status":"playing","best":0,"color":"mint","updatedAt":1762250000000}
```

Rules the server applies:

- `seed` must be an integer; `status` one of `playing|sold|dead`; otherwise 400.
- `name` trimmed to 24 characters (`Anonymous` when empty); `color` to 16; numbers made finite and clamped to `0..1e15`; `month` to `0..10000`.
- `best` never goes down for a (device, seed).
- `updatedAt` in the body is ignored; the stored value is the server's clock, so players with skewed clocks still compare.
- Device id: `[A-Za-z0-9_-]{1,64}`; bodies over 4 KB → 413; more than 60 writes a minute from one IP → 429.
- CORS: only the listed origins get `Access-Control-Allow-Origin`; methods `GET, PUT, OPTIONS`.
