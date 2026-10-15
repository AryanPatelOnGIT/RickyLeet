import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Problem, Profile, Settings, Submission } from '../../shared/types.js';

const path = resolve(process.env.DATABASE_PATH || './data/rickyleet.sqlite');
mkdirSync(dirname(path), { recursive: true });
export const db = new Database(path);
db.pragma('journal_mode = WAL');
db.exec(`CREATE TABLE IF NOT EXISTS problems (slug TEXT PRIMARY KEY, id TEXT, title TEXT, difficulty TEXT, acceptance REAL, tags TEXT, paid INTEGER, likes INTEGER, dislikes INTEGER, rating REAL, companyTags TEXT, createdAt TEXT);
CREATE INDEX IF NOT EXISTS idx_problems_id ON problems(id);
CREATE INDEX IF NOT EXISTS idx_problems_difficulty ON problems(difficulty);
CREATE TABLE IF NOT EXISTS submissions (id TEXT PRIMARY KEY, slug TEXT, timestamp INTEGER, status TEXT, attempts INTEGER, runtime TEXT, source TEXT, hints INTEGER, minutes REAL);
CREATE INDEX IF NOT EXISTS idx_submissions_slug_time ON submissions(slug,timestamp);
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS lists (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL);
CREATE TABLE IF NOT EXISTS list_items (list_id INTEGER, slug TEXT, PRIMARY KEY(list_id,slug));
CREATE TABLE IF NOT EXISTS ratings (tag TEXT PRIMARY KEY, rating REAL, confidence REAL, attempts INTEGER, failures INTEGER, weak INTEGER, updated_at INTEGER);
CREATE TABLE IF NOT EXISTS recommendation_history (account TEXT NOT NULL, slug TEXT NOT NULL, shown_at INTEGER NOT NULL, position INTEGER NOT NULL, PRIMARY KEY(account,slug));
CREATE INDEX IF NOT EXISTS idx_recommendation_history_account_time ON recommendation_history(account,shown_at);
CREATE TABLE IF NOT EXISTS recommendation_skips (account TEXT NOT NULL, slug TEXT NOT NULL, skipped_at INTEGER NOT NULL, PRIMARY KEY(account,slug));
CREATE INDEX IF NOT EXISTS idx_recommendation_skips_account_time ON recommendation_skips(account,skipped_at);`);
const defaults: Settings = { username: '', useContestRatings: false, halfLifeDays: 90, weights: { targetFit: 4, weakness: 2, exploration: 1.5, quality: 1, diversity: 1.5, fatigue: 1 }, planSize: 4, hasSession: false };
export function getKV<T>(key: string, fallback: T): T { const row = db.prepare('SELECT value FROM kv WHERE key=?').get(key) as { value: string } | undefined; try { return row ? JSON.parse(row.value) as T : fallback; } catch { return fallback; } }
export function setKV(key: string, value: unknown) { db.prepare('INSERT INTO kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value)); }
export function getSettings(): Settings { return { ...defaults, ...getKV<Partial<Settings>>('settings', {}), weights: { ...defaults.weights, ...getKV<Partial<Settings>>('settings', {}).weights }, hasSession: !!process.env.LEETCODE_SESSION || !!getKV<string>('encryptedSession', '') }; }
export function saveProblems(items: Problem[]) { const insert = db.prepare('INSERT INTO problems(slug,id,title,difficulty,acceptance,tags,paid,likes,dislikes,rating,companyTags,createdAt) VALUES(@slug,@id,@title,@difficulty,@acceptance,@tags,@paid,@likes,@dislikes,@rating,@companyTags,@createdAt) ON CONFLICT(slug) DO UPDATE SET id=excluded.id,title=excluded.title,difficulty=excluded.difficulty,acceptance=excluded.acceptance,tags=excluded.tags,paid=excluded.paid,likes=CASE WHEN excluded.likes=0 AND excluded.dislikes=0 THEN problems.likes ELSE excluded.likes END,dislikes=CASE WHEN excluded.likes=0 AND excluded.dislikes=0 THEN problems.dislikes ELSE excluded.dislikes END,companyTags=excluded.companyTags'); db.transaction(() => { for (const p of items) insert.run({ ...p, tags: JSON.stringify(p.tags), paid: +p.paid, rating: p.rating ?? null, companyTags: JSON.stringify(p.companyTags ?? []), createdAt: p.createdAt ?? new Date().toISOString() }); })(); }
export function getProblems(): Problem[] { return (db.prepare('SELECT * FROM problems').all() as any[]).map(p => ({ ...p, tags: JSON.parse(p.tags), companyTags: JSON.parse(p.companyTags || '[]'), paid: !!p.paid, rating: p.rating ?? undefined })); }
export function saveSubmissions(items: Submission[]): number { const stmt = db.prepare('INSERT OR IGNORE INTO submissions(id,slug,timestamp,status,attempts,runtime,source,hints,minutes) VALUES(@id,@slug,@timestamp,@status,@attempts,@runtime,@source,@hints,@minutes)'); let count = 0; db.transaction(() => { for (const s of items) count += stmt.run({ ...s, runtime: s.runtime ?? null, hints: +(s.hints ?? false), minutes: s.minutes ?? null }).changes; })(); return count; }
export function getSubmissions(): Submission[] { return (db.prepare('SELECT * FROM submissions ORDER BY timestamp').all() as any[]).map(s => ({ ...s, hints: !!s.hints })); }
export function getProfile(): Profile { return getKV<Profile>('profile', { username: getSettings().username, solved: { Easy: 0, Medium: 0, Hard: 0 }, tagStats: {} }); }
export function getVerifiedSolved(): Set<string> { return new Set((db.prepare("SELECT DISTINCT slug FROM submissions WHERE status='accepted'").all() as { slug: string }[]).map(row => row.slug)); }
export function getUnsolvedProblems(): Problem[] { const solved = new Set((db.prepare("SELECT DISTINCT p.id FROM submissions s JOIN problems p ON p.slug=s.slug WHERE s.status='accepted' AND p.id IS NOT NULL").all() as { id: string }[]).map(row => row.id)); return getProblems().filter(p => !solved.has(p.id)); }
export function getRecommendationHistory(account: string): Map<string, { shownAt: number; position: number }> { return new Map((db.prepare('SELECT slug,shown_at,position FROM recommendation_history WHERE account=?').all(account) as { slug: string; shown_at: number; position: number }[]).map(row => [row.slug, { shownAt: row.shown_at, position: row.position }])); }
export function getSkipped(account: string): Map<string, number> { return new Map((db.prepare('SELECT slug,skipped_at FROM recommendation_skips WHERE account=?').all(account) as { slug: string; skipped_at: number }[]).map(row => [row.slug, row.skipped_at])); }
export function recordRecommendations(account: string, slugs: string[]) { if (!account) return; const statement = db.prepare('INSERT INTO recommendation_history(account,slug,shown_at,position) VALUES(?,?,?,?) ON CONFLICT(account,slug) DO UPDATE SET shown_at=excluded.shown_at,position=excluded.position'); const now = Date.now(); db.transaction(() => { slugs.forEach((slug, position) => statement.run(account, slug, now, position)); })(); }
export function skipRecommendation(account: string, slug: string) { db.prepare('INSERT INTO recommendation_skips(account,slug,skipped_at) VALUES(?,?,?) ON CONFLICT(account,slug) DO UPDATE SET skipped_at=excluded.skipped_at').run(account, slug, Date.now()); }
export function switchAccount(prior: Settings, next: Settings) {
  db.transaction(() => {
    if (prior.username) setKV(`account:${prior.username}`, { profile: getProfile(), submissions: getSubmissions(), lastSyncAt: getKV<number | undefined>('lastSyncAt', undefined), lastSyncError: getKV<string>('lastSyncError', '') });
    const saved = getKV<{ profile: Profile; submissions: Submission[]; lastSyncAt?: number; lastSyncError?: string } | null>(`account:${next.username}`, null);
    db.prepare('DELETE FROM submissions').run();
    db.prepare('DELETE FROM ratings').run();
    db.prepare("DELETE FROM kv WHERE key IN ('lastModel','lastSyncAt','lastSyncError','lastSyncNewSolves','encryptedSession')").run();
    setKV('settings', { ...next, hasSession: undefined });
    if (saved) { saveSubmissions(saved.submissions); setKV('profile', saved.profile); if (saved.lastSyncAt) setKV('lastSyncAt', saved.lastSyncAt); if (saved.lastSyncError) setKV('lastSyncError', saved.lastSyncError); }
    else setKV('profile', { username: next.username, solved: { Easy: 0, Medium: 0, Hard: 0 }, tagStats: {} });
  })();
}
