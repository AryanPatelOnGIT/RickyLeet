import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { request, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

vi.mock('./adapters/leetcode.js', () => ({ fetchProfileSnapshot: vi.fn().mockRejectedValue(new Error('offline')) }));
const folder = mkdtempSync(join(tmpdir(), 'rickyleet-local-test-'));
process.env.DATABASE_PATH = join(folder, 'test.sqlite');
process.env.MULTI_USER = 'false';
const store = await import('./db/index.js');
store.saveProblems([{ id: '1', slug: 'two-sum', title: 'Two Sum', difficulty: 'Easy', acceptance: 55, tags: ['Array'], paid: false, likes: 1, dislikes: 0 }]);
const { app } = await import('./app.js');
let server: Server;

beforeAll(async () => { server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve)); });
afterAll(() => { server.close(); store.db.close(); if (!folder.startsWith(join(tmpdir(), 'rickyleet-local-test-'))) throw new Error('Unexpected test folder'); rmSync(folder, { recursive: true, force: true }); });

const get = (host: string) => new Promise<{ status: number; body: any }>((resolve, reject) => {
  request({ host: '127.0.0.1', port: (server.address() as AddressInfo).port, path: '/api/bootstrap', headers: { host } }, response => {
    let text = ''; response.on('data', chunk => text += chunk).on('end', () => resolve({ status: response.statusCode ?? 0, body: JSON.parse(text) }));
  }).on('error', reject).end();
});

it('serves the owner\'s single-user data only to this computer', async () => {
  store.setKV('settings', { ...store.getSettings(), username: 'owner' });
  const local = await get('localhost:5173');
  expect(local.status).toBe(200);
  expect(local.body.settings.username).toBe('owner');
  expect(local.body.hosted).toBe(false);
  const remote = await get('rickyleet.example.com');
  expect(remote.status).toBe(403);
  expect(JSON.stringify(remote.body)).not.toContain('owner');
});
