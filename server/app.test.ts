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
const { runAsOwner } = await import('./context.js');
const { app } = await import('./app.js');
let server: Server, base = '';

beforeAll(async () => {
  runAsOwner('setup', () => store.saveProblems([{ id: '1', slug: 'two-sum', title: 'Two Sum', difficulty: 'Easy', acceptance: 55, tags: ['Array'], paid: false, likes: 1, dislikes: 0 }]));
  server = app.listen(0); await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});
afterAll(() => { server.close(); store.db.close(); if (!folder.startsWith(join(tmpdir(), 'rickyleet-app-test-'))) throw new Error('Unexpected test folder'); rmSync(folder, { recursive: true, force: true }); });

// A tiny cookie jar per simulated browser.
function browser() {
  let cookie = '';
  return async (path: string, method = 'GET', body?: unknown) => {
    const response = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    cookie = response.headers.get('set-cookie')?.split(';')[0] ?? cookie;
    return response.json();
  };
}

it('keeps each visitor\'s username and solves separate', async () => {
  const alice = browser(), bob = browser();
  await alice('/bootstrap');
  await bob('/bootstrap');
  expect((await alice('/settings', 'PUT', { username: 'alice' })).username).toBe('alice');
  await alice('/feedback', 'POST', { slug: 'two-sum', action: 'solved' });
  const aliceView = await alice('/bootstrap'), bobView = await bob('/bootstrap');
  expect(aliceView.settings.username).toBe('alice');
  expect(aliceView.syncStatus.verifiedSolved).toBe(1);
  expect(bobView.settings.username).toBe('');
  expect(bobView.syncStatus.verifiedSolved).toBe(0);
  expect(bobView.catalogCount).toBe(1);
});
