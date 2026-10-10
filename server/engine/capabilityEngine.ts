import type { Model, Problem, Profile, Recommendation, SearchFilters, Settings, Skill, Submission } from '../../shared/types.js';

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
export const problemRating = (p: Problem, useContestRatings = true) => useContestRatings && p.rating ? p.rating : ({ Easy: 1250, Medium: 1550, Hard: 1900 })[p.difficulty] + clamp((55 - p.acceptance) * 3, -100, 100);
export const expected = (skill: number, difficulty: number) => 1 / (1 + 10 ** ((difficulty - skill) / 400));
export const decayWeight = (ageDays: number, halfLifeDays: number) => 2 ** (-Math.max(0, ageDays) / Math.max(1, halfLifeDays));
export const outcomeFor = (s: Submission) => s.status === 'accepted' ? s.hints || (s.minutes ?? 0) > 120 ? 0.4 : s.attempts <= 1 ? 1 : Math.max(0.5, 0.8 - (s.attempts - 1) * 0.1) : 0;
export const eloUpdate = (rating: number, difficulty: number, outcome: number, k: number) => rating + k * (outcome - expected(rating, difficulty));

const coreTags = ['Array', 'Dynamic Programming', 'Graph Theory', 'Tree', 'Binary Search', 'Sliding Window', 'Backtracking', 'Heap (Priority Queue)', 'Greedy', 'Math', 'String', 'Hash Table', 'Two Pointers'];
export function buildModel(problems: Problem[], submissions: Submission[], profile: Profile, settings: Settings, now = Date.now()): Model {
  const bySlug = new Map(problems.map(p => [p.slug, p]));
  const allTags = new Set([...coreTags, ...problems.flatMap(p => p.tags)]);
  const count = profile.solved.Easy + profile.solved.Medium + profile.solved.Hard;
  const base = clamp((profile.contestRating ?? 1400) * (profile.contestRating ? 0.65 : 1) + (profile.contestRating ? 490 : 0) + Math.min(160, Math.log1p(count) * 20) + profile.solved.Hard * 0.8, 1050, 2400);
  const state = new Map<string, { rating: number; attempts: number; failures: number; evidence: number }>();
  for (const tag of allTags) {
    const solved = profile.tagStats[tag] ?? 0;
    state.set(tag, { rating: base + Math.min(85, Math.log1p(solved) * 22), attempts: 0, failures: 0, evidence: solved * 0.35 });
  }
  let overall = base;
  const history: Model['history'] = [];
  const activity = new Map<string, number>();
  const ordered = [...submissions].sort((a, b) => a.timestamp - b.timestamp);
  const failedSinceAccepted = new Map<string, number>();
  for (const s of ordered) {
    const p = bySlug.get(s.slug);
    if (!p) continue;
    const age = Math.max(0, (now - s.timestamp) / 86400000);
    const weight = decayWeight(age, settings.halfLifeDays);
    const attempts = s.status === 'accepted' ? Math.max(s.attempts, 1 + (failedSinceAccepted.get(s.slug) ?? 0)) : s.attempts;
    const outcome = outcomeFor({ ...s, attempts });
    if (s.status === 'accepted') failedSinceAccepted.set(s.slug, 0); else failedSinceAccepted.set(s.slug, (failedSinceAccepted.get(s.slug) ?? 0) + 1);
    const difficulty = problemRating(p, settings.useContestRatings);
    const k = 38 * weight;
    overall = eloUpdate(overall, difficulty, outcome, k * 0.4);
    for (const tag of p.tags) {
      const item = state.get(tag) ?? { rating: base, attempts: 0, failures: 0, evidence: 0 };
      item.rating = eloUpdate(item.rating, difficulty, outcome, k / Math.sqrt(Math.max(1, p.tags.length / 2)));
      item.attempts++;
      item.failures += s.status !== 'accepted' ? 1 : 0;
      item.evidence += weight;
      state.set(tag, item);
    }
    if (s.status === 'accepted') { const date = new Date(s.timestamp).toISOString().slice(0, 10); activity.set(date, (activity.get(date) ?? 0) + 1); }
    history.push({ date: new Date(s.timestamp).toISOString().slice(0, 10), rating: Math.round(overall) });
  }
  const skills: Skill[] = [...state].map(([tag, item]) => ({ tag, rating: Math.round(item.rating), confidence: clamp(1 - Math.exp(-item.evidence / 12), 0, 0.98), attempts: item.attempts, failures: item.failures, weak: item.rating < overall - 90 || (item.attempts >= 3 && item.failures / item.attempts > 0.45) })).sort((a, b) => b.attempts + (profile.tagStats[b.tag] ?? 0) - a.attempts - (profile.tagStats[a.tag] ?? 0));
  return { overall: Math.round(overall), skills, history: history.filter((_, i) => i % Math.max(1, Math.floor(history.length / 120)) === 0), activity: [...activity].map(([date, count]) => ({ date, count })), weakTags: skills.filter(s => s.weak).map(s => s.tag), strongTags: [...skills].sort((a, b) => b.rating - a.rating).slice(0, 4).map(s => s.tag), updatedAt: now };
}

