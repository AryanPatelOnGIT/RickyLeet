# RickyLeet

Local, private LeetCode practice recommendations powered by a per-topic capability model.

## Architecture and data model

```text
Browser (React + Vite + Tailwind)
  → typed /api contract
Local Express server (TypeScript)
  → LeetCode GraphQL adapter (throttled to ~1 request/second)
  → SQLite cache (better-sqlite3)
  → pure capability engine (replay + ranking)
```

SQLite tables: `problems` caches catalog metadata and optional contest ratings; `submissions` stores public, session, imported, and manual events; `ratings` stores the latest recomputed skills; `kv` stores profile, settings, and the encrypted optional session cookie; `lists` and `list_items` hold saved problems. The database and encryption key stay in `data/`.

## Run

1. Install Node.js 20.19+ (Node 24 recommended).
2. Run `npm install`.
3. Copy `.env.example` to `.env`. You may leave `LEETCODE_SESSION` blank. If you set it, keep `.env` private.
4. Run `npm run dev` and open [http://localhost:5173](http://localhost:5173).
5. In Settings, enter your LeetCode username and save. Click **Refresh catalog**. The first refresh may take several minutes because catalog pages and vote-count batches are throttled. Search or click **Recommend for me** to sync and recompute.
6. If LeetCode is unavailable, run `npm run seed` for a small sample catalog and import solved slugs from JSON or CSV.

`npm run build` checks both TypeScript projects and builds the web app. `npm test` runs the capability engine tests. The backend listens only on `127.0.0.1:3001`; Vite proxies `/api` to it.

## Capability algorithm

1. Initialize overall skill from contest rating plus solved counts. Initialize each topic from the overall baseline and public tag-wise counts.
2. Replay local submission events in timestamp order. For each event, use `expected = 1 / (1 + 10^((problemRating - skillRating) / 400))`, then `rating += K × (outcome - expected)`. First-try accepted is 1; later accepted is 0.5–0.7; accepted with hints or over two hours is 0.4; failed or abandoned is 0. Old events have `K` multiplied by `2^(-ageDays / halfLifeDays)`.
3. Confidence rises with weighted evidence. A topic is weak when its rating is 90+ below overall or its recorded failure rate exceeds 45% after at least three attempts.
4. Every search syncs available submissions, rebuilds the model, and scores cached problems. Stretch fit peaks at 65% predicted solve chance. Weakness, uncertainty, quality, diversity, and recent topic fatigue are weighted by Settings sliders. Solved problems return for review on a 1, 3, 7, 21, 60 day cadence when they were difficult or the topic is weak.

Tune the weight sliders to emphasize stretch practice, weak topics, exploration, quality, diversity, or freshness. **Interview Prep**, **Contest Training**, **Weak Spot Fixer**, and **Easy Warm-up** apply presets. The half-life slider changes how fast old practice loses influence.

## Import format

JSON: `["two-sum", "valid-parentheses"]` or `{ "slugs": ["two-sum"] }`. CSV: a `slug` column, one solved slug per row. Import only records slugs already present in the cached catalog. The export endpoint returns settings, profile, submissions, and lists, without the session cookie.

## Privacy and limitations

- All user data stays in local SQLite. There is no analytics. The server contacts LeetCode for catalog/profile/history and Zerotrac only when optional contest ratings are enabled.
- `LEETCODE_SESSION` grants account access. The browser field sends it once to the local server; it is encrypted with a local key in `data/session.key`, never returned by APIs, and never logged. An `.env` cookie is also supported. Protect backups of both files. Clearing a stored cookie does not revoke it on LeetCode; log out there to revoke it.
- LeetCode GraphQL is unofficial and can change or rate-limit. Public profiles expose only recent accepted submissions, so first-try/attempt timing is approximate unless full session history or manual feedback is available. The full-history adapter has a 4,000-submission cap per sync. A failed sync leaves cached data usable.
- Company tags are shown only if present in catalog data; LeetCode's public metadata query may not provide them. Premium problem statements are never fetched.
- The score is a practice heuristic, not an official LeetCode rating or a validated prediction of success. Imported solves use import time when historical timestamps are absent.

## File tree

```text
server/
  adapters/leetcode.ts       GraphQL and optional rating dataset
  db/index.ts, seed.ts        SQLite schema, persistence, sample seed
  engine/capabilityEngine.ts  Pure model and ranking functions
  engine/capabilityEngine.test.ts
  routes/api.ts               Local typed API endpoints
  index.ts                    Express entry point
shared/types.ts               Frontend/backend API contract
web/
  src/api.ts                  Typed API client
  src/components/ProblemCard.tsx
  src/pages/{Dashboard,Roadmap,Settings}.tsx
  src/main.tsx, style.css     React UI
  vite.config.ts
```
