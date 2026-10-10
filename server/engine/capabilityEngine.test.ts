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
  it('follows demonstrated Easy Array history despite a high contest rating', () => {
    const now = Date.now(), day = 86400000;
    const catalog: Problem[] = [problem,
      { ...problem, id: '2', slug: 'array-hash-next', title: 'Array Hash Next', tags: ['Array', 'Hash Table'] },
      { ...problem, id: '3', slug: 'hard-graph', title: 'Hard Graph', difficulty: 'Hard', tags: ['Graph Theory'] },
    ];
    const history: Submission[] = [0, 1, 2, 3].map(i => ({ id: `solve-${i}`, slug: 'two-sum', timestamp: now - (i + 1) * day, status: 'accepted', attempts: 1, source: 'public' }));
    const highRating: Profile = { ...profile, contestRating: 3000, solved: { Easy: 20, Medium: 0, Hard: 0 }, tagStats: { Array: 10 } };
    const model = buildModel(catalog, history, highRating, settings, now);
    const ranked = recommend(catalog, history, model, settings, {}, now);
    expect(ranked[0].problem.slug).toBe('array-hash-next');
    expect(ranked[0].probability).toBeGreaterThan(0.45);
  });
  it('advances consistent Medium DP history through relevant problems', () => {
    const now = Date.now(), day = 86400000;
    const solved: Problem[] = Array.from({ length: 4 }, (_, i) => ({ ...problem, id: `dp-${i}`, slug: `dp-solved-${i}`, title: `DP solved ${i}`, difficulty: 'Medium', tags: ['Dynamic Programming'] }));
    const candidates: Problem[] = [
      { ...problem, id: '10', slug: 'easy-dp', title: 'Easy DP', difficulty: 'Easy', tags: ['Dynamic Programming'] },
      { ...problem, id: '11', slug: 'medium-dp-next', title: 'Medium DP Next', difficulty: 'Medium', tags: ['Dynamic Programming'] },
      { ...problem, id: '12', slug: 'hard-dp-stretch', title: 'Hard DP Stretch', difficulty: 'Hard', tags: ['Dynamic Programming'] },
      { ...problem, id: '13', slug: 'unrelated-medium', title: 'Unrelated Medium', difficulty: 'Medium', tags: ['Shell'] },
    ];
    const catalog = [...solved, ...candidates];
    const submissions: Submission[] = solved.map((p, i) => ({ id: `dp-solve-${i}`, slug: p.slug, timestamp: now - (i + 1) * day, status: 'accepted', attempts: 1, source: 'public' }));
    const p: Profile = { ...profile, solved: { Easy: 0, Medium: 8, Hard: 0 }, tagStats: { 'Dynamic Programming': 8 } };
    const model = buildModel(catalog, submissions, p, settings, now);
    const ranked = recommend(catalog, submissions, model, settings, {}, now);
    expect(ranked[0].problem.slug).toBe('medium-dp-next');
    expect(ranked.some(r => r.problem.slug === 'hard-dp-stretch')).toBe(true);
  });
  it('keeps top results stable when contest rating changes slightly', () => {
    const now = Date.now();
    const catalog: Problem[] = [problem,
      { ...problem, id: '2', slug: 'array-two', title: 'Array Two', tags: ['Array', 'Hash Table'] },
      { ...problem, id: '3', slug: 'array-three', title: 'Array Three', tags: ['Array', 'Two Pointers'] },
      { ...problem, id: '4', slug: 'graph-four', title: 'Graph Four', tags: ['Graph Theory'] },
    ];
    const firstProfile: Profile = { ...profile, contestRating: 1800, solved: { Easy: 4, Medium: 0, Hard: 0 }, tagStats: { Array: 4 } };
    const submissions: Submission[] = [{ id: 'solved', slug: problem.slug, timestamp: now - 86400000, status: 'accepted', attempts: 1, source: 'public' }];
    const firstModel = buildModel(catalog, submissions, firstProfile, settings, now);
    const nextModel = buildModel(catalog, submissions, { ...firstProfile, contestRating: 1810 }, settings, now);
    const first = recommend(catalog, submissions, firstModel, settings, {}, now).slice(0, 3).map(r => r.problem.slug);
    const next = recommend(catalog, submissions, nextModel, settings, {}, now).slice(0, 3).map(r => r.problem.slug);
    expect(next.filter(slug => first.includes(slug)).length).toBeGreaterThanOrEqual(2);
  });
  it('reflects a new solve in the next search and excludes it', () => {
    const now = Date.now();
    const catalog: Problem[] = [problem,
      { ...problem, id: '2', slug: 'array-next', title: 'Array Next', tags: ['Array', 'Hash Table'] },
      { ...problem, id: '3', slug: 'medium-array', title: 'Medium Array', difficulty: 'Medium', tags: ['Array'] },
    ];
    const beforeModel = buildModel(catalog, [], profile, settings, now);
    const before = recommend(catalog, [], beforeModel, settings, {}, now);
    const newSolve: Submission = { id: 'new-solve', slug: 'two-sum', timestamp: now, status: 'accepted', attempts: 1, source: 'public' };
    const afterModel = buildModel(catalog, [newSolve], { ...profile, solved: { Easy: 1, Medium: 0, Hard: 0 }, tagStats: { Array: 1 } }, settings, now);
    const after = recommend(catalog, [newSolve], afterModel, settings, {}, now);
    expect(before.some(r => r.problem.slug === 'two-sum')).toBe(true);
    expect(after.some(r => r.problem.slug === 'two-sum')).toBe(false);
    expect(after.find(r => r.problem.slug === 'array-next')?.reason).toContain('Two Sum');
  });
  it('uses beginner-friendly defaults without history', () => {
    const catalog: Problem[] = [problem,
      { ...problem, id: '2', slug: 'medium', title: 'Medium', difficulty: 'Medium', tags: ['Dynamic Programming'] },
      { ...problem, id: '3', slug: 'hard', title: 'Hard', difficulty: 'Hard', tags: ['Graph Theory'] },
    ];
    const highRating: Profile = { ...profile, contestRating: 2800 };
    const model = buildModel(catalog, [], highRating, settings);
    const ranked = recommend(catalog, [], model, settings);
    expect(ranked[0].problem.difficulty).toBe('Easy');
    expect(ranked[0].probability).toBeGreaterThan(ranked.find(r => r.problem.difficulty === 'Medium')!.probability);
  });
});