export function targetFit(probability: number) { return clamp(1 - Math.abs(probability - 0.65) / 0.65, 0, 1); }
export function qualityScore(p: Problem) { const likes = p.likes + p.dislikes; const ratio = likes ? (p.likes + 10) / (likes + 20) : 0.55; return clamp(ratio * 0.75 + (p.acceptance >= 5 && p.acceptance <= 90 ? 0.25 : 0), 0, 1); }
const reviewIntervals = [1, 3, 7, 21, 60];
function reviewDue(events: Submission[], now: number, weak: boolean) { const accepted = events.filter(s => s.status === 'accepted'); const last = accepted.at(-1); if (!last) return false; const age = (now - last.timestamp) / 86400000; const stage = Math.min(reviewIntervals.length - 1, accepted.length - 1); return age >= reviewIntervals[stage] && (weak || last.attempts > 1 || age >= 60 || accepted.length > 1); }
function groupFor(p: Problem, mode: SearchFilters['groupBy'], model: Model) { if (mode === 'difficulty') return p.difficulty; if (mode === 'topic') return p.tags[0] ?? 'Other'; if (mode === 'pattern') return p.tags.find(t => ['Two Pointers', 'Sliding Window', 'Binary Search', 'Backtracking', 'Depth-First Search', 'Breadth-First Search', 'Greedy'].includes(t)) ?? p.tags[0] ?? 'Other'; if (mode === 'skill') { const value = Math.min(...p.tags.map(t => model.skills.find(s => s.tag === t)?.rating ?? model.overall)); return value < model.overall - 90 ? 'Growth area' : value > model.overall + 90 ? 'Strength' : 'On level'; } return undefined; }
export function recommend(problems: Problem[], submissions: Submission[], model: Model, settings: Settings, filters: SearchFilters = {}, now = Date.now(), limit = 80): Recommendation[] {
  const status = new Map<string, Submission[]>();
  for (const s of submissions) { const list = status.get(s.slug) ?? []; list.push(s); status.set(s.slug, list); }
  const skill = new Map(model.skills.map(s => [s.tag, s]));
  const recentTags = new Map<string, number>();
  for (const s of submissions.filter(s => now - s.timestamp < 7 * 86400000)) for (const tag of problems.find(p => p.slug === s.slug)?.tags ?? []) recentTags.set(tag, (recentTags.get(tag) ?? 0) + 1);
  const query = (filters.query ?? '').toLowerCase().trim();
  const candidates: Recommendation[] = [];
  for (const p of problems) {
    const events = status.get(p.slug) ?? [];
    const lastAccepted = [...events].reverse().find(s => s.status === 'accepted');
    const solved = events.some(s => s.status === 'accepted');
    const state = solved ? 'solved' : events.some(s => s.status === 'attempted' || s.status === 'failed') ? 'attempted' : events.some(s => s.source === 'feedback') ? 'skipped' : 'unsolved';
    const weak = p.tags.some(t => skill.get(t)?.weak);
    const review = solved && reviewDue(events, now, weak);
    if (solved && !review && filters.status !== 'solved') continue;
    if (filters.status && filters.status !== 'all' && (filters.status === 'never-seen' ? events.length > 0 : state !== filters.status)) continue;
    if (query && !`${p.title} ${p.id} ${p.tags.join(' ')}`.toLowerCase().includes(query)) continue;
    if (filters.difficulties?.length && !filters.difficulties.includes(p.difficulty)) continue;
    if (filters.tags?.length && !filters.tags.some(t => p.tags.includes(t))) continue;
    if (filters.companies?.length && !filters.companies.some(t => p.companyTags?.includes(t))) continue;
    if (filters.access === 'free' && p.paid || filters.access === 'paid' && !p.paid) continue;
    if (filters.minAcceptance !== undefined && p.acceptance < filters.minAcceptance || filters.maxAcceptance !== undefined && p.acceptance > filters.maxAcceptance) continue;
    const weakest = p.tags.map(t => skill.get(t)).filter((s): s is Skill => !!s).sort((a, b) => a.rating - b.rating)[0];
    const rating = p.tags.length ? p.tags.reduce((sum, tag) => sum + (skill.get(tag)?.rating ?? model.overall), 0) / p.tags.length : model.overall;
    const probability = expected(rating, problemRating(p, settings.useContestRatings));
    if (filters.minProbability !== undefined && probability < filters.minProbability || filters.maxProbability !== undefined && probability > filters.maxProbability) continue;
    const weakness = p.tags.length ? p.tags.reduce((n, t) => n + (skill.get(t)?.weak ? 1 : 0), 0) / p.tags.length : 0;
    const exploration = p.tags.length ? p.tags.reduce((n, t) => n + (1 - (skill.get(t)?.confidence ?? 0)), 0) / p.tags.length : 1;
    const fatigue = p.tags.length ? Math.min(1, p.tags.reduce((n, t) => n + (recentTags.get(t) ?? 0), 0) / (p.tags.length * 5)) : 0;
    const w = settings.weights;
    const score = w.targetFit * targetFit(probability) + w.weakness * weakness + w.exploration * exploration + w.quality * qualityScore(p) - w.fatigue * fatigue + (review ? 0.4 : 0);
    const gap = weakest ? Math.round(model.overall - weakest.rating) : 0;
    const position = Math.abs(gap) < 10 ? `${weakest?.tag} is near your overall rating.` : `${weakest?.tag} is ${Math.abs(gap)} points ${gap >= 0 ? 'below' : 'above'} your overall rating.`;
    const reason = review ? `Review due after ${Math.floor((now - lastAccepted!.timestamp) / 86400000)} days. ${weakest?.tag ?? 'This topic'} needs reinforcement.` : `Predicted solve chance ${Math.round(probability * 100)}%. ${weakest ? position : 'New topic to explore.'} ${Math.round(exploration * 100)}% exploration value.`;
    candidates.push({ problem: p, score, probability, estimatedMinutes: Math.round(({ Easy: 20, Medium: 40, Hard: 65 })[p.difficulty] * (1.2 - probability * 0.4)), reason, review, status: state, group: groupFor(p, filters.groupBy, model) });
  }
  if (filters.sort === 'difficulty') candidates.sort((a, b) => problemRating(a.problem, settings.useContestRatings) - problemRating(b.problem, settings.useContestRatings));
  else if (filters.sort === 'acceptance') candidates.sort((a, b) => b.problem.acceptance - a.problem.acceptance);
  else if (filters.sort === 'likes') candidates.sort((a, b) => b.problem.likes - a.problem.likes);
  else if (filters.sort === 'newest') candidates.sort((a, b) => Number(b.problem.id) - Number(a.problem.id));
  else candidates.sort((a, b) => b.score - a.score);
  if (filters.sort && filters.sort !== 'best') return candidates.slice(0, limit);
  const result: Recommendation[] = [];
  const used = new Map<string, number>();
  while (candidates.length && result.length < limit) {
    let best = 0, bestScore = -Infinity;
    for (let i = 0; i < Math.min(candidates.length, 250); i++) {
      const c = candidates[i];
      const diversity = c.problem.tags.length ? c.problem.tags.reduce((n, t) => n + 1 / (1 + (used.get(t) ?? 0)), 0) / c.problem.tags.length : 1;
      const value = c.score + settings.weights.diversity * diversity;
      if (value > bestScore) { best = i; bestScore = value; }
    }
    const [picked] = candidates.splice(best, 1); picked.score = bestScore; result.push(picked);
    for (const tag of picked.problem.tags) used.set(tag, (used.get(tag) ?? 0) + 1);
  }
  return result;
}
