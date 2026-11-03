import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { currentOwner, LOCAL_OWNER, multiUser } from '../context.js';
import type { Problem, Profile, Settings, Submission } from '../../shared/types.js';

export const databasePath = resolve(process.env.DATABASE_PATH || (process.env.VERCEL ? '/tmp/rickyleet.sqlite' : './data/rickyleet.sqlite'));
const path = databasePath;
mkdirSync(dirname(path), { recursive: true });
export const db = new Database(path);
db.pragma('journal_mode = WAL');

// Migrate single-user databases: per-user rows move to the local owner.
const columns = (table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(c => c.name);
db.transaction(() => {
  if (columns('submissions').length && !columns('submissions').includes('owner')) {
    db.exec('ALTER TABLE submissions RENAME TO submissions_single_user; DROP INDEX IF EXISTS idx_submissions_slug_time;');
    db.exec(`CREATE TABLE submissions (owner TEXT NOT NULL, id TEXT NOT NULL, slug TEXT, timestamp INTEGER, status TEXT, attempts INTEGER, runtime TEXT, source TEXT, hints INTEGER, minutes REAL, PRIMARY KEY(owner,id));
      INSERT INTO submissions SELECT '${LOCAL_OWNER}',id,slug,timestamp,status,attempts,runtime,source,hints,minutes FROM submissions_single_user;
      DROP TABLE submissions_single_user;`);
  }
  if (columns('ratings').length && !columns('ratings').includes('owner')) db.exec('DROP TABLE ratings');
  if (columns('kv').length && !db.prepare("SELECT 1 FROM kv WHERE key='meta:multiUser'").get()) {
    db.prepare("UPDATE kv SET key='u:' || ? || ':' || key WHERE key NOT LIKE 'u:%' AND key NOT LIKE 'meta:%'").run(LOCAL_OWNER);
    for (const table of ['recommendation_history', 'recommendation_skips']) if (columns(table).length) db.prepare(`UPDATE ${table} SET account=? || ':' || account WHERE instr(account, ':')=0`).run(LOCAL_OWNER);
    db.prepare("INSERT INTO kv(key,value) VALUES('meta:multiUser','1')").run();
  }
})();

db.exec(`CREATE TABLE IF NOT EXISTS problems (slug TEXT PRIMARY KEY, id TEXT, title TEXT, difficulty TEXT, acceptance REAL, tags TEXT, paid INTEGER, likes INTEGER, dislikes INTEGER, rating REAL, companyTags TEXT, createdAt TEXT);
CREATE INDEX IF NOT EXISTS idx_problems_id ON problems(id);
CREATE INDEX IF NOT EXISTS idx_problems_difficulty ON problems(difficulty);
CREATE TABLE IF NOT EXISTS submissions (owner TEXT NOT NULL, id TEXT NOT NULL, slug TEXT, timestamp INTEGER, status TEXT, attempts INTEGER, runtime TEXT, source TEXT, hints INTEGER, minutes REAL, PRIMARY KEY(owner,id));
CREATE INDEX IF NOT EXISTS idx_submissions_owner_slug_time ON submissions(owner,slug,timestamp);
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT);
INSERT OR IGNORE INTO kv(key,value) VALUES('meta:multiUser','1');
CREATE TABLE IF NOT EXISTS lists (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL);
CREATE TABLE IF NOT EXISTS list_items (list_id INTEGER, slug TEXT, PRIMARY KEY(list_id,slug));
CREATE TABLE IF NOT EXISTS ratings (owner TEXT NOT NULL, tag TEXT NOT NULL, rating REAL, confidence REAL, attempts INTEGER, failures INTEGER, weak INTEGER, updated_at INTEGER, PRIMARY KEY(owner,tag));
CREATE TABLE IF NOT EXISTS recommendation_history (account TEXT NOT NULL, slug TEXT NOT NULL, shown_at INTEGER NOT NULL, position INTEGER NOT NULL, PRIMARY KEY(account,slug));
CREATE INDEX IF NOT EXISTS idx_recommendation_history_account_time ON recommendation_history(account,shown_at);
CREATE TABLE IF NOT EXISTS recommendation_skips (account TEXT NOT NULL, slug TEXT NOT NULL, skipped_at INTEGER NOT NULL, PRIMARY KEY(account,slug));
CREATE INDEX IF NOT EXISTS idx_recommendation_skips_account_time ON recommendation_skips(account,skipped_at);`);
// LeetCode reports the same submission publicly and through a session; keep only the richer session copy.
db.exec("DELETE FROM submissions WHERE id LIKE 'public:%' AND EXISTS (SELECT 1 FROM submissions s WHERE s.owner=submissions.owner AND s.id='session:' || substr(submissions.id, 8))");
const DAY = 86400000;
const defaults: Settings = { username: '', useContestRatings: false, halfLifeDays: 90, weights: { targetFit: 4, weakness: 2, exploration: 1.5, quality: 1, diversity: 1.5, fatigue: 1 }, planSize: 4, hasSession: false };
// Per-user keys and recommendation accounts are prefixed with the current owner.
const scopedKey = (key: string) => `u:${currentOwner()}:${key}`;
const scopedAccount = (account: string) => `${currentOwner()}:${account}`;
export function getKV<T>(key: string, fallback: T): T { const row = db.prepare('SELECT value FROM kv WHERE key=?').get(scopedKey(key)) as { value: string } | undefined; try { return row ? JSON.parse(row.value) as T : fallback; } catch { return fallback; } }
export function setKV(key: string, value: unknown) { db.prepare('INSERT INTO kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(scopedKey(key), JSON.stringify(value)); }
export function getSettings(): Settings { return { ...defaults, ...getKV<Partial<Settings>>('settings', {}), weights: { ...defaults.weights, ...getKV<Partial<Settings>>('settings', {}).weights }, hasSession: (!multiUser && !!process.env.LEETCODE_SESSION) || !!getKV<string>('encryptedSession', '') }; }
export function saveProblems(items: Problem[]) { const insert = db.prepare('INSERT INTO problems(slug,id,title,difficulty,acceptance,tags,paid,likes,dislikes,rating,companyTags,createdAt) VALUES(@slug,@id,@title,@difficulty,@acceptance,@tags,@paid,@likes,@dislikes,@rating,@companyTags,@createdAt) ON CONFLICT(slug) DO UPDATE SET id=excluded.id,title=excluded.title,difficulty=excluded.difficulty,acceptance=excluded.acceptance,tags=excluded.tags,paid=excluded.paid,likes=CASE WHEN excluded.likes=0 AND excluded.dislikes=0 THEN problems.likes ELSE excluded.likes END,dislikes=CASE WHEN excluded.likes=0 AND excluded.dislikes=0 THEN problems.dislikes ELSE excluded.dislikes END,companyTags=excluded.companyTags'); db.transaction(() => { for (const p of items) insert.run({ ...p, tags: JSON.stringify(p.tags), paid: +p.paid, rating: p.rating ?? null, companyTags: JSON.stringify(p.companyTags ?? []), createdAt: p.createdAt ?? new Date().toISOString() }); })(); }
export function getProblems(): Problem[] { return (db.prepare('SELECT * FROM problems').all() as any[]).map(p => ({ ...p, tags: JSON.parse(p.tags), companyTags: JSON.parse(p.companyTags || '[]'), paid: !!p.paid, rating: p.rating ?? undefined })); }
export const problemCount = () => (db.prepare('SELECT COUNT(*) AS n FROM problems').get() as { n: number }).n;
export function saveSubmissions(items: Submission[]): number {
  const stmt = db.prepare('INSERT OR IGNORE INTO submissions(owner,id,slug,timestamp,status,attempts,runtime,source,hints,minutes) VALUES(@owner,@id,@slug,@timestamp,@status,@attempts,@runtime,@source,@hints,@minutes)');
  const exists = db.prepare('SELECT 1 FROM submissions WHERE owner=? AND id=?'), remove = db.prepare('DELETE FROM submissions WHERE owner=? AND id=?');
  // A `solved:<slug>` entry from LeetCode's solved list only stands in for a problem no real accepted submission identifies.
  const removeStandIns = db.prepare("DELETE FROM submissions WHERE owner=? AND id LIKE 'solved:%' AND EXISTS (SELECT 1 FROM submissions s WHERE s.owner=submissions.owner AND s.slug=submissions.slug AND s.status='accepted' AND s.id NOT LIKE 'solved:%')");
  const owner = currentOwner(); let count = 0;
  db.transaction(() => {
    for (const s of items) {
      if (s.id.startsWith('public:') && exists.get(owner, `session:${s.id.slice(7)}`)) continue;
      count += stmt.run({ ...s, owner, runtime: s.runtime ?? null, hints: +(s.hints ?? false), minutes: s.minutes ?? null }).changes;
      if (s.id.startsWith('session:')) remove.run(owner, `public:${s.id.slice(8)}`);
    }
    if (items.some(s => s.status === 'accepted')) removeStandIns.run(owner);
  })();
  return count;
}
export function getSubmissions(): Submission[] { return (db.prepare('SELECT id,slug,timestamp,status,attempts,runtime,source,hints,minutes FROM submissions WHERE owner=? ORDER BY timestamp').all(currentOwner()) as any[]).map(s => ({ ...s, runtime: s.runtime ?? undefined, minutes: s.minutes ?? undefined, hints: !!s.hints })); }
export function getProfile(): Profile { return getKV<Profile>('profile', { username: getSettings().username, solved: { Easy: 0, Medium: 0, Hard: 0 }, tagStats: {} }); }
export function getVerifiedSolved(): Set<string> { return new Set((db.prepare("SELECT DISTINCT slug FROM submissions WHERE owner=? AND status='accepted'").all(currentOwner()) as { slug: string }[]).map(row => row.slug)); }
export function getUnsolvedProblems(): Problem[] { const solved = new Set((db.prepare("SELECT DISTINCT p.id FROM submissions s JOIN problems p ON p.slug=s.slug WHERE s.owner=? AND s.status='accepted' AND p.id IS NOT NULL").all(currentOwner()) as { id: string }[]).map(row => row.id)); return getProblems().filter(p => !solved.has(p.id)); }
export function getRecommendationHistory(account: string): Map<string, { shownAt: number; position: number }> { return new Map((db.prepare('SELECT slug,shown_at,position FROM recommendation_history WHERE account=?').all(scopedAccount(account)) as { slug: string; shown_at: number; position: number }[]).map(row => [row.slug, { shownAt: row.shown_at, position: row.position }])); }
export function getSkipped(account: string): Map<string, number> { return new Map((db.prepare('SELECT slug,skipped_at FROM recommendation_skips WHERE account=?').all(scopedAccount(account)) as { slug: string; skipped_at: number }[]).map(row => [row.slug, row.skipped_at])); }
export function recordRecommendations(account: string, slugs: string[]) { if (!account) return; const statement = db.prepare('INSERT INTO recommendation_history(account,slug,shown_at,position) VALUES(?,?,?,?) ON CONFLICT(account,slug) DO UPDATE SET shown_at=excluded.shown_at,position=excluded.position'); const now = Date.now(), key = scopedAccount(account); db.transaction(() => { slugs.forEach((slug, position) => statement.run(key, slug, now, position)); })(); }
export function skipRecommendation(account: string, slug: string) { db.prepare('INSERT INTO recommendation_skips(account,slug,skipped_at) VALUES(?,?,?) ON CONFLICT(account,slug) DO UPDATE SET skipped_at=excluded.skipped_at').run(scopedAccount(account), slug, Date.now()); }
export function switchAccount(prior: Settings, next: Settings) {
  db.transaction(() => {
    if (prior.username) setKV(`account:${prior.username}`, { profile: getProfile(), submissions: getSubmissions(), lastSyncAt: getKV<number | undefined>('lastSyncAt', undefined), lastSyncError: getKV<string>('lastSyncError', '') });
    const saved = getKV<{ profile: Profile; submissions: Submission[]; lastSyncAt?: number; lastSyncError?: string } | null>(`account:${next.username}`, null);
    db.prepare('DELETE FROM submissions WHERE owner=?').run(currentOwner());
    db.prepare('DELETE FROM ratings WHERE owner=?').run(currentOwner());
    for (const key of ['lastModel', 'lastSyncAt', 'lastSyncError', 'lastSyncNewSolves', 'encryptedSession']) db.prepare('DELETE FROM kv WHERE key=?').run(scopedKey(key));
    setKV('settings', { ...next, hasSession: undefined });
    if (saved) { saveSubmissions(saved.submissions); setKV('profile', saved.profile); if (saved.lastSyncAt) setKV('lastSyncAt', saved.lastSyncAt); if (saved.lastSyncError) setKV('lastSyncError', saved.lastSyncError); }
    else setKV('profile', { username: next.username, solved: { Easy: 0, Medium: 0, Hard: 0 }, tagStats: {} });
  })();
}
export function saveRatings(model: { skills: { tag: string; rating: number; confidence: number; attempts: number; failures: number; weak: boolean }[]; updatedAt: number }) { const owner = currentOwner(); db.transaction(() => { db.prepare('DELETE FROM ratings WHERE owner=?').run(owner); const stmt = db.prepare('INSERT INTO ratings VALUES(?,?,?,?,?,?,?,?)'); for (const s of model.skills) stmt.run(owner, s.tag, s.rating, s.confidence, s.attempts, s.failures, +s.weak, model.updatedAt); })(); }
// Saved lists predate per-user data, so only the local owner sees them.
export function getLegacyLists() { return multiUser && currentOwner() !== LOCAL_OWNER ? [] : db.prepare('SELECT lists.name, list_items.slug FROM list_items JOIN lists ON lists.id=list_items.list_id').all(); }

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const bounded = (value: unknown, lo: number, hi: number) => typeof value === 'number' && Number.isFinite(value) ? Math.max(lo, Math.min(hi, value)) : undefined;
const text = (value: unknown, max: number) => typeof value === 'string' ? value.slice(0, max) : undefined;
export const usernamePattern = /^[A-Za-z0-9_-]{1,40}$/;
const slugPattern = /^[a-z0-9-]{1,120}$/;
const validAccount = (value: unknown): value is string => value === '' || (typeof value === 'string' && usernamePattern.test(value));
export function cleanSettings(prior: Settings, input: unknown): Settings {
  const body = isRecord(input) ? input : {}, weights = isRecord(body.weights) ? body.weights : {};
  const username = typeof body.username === 'string' && validAccount(body.username.trim()) ? body.username.trim() : prior.username;
  return { ...prior, username, useContestRatings: typeof body.useContestRatings === 'boolean' ? body.useContestRatings : prior.useContestRatings, halfLifeDays: bounded(body.halfLifeDays, 7, 365) ?? prior.halfLifeDays, planSize: bounded(body.planSize, 1, 12) ?? prior.planSize, weights: Object.fromEntries(Object.entries(prior.weights).map(([key, value]) => [key, bounded(weights[key], 0, 8) ?? value])) as Settings['weights'], hasSession: prior.hasSession };
}

// Hosted visitors keep their data in their own browser. Each request loads that copy under a
// throwaway owner, sends the updated copy back, and deletes it, so the server keeps nothing.
// Everything a browser sends is untrusted and only ever affects that visitor's own results.
export type VisitorState = { kv: Record<string, unknown>; submissions: Submission[]; history: [string, string, number, number][]; skips: [string, string, number][] };
function cleanProfile(input: unknown): Profile | undefined {
  if (!isRecord(input)) return undefined;
  const solved = isRecord(input.solved) ? input.solved : {}, tagStats = isRecord(input.tagStats) ? Object.entries(input.tagStats).slice(0, 500) : [];
  return { username: validAccount(input.username) ? input.username : '', ranking: bounded(input.ranking, 0, 1e9), contestRating: bounded(input.contestRating, 0, 5000), solved: { Easy: bounded(solved.Easy, 0, 1e5) ?? 0, Medium: bounded(solved.Medium, 0, 1e5) ?? 0, Hard: bounded(solved.Hard, 0, 1e5) ?? 0 }, tagStats: Object.fromEntries(tagStats.filter(([tag]) => tag.length <= 80).map(([tag, count]) => [tag, bounded(count, 0, 1e5) ?? 0])), lastSync: bounded(input.lastSync, 0, 1e14) };
}
function cleanSubmissions(input: unknown): Submission[] {
  return (Array.isArray(input) ? input.slice(0, 20000) : []).flatMap((s): Submission[] => {
    const timestamp = isRecord(s) ? bounded(s.timestamp, 0, 1e14) : undefined;
    if (!isRecord(s) || timestamp === undefined || typeof s.id !== 'string' || s.id.length > 80 || typeof s.slug !== 'string' || !slugPattern.test(s.slug) || !['accepted', 'failed', 'attempted'].includes(s.status as string) || !['public', 'session', 'import', 'feedback'].includes(s.source as string)) return [];
    return [{ id: s.id, slug: s.slug, timestamp, status: s.status as Submission['status'], attempts: Math.round(bounded(s.attempts, 1, 50) ?? 1), runtime: text(s.runtime, 30), source: s.source as Submission['source'], hints: s.hints === true, minutes: bounded(s.minutes, 0, 1440) }];
  });
}
// Only the overall and per-topic ratings of the previous model are needed to report rating changes.
export function modelSummary(input: unknown) {
  const overall = isRecord(input) ? bounded(input.overall, 0, 5000) : undefined;
  if (!isRecord(input) || overall === undefined) return undefined;
  return { overall, skills: (Array.isArray(input.skills) ? input.skills.slice(0, 1000) : []).flatMap(s => isRecord(s) && typeof s.tag === 'string' && s.tag.length <= 80 && bounded(s.rating, 0, 5000) !== undefined ? [{ tag: s.tag, rating: bounded(s.rating, 0, 5000)! }] : []) };
}
const visitorKeys = new Map<string, (value: unknown) => unknown>([
  ['settings', value => ({ ...cleanSettings(defaults, value), hasSession: undefined })],
  ['profile', cleanProfile],
  ['lastSyncAt', value => bounded(value, 0, 1e14)],
  ['lastSyncNewSolves', value => bounded(value, 0, 1e5)],
  ['lastSyncError', value => text(value, 300)],
  ['lastModel', modelSummary],
]);
// Saved snapshots of other usernames from switchAccount. The session cookie is never part of visitor state.
const cleanAccount = (value: unknown) => { const profile = isRecord(value) ? cleanProfile(value.profile) : undefined; return isRecord(value) && profile ? { profile, submissions: cleanSubmissions(value.submissions), lastSyncAt: bounded(value.lastSyncAt, 0, 1e14), lastSyncError: text(value.lastSyncError, 300) ?? '' } : undefined; };
const cleanerFor = (key: string) => visitorKeys.get(key) ?? (/^account:[A-Za-z0-9_-]{1,40}$/.test(key) ? cleanAccount : undefined);
// Index-friendly bounds for every key that starts with prefix (which always ends in ':').
const prefixRange = (prefix: string) => [prefix, `${prefix.slice(0, -1)};`];
export function exportVisitorState(now = Date.now()): VisitorState {
  const owner = currentOwner(), keys = prefixRange(`u:${owner}:`), accounts = prefixRange(`${owner}:`), strip = (account: string) => account.slice(accounts[0].length);
  const kv = Object.fromEntries((db.prepare('SELECT key,value FROM kv WHERE key>=? AND key<?').all(...keys) as { key: string; value: string }[]).map(row => [row.key.slice(keys[0].length), row.value] as const).filter(([key]) => cleanerFor(key)).map(([key, value]) => [key, JSON.parse(value)]));
  // The engine only uses recommendation history from the last 21 days and skips from the last 30.
  const history = (db.prepare('SELECT account,slug,shown_at,position FROM recommendation_history WHERE account>=? AND account<? AND shown_at>?').all(...accounts, now - 21 * DAY) as { account: string; slug: string; shown_at: number; position: number }[]).map(row => [strip(row.account), row.slug, row.shown_at, row.position] as [string, string, number, number]);
  const skips = (db.prepare('SELECT account,slug,skipped_at FROM recommendation_skips WHERE account>=? AND account<? AND skipped_at>?').all(...accounts, now - 30 * DAY) as { account: string; slug: string; skipped_at: number }[]).map(row => [strip(row.account), row.slug, row.skipped_at] as [string, string, number]);
  return { kv, submissions: getSubmissions(), history, skips };
}
export function importVisitorState(input: unknown) {
  if (!isRecord(input)) return;
  const rows = (value: unknown, max: number) => (Array.isArray(value) ? value.slice(0, max) : []).filter((row): row is unknown[] => Array.isArray(row) && validAccount(row[0]) && typeof row[1] === 'string' && slugPattern.test(row[1]));
  const history = db.prepare('INSERT OR REPLACE INTO recommendation_history(account,slug,shown_at,position) VALUES(?,?,?,?)'), skips = db.prepare('INSERT OR REPLACE INTO recommendation_skips(account,slug,skipped_at) VALUES(?,?,?)');
  db.transaction(() => {
    for (const [key, value] of Object.entries(isRecord(input.kv) ? input.kv : {})) { const clean = cleanerFor(key)?.(value); if (clean !== undefined) setKV(key, clean); }
    saveSubmissions(cleanSubmissions(input.submissions));
    for (const [account, slug, shownAt, position] of rows(input.history, 5000)) if (bounded(shownAt, 0, 1e14) !== undefined) history.run(scopedAccount(account as string), slug, shownAt, Math.round(bounded(position, 0, 1000) ?? 0));
    for (const [account, slug, skippedAt] of rows(input.skips, 5000)) if (bounded(skippedAt, 0, 1e14) !== undefined) skips.run(scopedAccount(account as string), slug, skippedAt);
  })();
}
export function deleteVisitorState() {
  const owner = currentOwner();
  if (owner === LOCAL_OWNER) return;
  db.transaction(() => {
    db.prepare('DELETE FROM kv WHERE key>=? AND key<?').run(...prefixRange(`u:${owner}:`));
    for (const table of ['submissions', 'ratings']) db.prepare(`DELETE FROM ${table} WHERE owner=?`).run(owner);
    for (const table of ['recommendation_history', 'recommendation_skips']) db.prepare(`DELETE FROM ${table} WHERE account>=? AND account<?`).run(...prefixRange(`${owner}:`));
  })();
}
