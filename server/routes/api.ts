import { Router } from 'express';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Problem, SearchFilters, Settings, Submission } from '../../shared/types.js';
import { fetchCatalog, fetchFullHistory, fetchProfile, fetchRatings, fetchRecent, fetchVotes } from '../adapters/leetcode.js';
import { buildModel, recommend } from '../engine/capabilityEngine.js';
import { db, getKV, getProblems, getProfile, getSettings, getSubmissions, saveProblems, saveSubmissions, setKV } from '../db/index.js';

export const api = Router();
const errorText = (error: unknown) => error instanceof Error ? error.message : 'Unknown error';
let catalogJob = { running: false, loaded: 0, total: 0, phase: '', error: '' };
const secretPath = resolve(dirname(process.env.DATABASE_PATH || './data/rickyleet.sqlite'), 'session.key');
function sessionKey() { mkdirSync(dirname(secretPath), { recursive: true }); if (!existsSync(secretPath)) writeFileSync(secretPath, randomBytes(32), { mode: 0o600 }); return readFileSync(secretPath); }
function encrypt(value: string) { const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', sessionKey(), iv); const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64'); }
function decrypt(value: string) { const raw = Buffer.from(value, 'base64'); const decipher = createDecipheriv('aes-256-gcm', sessionKey(), raw.subarray(0, 12)); decipher.setAuthTag(raw.subarray(12, 28)); return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8'); }
function getSession() { const encrypted = getKV<string>('encryptedSession', ''); return process.env.LEETCODE_SESSION || (encrypted ? decrypt(encrypted) : ''); }
async function sync() {
  const username = getSettings().username.trim();
  if (!username) return { newSolves: 0, error: '' };
  try {
    const profile = await fetchProfile(username);
    setKV('profile', profile);
    let incoming = await fetchRecent(username);
    const session = getSession();
    if (session) { try { incoming = await fetchFullHistory(session, new Set(getSubmissions().filter(s => s.source === 'session').map(s => s.id))); db.prepare("DELETE FROM submissions WHERE source='public'").run(); } catch (error) { setKV('sessionError', errorText(error)); } }
    const before = new Set(getSubmissions().filter(s => s.status === 'accepted').map(s => s.slug));
    saveSubmissions(incoming);
    const after = new Set(getSubmissions().filter(s => s.status === 'accepted').map(s => s.slug));
    setKV('lastSyncError', '');
    return { newSolves: after.size - before.size, error: '' };
  } catch (error) { const message = errorText(error); setKV('lastSyncError', message); return { newSolves: 0, error: message }; }
}
function currentModel() { return buildModel(getProblems(), getSubmissions(), getProfile(), getSettings()); }

api.get('/bootstrap', (_req, res) => {
  const problems = getProblems();
  res.json({ settings: getSettings(), profile: getProfile(), model: currentModel(), catalogCount: problems.length, tags: [...new Set(problems.flatMap(p => p.tags))].sort(), companies: [...new Set(problems.flatMap(p => p.companyTags ?? []))].sort(), catalogJob, lists: db.prepare('SELECT * FROM lists ORDER BY name').all(), syncError: getKV('lastSyncError', '') });
});
api.post('/search', async (req, res) => {
  const before = getKV<ReturnType<typeof currentModel>>('lastModel', currentModel());
  const result = await sync();
  const problems = getProblems(), submissions = getSubmissions(), profile = getProfile(), settings = getSettings();
  const model = buildModel(problems, submissions, profile, settings);
  db.transaction(() => { db.prepare('DELETE FROM ratings').run(); const stmt = db.prepare('INSERT INTO ratings VALUES(?,?,?,?,?,?,?)'); for (const s of model.skills) stmt.run(s.tag, s.rating, s.confidence, s.attempts, s.failures, +s.weak, model.updatedAt); })();
  const changes = model.skills.map(s => ({ tag: s.tag, before: before.skills.find(x => x.tag === s.tag)?.rating ?? before.overall, after: s.rating })).filter(x => x.before !== x.after).sort((a, b) => Math.abs(b.after - b.before) - Math.abs(a.after - a.before)).slice(0, 3);
  setKV('lastModel', model);
  res.json({ recommendations: recommend(problems, submissions, model, settings, req.body as SearchFilters), model, profile, delta: { newSolves: result.newSolves, changes }, catalogCount: problems.length, syncError: result.error });
});
api.post('/sync', async (_req, res) => res.json(await sync()));
api.post('/catalog/refresh', (_req, res) => {
  if (catalogJob.running) { res.json(catalogJob); return; }
  catalogJob = { running: true, loaded: 0, total: 0, phase: 'catalog', error: '' };
  void (async () => {
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
  })();
  res.json(catalogJob);
});
api.get('/catalog/status', (_req, res) => res.json(catalogJob));
api.put('/settings', (req, res) => {
  const prior = getSettings(); const body = req.body as Partial<Settings>;
  const clean: Settings = { ...prior, username: typeof body.username === 'string' ? body.username.trim().slice(0, 80) : prior.username, useContestRatings: typeof body.useContestRatings === 'boolean' ? body.useContestRatings : prior.useContestRatings, halfLifeDays: Number.isFinite(body.halfLifeDays) ? Math.max(7, Math.min(365, Number(body.halfLifeDays))) : prior.halfLifeDays, planSize: Number.isFinite(body.planSize) ? Math.max(1, Math.min(12, Number(body.planSize))) : prior.planSize, weights: { ...prior.weights }, hasSession: prior.hasSession };
  for (const key of Object.keys(prior.weights) as (keyof Settings['weights'])[]) if (Number.isFinite(body.weights?.[key])) clean.weights[key] = Math.max(0, Math.min(8, Number(body.weights![key])));
  setKV('settings', { ...clean, hasSession: undefined });
  if (clean.username !== prior.username) setKV('profile', { username: clean.username, solved: { Easy: 0, Medium: 0, Hard: 0 }, tagStats: {} });
  res.json(getSettings());
});
api.post('/session', (req, res) => {
  const value = String(req.body.session ?? '').trim();
  if (value && !/^[A-Za-z0-9_\-.%]+$/.test(value)) { res.status(400).json({ error: 'Invalid cookie format' }); return; }
  setKV('encryptedSession', value ? encrypt(value) : '');
  res.json({ hasSession: !!value || !!process.env.LEETCODE_SESSION });
});
api.post('/feedback', (req, res) => {
  const { slug, action, attempts, hints, minutes } = req.body as { slug: string; action: string; attempts?: number; hints?: boolean; minutes?: number };
  if (!getProblems().some(p => p.slug === slug) || !['solved', 'attempted', 'skipped', 'too-easy', 'too-hard'].includes(action)) { res.status(400).json({ error: 'Invalid feedback' }); return; }
  const status = action === 'solved' || action === 'too-easy' ? 'accepted' : action === 'skipped' ? 'attempted' : 'failed';
  const submission: Submission = { id: `feedback:${crypto.randomUUID()}`, slug, timestamp: Date.now(), status, attempts: Math.max(1, Math.min(20, Number(attempts) || (action === 'too-hard' ? 3 : 1))), hints: !!hints, minutes: Number(minutes) || (action === 'too-easy' ? 5 : action === 'too-hard' ? 150 : undefined), source: 'feedback' };
  saveSubmissions([submission]); res.json({ ok: true });
});
api.post('/import', (req, res) => {
  const slugs = Array.isArray(req.body.slugs) ? req.body.slugs : [];
  const valid = new Set(getProblems().map(p => p.slug));
  const submissions: Submission[] = slugs.filter((s: unknown): s is string => typeof s === 'string' && valid.has(s)).map((slug: string) => ({ id: `import:${slug}`, slug, timestamp: Date.now(), status: 'accepted', attempts: 1, source: 'import' }));
  res.json({ imported: saveSubmissions(submissions), ignored: slugs.length - submissions.length });
});
api.get('/export', (_req, res) => { res.setHeader('Content-Disposition', 'attachment; filename="rickyleet-export.json"'); res.json({ profile: getProfile(), settings: getSettings(), submissions: getSubmissions(), lists: db.prepare('SELECT lists.name, list_items.slug FROM list_items JOIN lists ON lists.id=list_items.list_id').all() }); });
api.post('/reset', (_req, res) => { db.transaction(() => { db.prepare('DELETE FROM submissions').run(); db.prepare('DELETE FROM ratings').run(); db.prepare("DELETE FROM kv WHERE key='lastModel'").run(); })(); res.json({ ok: true }); });
api.get('/lists', (_req, res) => res.json(db.prepare('SELECT l.id,l.name,li.slug FROM lists l LEFT JOIN list_items li ON l.id=li.list_id ORDER BY l.name').all()));
api.post('/lists', (req, res) => { const name = String(req.body.name ?? '').trim().slice(0, 60); if (!name) { res.status(400).json({ error: 'Name required' }); return; } db.prepare('INSERT OR IGNORE INTO lists(name) VALUES(?)').run(name); res.json({ ok: true }); });
api.post('/lists/:id/items', (req, res) => { const id = Number(req.params.id), slug = String(req.body.slug ?? ''); if (!getProblems().some(p => p.slug === slug)) { res.status(400).json({ error: 'Unknown problem' }); return; } db.prepare('INSERT OR IGNORE INTO list_items(list_id,slug) VALUES(?,?)').run(id, slug); res.json({ ok: true }); });
api.delete('/lists/:id/items/:slug', (req, res) => { db.prepare('DELETE FROM list_items WHERE list_id=? AND slug=?').run(Number(req.params.id), req.params.slug); res.json({ ok: true }); });
api.get('/plan', (_req, res) => { const problems = getProblems(), subs = getSubmissions(), settings = getSettings(), model = currentModel(); const all = recommend(problems, subs, model, settings, {}, Date.now(), 150); const easy = all.find(r => r.problem.difficulty === 'Easy' && !r.review); const review = all.find(r => r.review); const stretch = [...all].sort((a, b) => a.probability - b.probability).find(r => r.probability >= 0.25 && r.probability <= 0.55 && !r.review); const targets = all.filter(r => r.probability >= 0.55 && r.probability <= 0.75 && !r.review).slice(0, Math.max(1, settings.planSize - (review ? 3 : 2))); const selected = [easy, ...targets, stretch, review, ...all].filter((r): r is typeof all[number] => !!r); res.json([...new Map(selected.map(r => [r.problem.slug, r])).values()].slice(0, settings.planSize)); });
