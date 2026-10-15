# RickyLeet

A local LeetCode practice coach. It keeps a cached problem catalog and verified solves in SQLite, then ranks unsolved problems using your actual practice history.

## Run

1. Install Node.js 20.19 or newer.
2. In this repository, run `npm install`.
3. Copy `.env.example` to `.env`. Leave `LEETCODE_SESSION` empty unless you choose to use authenticated history.
4. Run `npm run dev` and open http://localhost:5173. This starts the Express API on `127.0.0.1:3001` and Vite on `localhost:5173`.
5. Open **Settings**, enter your LeetCode username, and save. Use **Refresh catalog** the first time to download problem metadata. The catalog refresh is throttled and can take several minutes.
6. Use **Sync** to force a profile update. RickyLeet also checks on startup and when refreshing recommendations, with a five minute sync cache to avoid duplicate calls.

`npm test` runs the engine, storage, and failure tests. `npm run build` type checks both apps and builds the frontend. There is no lint script in this repository.

## Data and sync

The Express adapter requests public profile totals, topic counts, contest rating, and up to 20 recent accepted submissions in one GraphQL request. The public totals do **not** identify every solved problem. The workspace shows both the reported total and the count of locally verified problem identifiers when they differ. Previously saved accepted events are never erased by a short response or network failure.

For more complete history, paste a `LEETCODE_SESSION` value in Settings or set it in `.env`. The local server stores a pasted cookie encrypted with a local key and never returns it to the browser. The optional history request retrieves pages of submissions incrementally, up to 4,000 events per sync. You can also import solved slugs from a JSON array, `{ "slugs": ["two-sum"] }`, or a CSV `slug` column. Imported slugs must already exist in the cached catalog. Manual **Solved** actions are verified locally and immediately leave the unsolved feed.

The SQLite file and session key live under `data/` by default. Set `DATABASE_PATH` to choose a different location. Do not publish `.env`, `data/`, or the session key.

## Recommendation algorithm

The pure engine in `server/engine/capabilityEngine.ts` builds topic estimates by replaying saved submissions chronologically with Elo-style updates and a configurable 90 day evidence half-life. A rating is a bounded signal; topic familiarity and solved-problem similarity drive the main ranking. Candidate scoring combines familiar topics, shared tags with prior solves, a gradual difficulty step, a modest weak-topic and exploration boost, and a small quality signal. Recently shown relevant items receive a continuity boost; skipped items pause for 30 days. A deterministic diversity pass prevents one tag from filling the list.

The primary candidate query excludes accepted solves using the catalog's stable problem ID. The engine performs the same exclusion as a safeguard. This guarantee covers **verified** identifiers in the local database; an unknown historical solve cannot be identified from a public aggregate count alone.

## Architecture

```text
web/src/                   React workspace, settings panel, API client, matte theme
shared/types.ts            Shared TypeScript API and model types
server/adapters/leetcode.ts Throttled GraphQL adapter
server/db/index.ts         SQLite schema, migrations, persistence, account snapshots
server/engine/             Pure capability and ranking engine with tests
server/routes/api.ts       Profile sync, catalog refresh, feedback, import/export, search
server/index.ts            Local Express entry point
```

The database migration adds account-scoped recommendation history and skips, with indexes. Existing `problems`, `submissions`, `ratings`, and account snapshots remain intact. The earlier dashboard, roadmap, plan navigation, chart dependency, and unused list/plan API routes were removed because the recommendation workspace presents the relevant progress and actions directly. Legacy saved lists remain in SQLite and in data export.

## Limitations

- LeetCode GraphQL is unofficial and may change or rate-limit. A failed sync leaves cached progress available.
- Public recent submissions cover only a limited window. Full exclusion requires a valid session or a solved-slug import when older solves are not visible publicly.
- Authenticated history is capped at 4,000 submission events per sync. An expired cookie must be replaced. A cookie grants account access; protect `.env`, the SQLite file, and `data/session.key`.
- Company tags and premium problem statements are not fetched. RickyLeet links to LeetCode for the full problem.
- Predicted solve chance and skill estimates are practice heuristics, not official LeetCode measures.
