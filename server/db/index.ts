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
CREATE TABLE IF NOT EXISTS ratings (tag TEXT PRIMARY KEY, rating REAL, confidence REAL, attempts INTEGER, failures INTEGER, weak INTEGER, updated_at INTEGER);`);
const defaults: Settings = { username: '', useContestRatings: false, halfLifeDays: 90, weights: { targetFit: 4, weakness: 2, exploration: 1.5, quality: 1, diversity: 1.5, fatigue: 1 }, planSize: 4, hasSession: false };
export function getKV<T>(key: string, fallback: T): T { const row = db.prepare('SELECT value FROM kv WHERE key=?').get(key) as { value: string } | undefined; try { return row ? JSON.parse(row.value) as T : fallback; } catch { return fallback; } }
export function setKV(key: string, value: unknown) { db.prepare('INSERT INTO kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value)); }
export function getSettings(): Settings { return { ...defaults, ...getKV<Partial<Settings>>('settings', {}), weights: { ...defaults.weights, ...getKV<Partial<Settings>>('settings', {}).weights }, hasSession: !!process.env.LEETCODE_SESSION || !!getKV<string>('encryptedSession', '') }; }
export function saveProblems(items: Problem[]) { const insert = db.prepare('INSERT INTO problems(slug,id,title,difficulty,acceptance,tags,paid,likes,dislikes,rating,companyTags,createdAt) VALUES(@slug,@id,@title,@difficulty,@acceptance,@tags,@paid,@likes,@dislikes,@rating,@companyTags,@createdAt) ON CONFLICT(slug) DO UPDATE SET id=excluded.id,title=excluded.title,difficulty=excluded.difficulty,acceptance=excluded.acceptance,tags=excluded.tags,paid=excluded.paid,likes=excluded.likes,dislikes=excluded.dislikes,companyTags=excluded.companyTags'); db.transaction(() => { for (const p of items) insert.run({ ...p, tags: JSON.stringify(p.tags), paid: +p.paid, rating: p.rating ?? null, companyTags: JSON.stringify(p.companyTags ?? []), createdAt: p.createdAt ?? new Date().toISOString() }); })(); }
export function getProblems(): Problem[] { return (db.prepare('SELECT * FROM problems').all() as any[]).map(p => ({ ...p, tags: JSON.parse(p.tags), companyTags: JSON.parse(p.companyTags || '[]'), paid: !!p.paid, rating: p.rating ?? undefined })); }
export function saveSubmissions(items: Submission[]): number { const stmt = db.prepare('INSERT OR IGNORE INTO submissions(id,slug,timestamp,status,attempts,runtime,source,hints,minutes) VALUES(@id,@slug,@timestamp,@status,@attempts,@runtime,@source,@hints,@minutes)'); let count = 0; db.transaction(() => { for (const s of items) count += stmt.run({ ...s, runtime: s.runtime ?? null, hints: +(s.hints ?? false), minutes: s.minutes ?? null }).changes; })(); return count; }
export function getSubmissions(): Submission[] { return (db.prepare('SELECT * FROM submissions ORDER BY timestamp').all() as any[]).map(s => ({ ...s, hints: !!s.hints })); }
export function getProfile(): Profile { return getKV<Profile>('profile', { username: getSettings().username, solved: { Easy: 0, Medium: 0, Hard: 0 }, tagStats: {} }); }
