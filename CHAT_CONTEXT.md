# RickyLeet Chat Handoff Context

This file summarizes the work and decisions from the previous chat so another chat can continue the project without losing context.

## Project

RickyLeet is a local-first LeetCode practice coach located at:

```text
C:\Users\Aryan's LOQ\Desktop\Projects\RickyLeet
```

The repository is connected to the GitHub project:

```text
AryanPatelOnGIT/RickyLeet
```

The app is currently a React/Vite frontend with a TypeScript Node/Express backend and SQLite persistence.

## Original product goal

Build a web app that scans the LeetCode problem set, reads the user's solve history and ranking, builds a capability model, and recommends the next best problems. The model should be recomputed on every search so new solves affect future recommendations.

## Requested technology

- Frontend: React, TypeScript, Vite, Tailwind-compatible styling.
- Backend: Node.js with TypeScript and Express/Fastify.
- Storage: SQLite through the existing database layer.
- LeetCode GraphQL requests must run through the backend because browser CORS blocks direct requests.
- Include setup documentation, `.env.example`, seed support, tests, and one `npm run dev` command for frontend and backend.

## Required product areas

### Data ingestion

- Fetch and cache the LeetCode problem catalog through `problemsetQuestionList`.
- Store metadata such as title, slug, difficulty, acceptance, tags, premium status, likes, and dislikes.
- Support optional finer-grained community difficulty ratings with graceful fallback.
- Rate-limit requests and retry with backoff.
- Provide a catalog refresh control.
- Sync public user information including solved counts, tag stats, contest rating, ranking, and accepted submissions.
- Support optional server-side `LEETCODE_SESSION` handling with a security warning.
- Support JSON/CSV solved-slug import fallback.
- Sync on startup and manually through a refresh action.

### Capability model

The engine maintains per-topic and overall ratings. It initializes from contest rating, solved counts, and tag statistics, then replays submissions chronologically with Elo-style updates:

```text
expected = 1 / (1 + 10^((problemRating - skillRating) / 400))
update = K * (outcome - expected)
```

Outcome weighting should account for first-try solves, multiple attempts, hints/solutions, long runtimes, and failures. The model also includes time decay, uncertainty/confidence, weak-area detection, review resurfacing, and incremental recomputation where practical.

Recommendation scoring includes target fit, weakness boost, exploration, problem quality, diversity, and topic fatigue. Recommendations should explain why a problem was selected.

### UI requirements

- Dashboard with profile stats, solved counts, skill radar, rating history, activity heatmap, strengths, and weaknesses.
- Recommendation search with filters, sorting, grouping, and a prominent recommendation action.
- Problem cards with difficulty, tags, acceptance, predicted solve chance, estimated time, reason, LeetCode link, and feedback controls.
- Roadmap and today's plan views.
- Settings for sync, weights, half-life, cookie handling, import/export, catalog refresh, presets, and model reset.

## Data persistence and syncing clarification

The user specifically requested that their data be stored once and reused while the app is running and when searching. The app should:

1. Load cached local data on server/app startup.
2. Reuse stored profile, submissions, catalog, and model data for normal page usage.
3. On a search or recommendation request, sync new submissions first when possible, recompute the model, then rank problems.
4. Provide a visible “Refresh from LeetCode” button for an explicit sync.
5. Continue working from cached data if LeetCode or the unofficial API is unavailable.

## Visual restyling completed

The UI was restyled into a matte black and muted blue theme without changing routes, data logic, or component behavior.

Main palette tokens are centralized in `web/src/style.css`:

- Base background: `#0B0B0D`
- Surface: `#121316`
- Elevated surface: `#1A1C20`
- Input background: `#0F1012`
- Subtle border: `#22252B`
- Strong border: `#2E323A`
- Matte blue: `#3B5B9D`
- Hover blue: `#4F72B8`
- Pressed blue: `#2F4A82`
- Light blue accent: `#7C98CC`
- Selected blue surface: `#16203A`

Text and semantic colors were adjusted for contrast. In particular:

- The requested muted text value was lightened to improve WCAG contrast on surface backgrounds.
- A lighter button text token was used so text remains readable on hover blue.
- A lighter Easy badge text token and Hard badge text token were added for small-text contrast.

Other visual changes include:

- Solid fills instead of gradients or glossy effects.
- Thin borders instead of prominent shadows.
- Matte elevated hover states for cards.
- Muted semantic difficulty colors.
- Dark native controls through `color-scheme: dark`.
- Focus rings based on the matte blue token.
- Thin scrollbars using the strong border token.
- Recharts radar, line, axis, grid, and tooltip colors moved to CSS variables.
- Browser theme color set to `#0B0B0D`.

## Sidebar brand removal

The user provided a screenshot showing this sidebar block:

```text
R RickyLeet
  Practice with purpose
```

That brand block was removed from the sidebar in `web/src/main.tsx`.

The following remain intentionally unchanged:

- Workspace label.
- Dashboard, Recommendations, Roadmap, Today's Plan, and Settings navigation.
- LeetCode sync card and refresh button.
- User profile chip.
- Startup loading screen brand mark.
- Routes and app behavior.

## Files changed during the visual work

- `web/src/main.tsx` — removed the sidebar brand block.
- `web/src/style.css` — added the matte theme tokens and visual states.
- `web/src/pages/Dashboard.tsx` — replaced hardcoded chart colors with theme variables.
- `web/index.html` — added the dark browser `theme-color` meta tag.

## Verification completed

The following command passes:

```bash
npm run build
```

The app was also checked in the local browser. The sidebar brand block was no longer present, and the dashboard and recommendation views rendered with the matte theme.

## Important constraints

- Do not expose or log the `LEETCODE_SESSION` cookie.
- Keep user data local.
- Respect LeetCode rate limits and terms.
- Do not scrape premium problem statements or bulk-download problem content.
- Preserve existing functionality and routes when making visual-only changes.
- Use `apply_patch` for source edits.
- Avoid destructive Git commands unless explicitly requested.

## Current working tree expectation

Before making new changes, inspect the working tree:

```bash
git status --short
git diff --stat
```

Do not discard existing changes. They belong to the user unless proven otherwise.

## Useful commands

Install dependencies:

```bash
npm install
```

Start frontend and backend together:

```bash
npm run dev
```

Build all TypeScript and the frontend bundle:

```bash
npm run build
```

Run tests:

```bash
npm test
```

Seed the local database:

```bash
npm run seed
```

## Suggested next-chat opening message

“Continue working on RickyLeet from `CHAT_CONTEXT.md`. First inspect the current Git status and file tree. Preserve the existing local data, matte theme, sidebar brand removal, and all existing functionality. Tell me what remains incomplete before editing.”

