import { Router, type Request, type Response } from 'express';
import { waitUntil } from '@vercel/functions';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { SearchFilters, Settings, Submission, SyncStatus } from '../../shared/types.js';
import { fetchCatalog, fetchFullHistory, fetchProfileSnapshot, fetchRatings, fetchVotes } from '../adapters/leetcode.js';
import { buildModel, recommend } from '../engine/capabilityEngine.js';
import { currentOwner, multiUser } from '../context.js';
import { cleanSettings, databasePath, db, getKV, getLegacyLists, getProblems, getProfile, getRecommendationHistory, getSettings, getSkipped, getSubmissions, getUnsolvedProblems, getVerifiedSolved, modelSummary, recordRecommendations, saveProblems, saveRatings, saveSubmissions, setKV, skipRecommendation, switchAccount, usernamePattern } from '../db/index.js';

export const api = Router();
const errorText = (error: unknown) => error instanceof Error ? error.message : 'Unknown error';
let catalogJob = { running: false, loaded: 0, total: 0, phase: '', error: '' };
const secretPath = resolve(dirname(databasePath), 'session.key');
function sessionKey() { mkdirSync(dirname(secretPath), { recursive: true }); if (!existsSync(secretPath)) writeFileSync(secretPath, randomBytes(32), { mode: 0o600 }); return readFileSync(secretPath); }
function encrypt(value: string) { const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', sessionKey(), iv); const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64'); }
function decrypt(value: string) { const raw = Buffer.from(value, 'base64'); const decipher = createDecipheriv('aes-256-gcm', sessionKey(), raw.subarray(0, 12)); decipher.setAuthTag(raw.subarray(12, 28)); return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8'); }
// Session cookies grant account access, so only a local single-user server uses them. Hosted visitors rely on public data and imports.
function getSession() { if (multiUser) return ''; const encrypted = getKV<string>('encryptedSession', ''); try { return process.env.LEETCODE_SESSION || (encrypted ? decrypt(encrypted) : ''); } catch { return ''; } }
const localOnly = (feature: string) => ({ error: `${feature} only works when RickyLeet runs on your own computer.` });
// In-flight syncs are tracked per owner so one visitor never waits on (or reuses) another's sync.
const syncs = new Map<string, { username: string; promise: Promise<{ newSolves: number; error: string }> }>();
export function getSyncStatus(): SyncStatus { const reported = getProfile().solved; const reportedSolved = reported.Easy + reported.Medium + reported.Hard; return { running: syncs.has(currentOwner()), lastSync: getKV<number | undefined>('lastSyncAt', undefined), lastError: getKV<string>('lastSyncError', ''), newSolves: getKV<number>('lastSyncNewSolves', 0), verifiedSolved: getVerifiedSolved().size, reportedSolved }; }
async function syncOnce(username: string) {
  if (!username) return { newSolves: 0, error: '' };
  try {
    const { profile, recent } = await fetchProfileSnapshot(username);
    if (getSettings().username !== username) return { newSolves: 0, error: 'Profile changed during sync' };
    setKV('profile', profile);
    let incoming = recent;
    const session = getSession();
    let sessionError = '';
    if (session) { try { incoming = [...recent, ...await fetchFullHistory(session, new Set(getSubmissions().filter(s => s.source === 'session').map(s => s.id)), 40, username)]; } catch { sessionError = 'Full history unavailable or session account differs; saved solves were retained.'; } }
    if (getSettings().username !== username) return { newSolves: 0, error: 'Profile changed during sync' };
    const before = new Set(getSubmissions().filter(s => s.status === 'accepted').map(s => s.slug));
    saveSubmissions(incoming);
    const after = new Set(getSubmissions().filter(s => s.status === 'accepted').map(s => s.slug));
    const newSolves = after.size - before.size;
    setKV('lastSyncAt', Date.now()); setKV('lastSyncNewSolves', newSolves); setKV('lastSyncError', sessionError);
    return { newSolves, error: sessionError };
  } catch (error) { const message = errorText(error); setKV('lastSyncError', message); return { newSolves: 0, error: message }; }
}
export function syncLeetCode(force = false): Promise<{ newSolves: number; error: string }> { const owner = currentOwner(), username = getSettings().username.trim(), active = syncs.get(owner); if (active) return active.username === username ? active.promise : active.promise.then(() => syncLeetCode(force)); if (!force && Date.now() - (getKV<number>('lastSyncAt', 0)) < 5 * 60_000) return Promise.resolve({ newSolves: 0, error: '' }); const promise = syncOnce(username).finally(() => { syncs.delete(owner); }); syncs.set(owner, { username, promise }); return promise; }
function currentModel() { return buildModel(getProblems(), getSubmissions(), getProfile(), getSettings()); }
function parseFilters(input: unknown): SearchFilters {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const value = input as Record<string, unknown>;
  const allowed = <T extends string>(items: unknown, options: readonly T[]): T[] | undefined => Array.isArray(items) ? items.filter((item): item is T => typeof item === 'string' && options.includes(item as T)).slice(0, 20) : undefined;
  const number = (item: unknown, lo: number, hi: number) => typeof item === 'number' && Number.isFinite(item) ? Math.max(lo, Math.min(hi, item)) : undefined;
  return { query: typeof value.query === 'string' ? value.query.slice(0, 120) : undefined, difficulties: allowed(value.difficulties, ['Easy', 'Medium', 'Hard'] as const), tags: Array.isArray(value.tags) ? value.tags.filter((tag): tag is string => typeof tag === 'string').slice(0, 10) : undefined, companies: Array.isArray(value.companies) ? value.companies.filter((tag): tag is string => typeof tag === 'string').slice(0, 10) : undefined, minProbability: number(value.minProbability, 0, 1), maxProbability: number(value.maxProbability, 0, 1), minAcceptance: number(value.minAcceptance, 0, 100), maxAcceptance: number(value.maxAcceptance, 0, 100), access: allowed([value.access], ['all', 'free', 'paid'] as const)?.[0], status: allowed([value.status], ['all', 'unsolved', 'attempted', 'never-seen'] as const)?.[0], sort: allowed([value.sort], ['best', 'difficulty', 'acceptance', 'likes', 'newest'] as const)?.[0], groupBy: allowed([value.groupBy], ['none', 'topic', 'difficulty', 'pattern', 'skill'] as const)?.[0] };
}

// POST lets a hosted visitor's browser send its saved data; GET remains for local use.
api.route('/bootstrap').get(bootstrap).post(bootstrap);
function bootstrap(_req: Request, res: Response) {
  const problems = getProblems();
  res.json({ hosted: multiUser, settings: getSettings(), profile: getProfile(), model: currentModel(), catalogCount: problems.length, tags: [...new Set(problems.flatMap(p => p.tags))].sort(), catalogJob, syncStatus: getSyncStatus() });
}
function searchFromCache(filters: SearchFilters, newSolves = 0, syncError = '') {
  const previousModel = modelSummary(getKV<unknown>('lastModel', null));
  const allProblems = getProblems(), problems = getUnsolvedProblems(), submissions = getSubmissions(), profile = getProfile(), settings = getSettings();
  const model = buildModel(allProblems, submissions, profile, settings);
  saveRatings(model);
  const changes = model.skills.map(s => ({ tag: s.tag, before: previousModel?.skills.find(x => x.tag === s.tag)?.rating ?? previousModel?.overall ?? s.rating, after: s.rating })).filter(x => x.before !== x.after).sort((a, b) => Math.abs(b.after - b.before) - Math.abs(a.after - a.before)).slice(0, 3);
  setKV('lastModel', modelSummary(model));
  const recommendations = recommend(allProblems, submissions, model, settings, filters, Date.now(), 20, { previous: getRecommendationHistory(settings.username), skipped: getSkipped(settings.username), candidates: new Set(problems.map(p => p.slug)) });
  recordRecommendations(settings.username, recommendations.slice(0, 20).map(r => r.problem.slug));
  return { recommendations, model, profile, delta: { newSolves, changes }, catalogCount: allProblems.length, syncError, syncStatus: getSyncStatus() };
}
api.post('/search/cached', (req, res) => res.json(searchFromCache(parseFilters(req.body))));
api.post('/search', async (req, res) => { const result = await syncLeetCode(); res.json(searchFromCache(parseFilters(req.body), result.newSolves, result.error)); });
api.post('/sync', async (_req, res) => res.json({ ...(await syncLeetCode(true)), syncStatus: getSyncStatus() }));
api.get('/sync/status', (_req, res) => res.json(getSyncStatus()));
api.post('/catalog/refresh', (_req, res) => {
  // A hosted instance's database is temporary, so the hosted catalog comes from the bundled snapshot instead.
  if (multiUser) { res.status(403).json(localOnly('Refreshing the catalog')); return; }
  if (catalogJob.running) { res.json(catalogJob); return; }
  catalogJob = { running: true, loaded: 0, total: 0, phase: 'catalog', error: '' };
  waitUntil((async () => {
    try {
      await fetchCatalog((items, total) => { saveProblems(items); catalogJob.loaded += items.length; catalogJob.total = total; });
      catalogJob.total = catalogJob.loaded;
      catalogJob.phase = 'votes';
      const missing = (db.prepare('SELECT slug FROM problems WHERE likes=0 AND dislikes=0').all() as { slug: string }[]).map(r => r.slug);
      await fetchVotes(missing, items => { const update = db.prepare('UPDATE problems SET likes=?, dislikes=? WHERE slug=?'); db.transaction(() => { for (const item of items) update.run(item.likes, item.dislikes, item.slug); })(); });
      if (getSettings().useContestRatings) { try { const ratings = await fetchRatings(); const update = db.prepare('UPDATE problems SET rating=? WHERE slug=?'); db.transaction(() => { for (const [slug, rating] of ratings) update.run(rating, slug); })(); } catch (error) { catalogJob.error = `Catalog loaded; rating merge failed: ${errorText(error)}`; } }
    } catch (error) { catalogJob.error = errorText(error); }
    catalogJob.running = false;
    catalogJob.phase = 'done';
  })());
  res.json(catalogJob);
});
api.get('/catalog/status', (_req, res) => res.json(catalogJob));
api.put('/settings', (req, res) => {
  const prior = getSettings(); const body = (req.body ?? {}) as Partial<Settings>;
  if (body.username !== undefined && (typeof body.username !== 'string' || (body.username.trim() !== '' && !usernamePattern.test(body.username.trim())))) { res.status(400).json({ error: 'Invalid LeetCode username' }); return; }
  const clean = cleanSettings(prior, body);
  const changedAccount = clean.username !== prior.username;
  // Hosted requests end before a background sync could finish, so the browser's next search syncs instead.
  if (changedAccount) { switchAccount(prior, clean); if (clean.username && !multiUser) waitUntil(syncLeetCode()); }
  else setKV('settings', { ...clean, hasSession: undefined });
  res.json(getSettings());
});
api.post('/session', (req, res) => {
  if (multiUser) { res.status(403).json(localOnly('Saving a LeetCode session cookie')); return; }
  const value = String(req.body?.session ?? '').trim();
  if (value && !/^[A-Za-z0-9_\-.%]+$/.test(value)) { res.status(400).json({ error: 'Invalid cookie format' }); return; }
  setKV('encryptedSession', value ? encrypt(value) : '');
  if (value && getSettings().username) waitUntil(syncLeetCode());
  res.json({ hasSession: !!value || (!multiUser && !!process.env.LEETCODE_SESSION) });
});
api.post('/feedback', (req, res) => {
  const { slug, action, attempts, hints, minutes } = (req.body ?? {}) as { slug: string; action: string; attempts?: number; hints?: boolean; minutes?: number };
  if (typeof slug !== 'string' || !getProblems().some(p => p.slug === slug) || !['solved', 'attempted', 'skipped', 'too-easy', 'too-hard'].includes(action)) { res.status(400).json({ error: 'Invalid feedback' }); return; }
  if (action === 'skipped') { skipRecommendation(getSettings().username, slug); res.json({ ok: true }); return; }
  const status = action === 'solved' || action === 'too-easy' ? 'accepted' : action === 'attempted' ? 'attempted' : 'failed';
  const submission: Submission = { id: `feedback:${crypto.randomUUID()}`, slug, timestamp: Date.now(), status, attempts: Math.max(1, Math.min(20, Number(attempts) || (action === 'too-hard' ? 3 : 1))), hints: hints === true, minutes: Math.min(1440, Math.max(0, Number(minutes) || 0)) || (action === 'too-easy' ? 5 : action === 'too-hard' ? 150 : undefined), source: 'feedback' };
  saveSubmissions([submission]); res.json({ ok: true });
});
api.post('/import', (req, res) => {
  const slugs = Array.isArray(req.body?.slugs) ? req.body.slugs.slice(0, 10000) : [];
  const valid = new Set(getProblems().map(p => p.slug));
  const submissions: Submission[] = slugs.filter((s: unknown): s is string => typeof s === 'string' && valid.has(s)).map((slug: string) => ({ id: `import:${slug}`, slug, timestamp: Date.now(), status: 'accepted', attempts: 1, source: 'import' }));
  res.json({ imported: saveSubmissions(submissions), ignored: slugs.length - submissions.length });
});
api.route('/export').get(exportData).post(exportData);
function exportData(_req: Request, res: Response) { res.setHeader('Content-Disposition', 'attachment; filename="rickyleet-export.json"'); res.json({ profile: getProfile(), settings: getSettings(), submissions: getSubmissions(), lists: getLegacyLists() }); }
