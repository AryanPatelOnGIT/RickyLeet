import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

vi.mock('./adapters/leetcode.js', () => ({ fetchProfileSnapshot: vi.fn().mockRejectedValue(new Error('offline')) }));
const folder = mkdtempSync(join(tmpdir(), 'rickyleet-app-test-'));
process.env.DATABASE_PATH = join(folder, 'test.sqlite');
process.env.MULTI_USER = 'true';
const store = await import('./db/index.js');
// Saved before the app loads so the bundled catalog is not seeded into this test database.
store.saveProblems([{ id: '1', slug: 'two-sum', title: 'Two Sum', difficulty: 'Easy', acceptance: 55, tags: ['Array'], paid: false, likes: 1, dislikes: 0 }]);
const { app } = await import('./app.js');
let server: Server, base = '';

beforeAll(async () => {
  server = app.listen(0); await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});
afterAll(() => { server.close(); store.db.close(); if (!folder.startsWith(join(tmpdir(), 'rickyleet-app-test-'))) throw new Error('Unexpected test folder'); rmSync(folder, { recursive: true, force: true }); });

// A simulated browser that keeps its own saved data, like web/src/api.ts.
function browser() {
  let state: unknown;
  const request = async (path: string, method = 'POST', body?: Record<string, unknown>) => {
    const payload = method === 'GET' ? undefined : { ...body, ...(state === undefined ? {} : { visitorState: state }) };
    const response = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: payload && JSON.stringify(payload) });
    const data = await response.json();
    if ('visitorState' in data) { state = data.visitorState; delete data.visitorState; }
    return { status: response.status, ...data };
  };
  return Object.assign(request, { state: () => state });
}
const leftovers = () => ({ submissions: (store.db.prepare('SELECT COUNT(*) AS n FROM submissions').get() as { n: number }).n, kv: (store.db.prepare("SELECT COUNT(*) AS n FROM kv WHERE key LIKE 'u:%'").get() as { n: number }).n, skips: (store.db.prepare('SELECT COUNT(*) AS n FROM recommendation_skips').get() as { n: number }).n });

it('keeps each visitor\'s username and solves in their own browser only', async () => {
  const alice = browser(), bob = browser();
  await alice('/bootstrap');
  await bob('/bootstrap');
  expect((await alice('/settings', 'PUT', { username: 'alice' })).username).toBe('alice');
  await alice('/feedback', 'POST', { slug: 'two-sum', action: 'solved' });
  const aliceView = await alice('/bootstrap'), bobView = await bob('/bootstrap');
  expect(aliceView.hosted).toBe(true);
  expect(aliceView.settings.username).toBe('alice');
  expect(aliceView.syncStatus.verifiedSolved).toBe(1);
  expect(bobView.settings.username).toBe('');
  expect(bobView.syncStatus.verifiedSolved).toBe(0);
  expect(bobView.catalogCount).toBe(1);
  // Nothing about either visitor stays on the server, so any instance can answer the next request.
  expect(leftovers()).toEqual({ submissions: 0, kv: 0, skips: 0 });
});

it('keeps a visitor\'s data across requests and never overwrites it from a GET', async () => {
  const carol = browser();
  await carol('/settings', 'PUT', { username: 'carol', halfLifeDays: 30 });
  await carol('/feedback', 'POST', { slug: 'two-sum', action: 'skipped' });
  expect((await carol('/sync/status', 'GET')).verifiedSolved).toBe(0);
  const view = await carol('/bootstrap');
  expect(view.settings).toMatchObject({ username: 'carol', halfLifeDays: 30 });
  expect((await carol('/search/cached', 'POST', {})).recommendations).toHaveLength(0);
  expect(leftovers()).toEqual({ submissions: 0, kv: 0, skips: 0 });
});

it('sanitizes forged visitor data and refuses local-only features', async () => {
  const forged = { kv: { settings: { username: '<script>', halfLifeDays: 1e9 }, encryptedSession: 'stolen', constructor: 1 }, submissions: [{ id: 1 }, { id: 'x', slug: 'two-sum', timestamp: 1, status: 'accepted', source: 'feedback', attempts: 1 }], history: [['', 'NOT A SLUG', 1, 1]] };
  const response = await fetch(`${base}/bootstrap`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ visitorState: forged }) });
  const view = await response.json();
  expect(response.status).toBe(200);
  expect(view.settings).toMatchObject({ username: '', halfLifeDays: 365, hasSession: false });
  expect(view.syncStatus.verifiedSolved).toBe(1);
  expect(Object.keys(view.visitorState.kv)).toEqual(['settings']);
  const dave = browser();
  expect((await dave('/session', 'POST', { session: 'abc' })).status).toBe(403);
  expect((await dave('/catalog/refresh', 'POST')).status).toBe(403);
});
