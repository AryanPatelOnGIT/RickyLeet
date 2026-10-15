import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Problem, Submission } from '../../shared/types.js';

const folder = mkdtempSync(join(tmpdir(), 'rickyleet-test-'));
process.env.DATABASE_PATH = join(folder, 'test.sqlite');
const store = await import('./index.js');
const sample: Problem = { id: '1', slug: 'two-sum', title: 'Two Sum', difficulty: 'Easy', acceptance: 55, tags: ['Array'], paid: false, likes: 100, dislikes: 5 };
const accepted: Submission = { id: 'public:1', slug: sample.slug, timestamp: 1_700_000_000_000, status: 'accepted', attempts: 1, source: 'public' };

describe('SQLite progress', () => {
  beforeAll(() => {
    store.saveProblems([sample, { ...sample, slug: 'two-sum-alias' }, { ...sample, id: '2', slug: 'array-next' }]);
    store.setKV('settings', { ...store.getSettings(), username: 'alice' });
  });
  afterAll(() => { if (store.db.open) store.db.close(); if (!folder.startsWith(join(tmpdir(), 'rickyleet-test-'))) throw new Error('Unexpected test folder'); rmSync(folder, { recursive: true, force: true }); });

  it('deduplicates accepted submissions and excludes every slug for the stable ID', () => {
    expect(store.saveSubmissions([accepted, accepted])).toBe(1);
    expect(store.getVerifiedSolved().size).toBe(1);
    expect(store.getUnsolvedProblems().map(p => p.slug)).toEqual(['array-next']);
  });
  it('preserves prior solves when a sync only returns a partial page', () => {
    store.saveSubmissions([{ ...accepted, id: 'public:2', slug: 'array-next' }]);
    store.saveSubmissions([]);
    expect(store.getVerifiedSolved()).toEqual(new Set(['two-sum', 'array-next']));
  });
  it('isolates accounts and restores their saved history', () => {
    const alice = store.getSettings();
    store.switchAccount(alice, { ...alice, username: 'bob' });
    expect(store.getVerifiedSolved().size).toBe(0);
    store.saveSubmissions([{ ...accepted, id: 'bob:1', slug: 'array-next' }]);
    const bob = store.getSettings();
    store.switchAccount(bob, alice);
    expect(store.getVerifiedSolved()).toEqual(new Set(['two-sum', 'array-next']));
    store.switchAccount(alice, bob);
    expect(store.getVerifiedSolved()).toEqual(new Set(['array-next']));
  });
  it('keeps skip and recommendation history separate by account', () => {
    store.skipRecommendation('bob', 'two-sum');
    store.recordRecommendations('bob', ['array-next']);
    expect(store.getSkipped('alice').size).toBe(0);
    expect(store.getSkipped('bob').has('two-sum')).toBe(true);
    expect(store.getRecommendationHistory('bob').has('array-next')).toBe(true);
  });
  it('preserves progress after reopening SQLite', async () => {
    const before = store.getVerifiedSolved();
    store.db.close(); vi.resetModules();
    const reopened = await import('./index.js');
    expect(reopened.getVerifiedSolved()).toEqual(before);
    reopened.db.close();
  });
});
