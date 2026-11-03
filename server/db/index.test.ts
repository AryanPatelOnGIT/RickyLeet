import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Problem, Submission } from '../../shared/types.js';

const folder = mkdtempSync(join(tmpdir(), 'rickyleet-test-'));
process.env.DATABASE_PATH = join(folder, 'test.sqlite');
const store = await import('./index.js');
const { runAsOwner } = await import('../context.js');
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
  it('keeps one copy of a submission reported publicly and through a session', () => {
    runAsOwner('dedupe', () => {
      store.saveSubmissions([{ ...accepted, id: 'public:77' }, { ...accepted, id: 'session:77', attempts: 3, source: 'session' }, { ...accepted, id: 'public:77' }]);
      expect(store.getSubmissions().map(s => [s.id, s.attempts])).toEqual([['session:77', 3]]);
    });
  });
  it('keeps solved-list entries only for problems no real accept identifies', () => {
    runAsOwner('stand-ins', () => {
      store.saveSubmissions([{ ...accepted, id: 'solved:two-sum', source: 'session' }, { ...accepted, id: 'solved:array-next', slug: 'array-next', source: 'session' }]);
      store.saveSubmissions([{ ...accepted, id: 'feedback:1', source: 'feedback' }]);
      expect(store.getSubmissions().map(s => s.id).sort()).toEqual(['feedback:1', 'solved:array-next']);
      expect(store.getVerifiedSolved()).toEqual(new Set(['two-sum', 'array-next']));
    });
  });
  it('round-trips a visitor\'s data and leaves nothing behind', () => {
    const state = runAsOwner('visitor:a', () => {
      store.setKV('settings', { ...store.getSettings(), username: 'carol' });
      store.saveSubmissions([accepted]);
      store.skipRecommendation('carol', 'array-next');
      const saved = store.exportVisitorState();
      store.deleteVisitorState();
      expect(store.getSubmissions()).toEqual([]);
      return saved;
    });
    runAsOwner('visitor:b', () => {
      store.importVisitorState(JSON.parse(JSON.stringify(state)));
      expect(store.getSettings().username).toBe('carol');
      expect(store.getVerifiedSolved()).toEqual(new Set(['two-sum']));
      expect(store.getSkipped('carol').has('array-next')).toBe(true);
      store.deleteVisitorState();
    });
    expect(store.db.prepare("SELECT COUNT(*) AS n FROM kv WHERE key LIKE 'u:visitor:%'").get()).toEqual({ n: 0 });
  });
  it('preserves progress after reopening SQLite', async () => {
    const before = store.getVerifiedSolved();
    store.db.close(); vi.resetModules();
    const reopened = await import('./index.js');
    expect(reopened.getVerifiedSolved()).toEqual(before);
    reopened.db.close();
  });
});
