import { describe, expect, it } from 'vitest';
import { buildModel, decayWeight, eloUpdate, expected, qualityScore, recommend, targetFit } from './capabilityEngine.js';
import type { Problem, Profile, Settings, Submission } from '../../shared/types.js';
const problem: Problem = { id: '1', title: 'Two Sum', slug: 'two-sum', difficulty: 'Easy', acceptance: 55, tags: ['Array'], paid: false, likes: 100, dislikes: 10 };
const profile: Profile = { username: 'test', solved: { Easy: 0, Medium: 0, Hard: 0 }, tagStats: {} };
const settings: Settings = { username: 'test', useContestRatings: false, halfLifeDays: 90, weights: { targetFit: 4, weakness: 2, exploration: 1, quality: 1, diversity: 1, fatigue: 1 }, planSize: 4, hasSession: false };
describe('capability engine', () => {
  it('uses Elo outcomes', () => { expect(expected(1500, 1500)).toBe(0.5); expect(eloUpdate(1500, 1500, 1, 32)).toBe(1516); expect(eloUpdate(1500, 1500, 0, 32)).toBe(1484); });
  it('halves old evidence at the half life', () => expect(decayWeight(90, 90)).toBeCloseTo(0.5));
  it('prefers the stretch zone and sane quality', () => { expect(targetFit(0.65)).toBeGreaterThan(targetFit(0.2)); expect(qualityScore(problem)).toBeGreaterThan(0.7); });
  it('replays accepted and failed submissions chronologically', () => { const now = Date.now(); const failed: Submission = { id: 'f', slug: 'two-sum', timestamp: now - 2000, status: 'failed', attempts: 1, source: 'feedback' }; const accepted: Submission = { ...failed, id: 'a', timestamp: now - 1000, status: 'accepted' }; const base = buildModel([problem], [], profile, settings, now); const after = buildModel([problem], [failed, accepted], profile, settings, now); expect(after.skills.find(s => s.tag === 'Array')!.attempts).toBe(2); expect(after.overall).not.toBe(base.overall); });
  it('does not recommend recently solved problems', () => { const now = Date.now(); const s: Submission = { id: 'a', slug: 'two-sum', timestamp: now, status: 'accepted', attempts: 1, source: 'feedback' }; const model = buildModel([problem], [s], profile, settings, now); expect(recommend([problem], [s], model, settings, {}, now)).toHaveLength(0); });
  it('advances review spacing after a completed review', () => { const now = Date.now(); const day = 86400000; const first: Submission = { id: 'a', slug: 'two-sum', timestamp: now - 5 * day, status: 'accepted', attempts: 2, source: 'feedback' }; const reviewed = { ...first, id: 'b', timestamp: now - 2 * day, attempts: 1 }; const model = buildModel([problem], [first, reviewed], profile, settings, now); expect(recommend([problem], [first, reviewed], model, settings, {}, now)).toHaveLength(0); expect(recommend([problem], [first, reviewed], model, settings, {}, now + day)).toHaveLength(1); });
});
