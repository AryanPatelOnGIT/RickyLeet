import { afterAll, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../adapters/leetcode.js', () => ({ fetchProfileSnapshot: vi.fn().mockRejectedValue(new Error('Network unavailable')) }));
const folder = mkdtempSync(join(tmpdir(), 'rickyleet-api-test-'));
process.env.DATABASE_PATH = join(folder, 'test.sqlite');
const store = await import('../db/index.js');
const { syncLeetCode, getSyncStatus } = await import('./api.js');
afterAll(() => { store.db.close(); if (!folder.startsWith(join(tmpdir(), 'rickyleet-api-test-'))) throw new Error('Unexpected test folder'); rmSync(folder, { recursive: true, force: true }); });

it('reports API failure without deleting saved submissions or crashing', async () => {
  store.setKV('settings', { ...store.getSettings(), username: 'alice' });
  store.saveSubmissions([{ id: 'import:two-sum', slug: 'two-sum', timestamp: Date.now(), status: 'accepted', attempts: 1, source: 'import' }]);
  const result = await syncLeetCode(true);
  expect(result.error).toContain('Network unavailable');
  expect(store.getVerifiedSolved()).toEqual(new Set(['two-sum']));
  expect(getSyncStatus().lastSync).toBeUndefined();
  expect(getSyncStatus().lastError).toContain('Network unavailable');
});
