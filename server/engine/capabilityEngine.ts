import type { Model, Problem, Profile, Recommendation, SearchFilters, Settings, Skill, Submission } from '../../shared/types.js';

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const DAY = 86400000;
const defaultAbility = 1325;
export const problemRating = (p: Problem, useContestRatings = true) => useContestRatings && p.rating ? p.rating : ({ Easy: 1250, Medium: 1550, Hard: 1900 })[p.difficulty] + clamp((55 - p.acceptance) * 3, -100, 100);
export const expected = (skill: number, difficulty: number) => 1 / (1 + 10 ** ((difficulty - skill) / 400));
export const decayWeight = (ageDays: number, halfLifeDays: number) => 2 ** (-Math.max(0, ageDays) / Math.max(1, halfLifeDays));
export const outcomeFor = (s: Submission) => s.status === 'accepted' ? s.hints || (s.minutes ?? 0) > 120 ? 0.4 : s.attempts <= 1 ? 1 : Math.max(0.5, 0.8 - (s.attempts - 1) * 0.1) : 0;
export const eloUpdate = (rating: number, difficulty: number, outcome: number, k: number) => rating + k * (outcome - expected(rating, difficulty));

const coreTags = ['Array', 'Dynamic Programming', 'Graph Theory', 'Tree', 'Binary Search', 'Sliding Window', 'Backtracking', 'Heap (Priority Queue)', 'Greedy', 'Math', 'String', 'Hash Table', 'Two Pointers'];

function demonstratedBaseline(profile: Profile) {
  const counts = profile.solved;
  const total = counts.Easy + counts.Medium + counts.Hard;
  const observed = total ? (counts.Easy * 1250 + counts.Medium * 1550 + counts.Hard * 1900) / total : defaultAbility;
  // Contest rating can nudge a history-based baseline, but is deliberately capped and discounted.
  const contestNudge = profile.contestRating ? clamp((profile.contestRating - 1500) * 0.1, -75, 100) : 0;
  return clamp(observed + contestNudge + Math.min(55, Math.log1p(total) * 8), 1100, 1950);
}

export function buildModel(problems: Problem[], submissions: Submission[], profile: Profile, settings: Settings, now = Date.now()): Model {
  const bySlug = new Map(problems.map(p => [p.slug, p]));
  const allTags = new Set([...coreTags, ...problems.flatMap(p => p.tags)]);
  const base = demonstratedBaseline(profile);
  const state = new Map<string, { rating: number; attempts: number; failures: number; evidence: number }>();
  for (const tag of allTags) {
    const solved = profile.tagStats[tag] ?? 0;
    // Per-topic counts initialize that topic. Contest rating is not allowed to fill every unknown topic.
    const rating = solved > 0 ? clamp(base + Math.min(70, Math.log1p(solved) * 18), 1100, 1950) : defaultAbility;
    state.set(tag, { rating, attempts: 0, failures: 0, evidence: solved * 0.45 });
  }
  let overall = base;
  const history: Model['history'] = [];
  const activity = new Map<string, number>();
  const ordered = [...submissions].sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id));
  const failedSinceAccepted = new Map<string, number>();
  for (const s of ordered) {
    const p = bySlug.get(s.slug);
    if (!p) continue;
    const age = Math.max(0, (now - s.timestamp) / DAY);
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
  const skills: Skill[] = [...state].map(([tag, item]) => ({ tag, rating: Math.round(item.rating), confidence: clamp(1 - Math.exp(-item.evidence / 12), 0, 0.98), attempts: item.attempts, failures: item.failures, weak: (item.evidence > 0 && item.rating < overall - 90) || (item.attempts >= 3 && item.failures / item.attempts > 0.45) })).sort((a, b) => b.attempts + (profile.tagStats[b.tag] ?? 0) - a.attempts - (profile.tagStats[a.tag] ?? 0) || a.tag.localeCompare(b.tag));
  return { overall: Math.round(overall), skills, history: history.filter((_, i) => i % Math.max(1, Math.floor(history.length / 120)) === 0), activity: [...activity].map(([date, count]) => ({ date, count })), weakTags: skills.filter(s => s.weak).map(s => s.tag), strongTags: [...skills].sort((a, b) => b.rating - a.rating || a.tag.localeCompare(b.tag)).slice(0, 4).map(s => s.tag), updatedAt: now };
}

export function targetFit(probability: number) { return clamp(1 - Math.abs(probability - 0.65) / 0.65, 0, 1); }
export function qualityScore(p: Problem) { const likes = p.likes + p.dislikes; const ratio = likes ? (p.likes + 10) / (likes + 20) : 0.55; return clamp(ratio * 0.75 + (p.acceptance >= 5 && p.acceptance <= 90 ? 0.25 : 0), 0, 1); }
const reviewIntervals = [1, 3, 7, 21, 60];
function reviewDue(events: Submission[], now: number, weak: boolean) { const accepted = events.filter(s => s.status === 'accepted'); const last = accepted.at(-1); if (!last) return false; const age = (now - last.timestamp) / DAY; const stage = Math.min(reviewIntervals.length - 1, accepted.length - 1); return age >= reviewIntervals[stage] && (weak || last.attempts > 1 || age >= 60 || accepted.length > 1); }
function groupFor(p: Problem, mode: SearchFilters['groupBy'], model: Model) { if (mode === 'difficulty') return p.difficulty; if (mode === 'topic') return p.tags[0] ?? 'Other'; if (mode === 'pattern') return p.tags.find(t => ['Two Pointers', 'Sliding Window', 'Binary Search', 'Backtracking', 'Depth-First Search', 'Breadth-First Search', 'Greedy'].includes(t)) ?? p.tags[0] ?? 'Other'; if (mode === 'skill') { const value = Math.min(...p.tags.map(t => model.skills.find(s => s.tag === t)?.rating ?? defaultAbility)); return value < model.overall - 90 ? 'Growth area' : value > model.overall + 90 ? 'Strength' : 'On level'; } return undefined; }

type SolvedExample = { problem: Problem; timestamp: number; rating: number };
type HistoryProfile = { solved: SolvedExample[]; topic: Map<string, SolvedExample[]>; topicCounts: Map<string, number>; pairCounts: Map<string, number>; difficultyMean: number };
const pairKey = (a: string, b: string) => [a, b].sort().join('::');
function makeHistoryProfile(problems: Problem[], submissions: Submission[], now: number, useContestRatings: boolean): HistoryProfile {
  const bySlug = new Map(problems.map(p => [p.slug, p]));
  const accepted = new Map<string, Submission>();
  for (const s of submissions) if (s.status === 'accepted') {
    const prior = accepted.get(s.slug);
    if (!prior || s.timestamp > prior.timestamp) accepted.set(s.slug, s);
  }
  const solved: SolvedExample[] = [...accepted.values()].flatMap(s => { const problem = bySlug.get(s.slug); return problem ? [{ problem, timestamp: s.timestamp, rating: problemRating(problem, useContestRatings) }] : []; }).sort((a, b) => a.timestamp - b.timestamp || a.problem.slug.localeCompare(b.problem.slug));
  const topic = new Map<string, SolvedExample[]>(), topicCounts = new Map<string, number>(), pairCounts = new Map<string, number>();
  let ratingTotal = 0, ratingWeight = 0;
  for (const example of solved) {
    const recency = decayWeight((now - example.timestamp) / DAY, 180);
    ratingTotal += example.rating * recency; ratingWeight += recency;
    for (const tag of example.problem.tags) { const list = topic.get(tag) ?? []; list.push(example); topic.set(tag, list); topicCounts.set(tag, (topicCounts.get(tag) ?? 0) + 1); }
    for (let i = 0; i < example.problem.tags.length; i++) for (let j = i + 1; j < example.problem.tags.length; j++) {
      const key = pairKey(example.problem.tags[i], example.problem.tags[j]); pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
    }
  }
  return { solved, topic, topicCounts, pairCounts, difficultyMean: ratingWeight ? ratingTotal / ratingWeight : defaultAbility };
}

function weightedTopicLevel(tag: string, history: HistoryProfile, settings: Settings, now: number): { rating: number; count: number } {
  const examples = history.topic.get(tag) ?? [];
  if (!examples.length) return { rating: defaultAbility, count: 0 };
  const recent = examples.slice(-12);
  let total = 0, weights = 0;
  for (const item of recent) { const w = decayWeight((now - item.timestamp) / DAY, settings.halfLifeDays); total += item.rating * w; weights += w; }
  return { rating: weights ? total / weights : history.difficultyMean, count: examples.length };
}

function topicFamiliarity(tags: string[], history: HistoryProfile): number {
  if (!history.solved.length || !tags.length) return 0;
  const freq = tags.reduce((n, tag) => n + Math.log1p(history.topicCounts.get(tag) ?? 0), 0) / tags.length;
  const scale = Math.log1p(Math.max(1, history.solved.length));
  return clamp(freq / scale, 0, 1);
}

function similarityToHistory(problem: Problem, history: HistoryProfile, now: number, useContestRatings: boolean): { score: number; example?: SolvedExample; sharedTags: string[] } {
  if (!history.solved.length || !problem.tags.length) return { score: 0, sharedTags: [] };
  let bestScore = 0, example: SolvedExample | undefined, sharedTags: string[] = [];
  const tagSet = new Set(problem.tags);
  // Compare only against solved problems sharing at least one catalog tag.
  const related = new Map<string, SolvedExample>();
  for (const tag of problem.tags) for (const item of history.topic.get(tag) ?? []) related.set(item.problem.slug, item);
  for (const solved of related.values()) {
    const shared = solved.problem.tags.filter(t => tagSet.has(t));
    if (!shared.length) continue;
    const union = new Set([...problem.tags, ...solved.problem.tags]).size;
    const jaccard = shared.length / Math.max(1, union);
    const combo = shared.length >= 2 ? shared.slice(0, -1).reduce((n, tag, i) => n + (history.pairCounts.get(pairKey(tag, shared[i + 1])) ? 1 : 0), 0) / (shared.length - 1) : 0;
    const recent = decayWeight((now - solved.timestamp) / DAY, 180);
    const diffDistance = Math.abs(problemRating(problem, useContestRatings) - solved.rating);
    const difficultyProximity = Math.exp(-diffDistance / 650);
    const score = (0.62 * jaccard + 0.18 * combo + 0.20 * difficultyProximity) * (0.82 + 0.18 * recent);
    if (score > bestScore || (score === bestScore && solved.problem.slug < (example?.problem.slug ?? '\uffff'))) { bestScore = score; example = solved; sharedTags = shared; }
  }
  return { score: bestScore, example, sharedTags };
}

function recommendationAbility(p: Problem, skill: Map<string, Skill>, history: HistoryProfile, settings: Settings, now: number): { ability: number; topicLevel: number; historyCount: number } {
  if (!p.tags.length) return { ability: defaultAbility, topicLevel: defaultAbility, historyCount: 0 };
  let abilityTotal = 0, levelTotal = 0, levelWeights = 0, countTotal = 0;
  for (const tag of p.tags) {
    const local = skill.get(tag);
    const topic = weightedTopicLevel(tag, history, settings, now);
    const evidence = Math.max(local?.confidence ?? 0, Math.min(0.9, topic.count / 8));
    const localRating = local ? local.rating * evidence + defaultAbility * (1 - evidence) : defaultAbility;
    // Topic-level solves dominate; Elo contributes with confidence, while a global rating is only a weak prior.
    const rating = topic.count ? localRating * 0.55 + topic.rating * 0.35 + history.difficultyMean * 0.10 : localRating * 0.75 + defaultAbility * 0.25;
    abilityTotal += rating;
    // An unfamiliar topic starts near beginner difficulty even when the user's other topics are advanced.
    const levelWeight = topic.count ? 0.45 : 0.1;
    levelTotal += (topic.count ? topic.rating : localRating) * levelWeight;
    levelWeights += levelWeight;
    countTotal += topic.count;
  }
  return { ability: abilityTotal / p.tags.length, topicLevel: levelTotal / levelWeights, historyCount: countTotal / p.tags.length };
}

export function recommend(problems: Problem[], submissions: Submission[], model: Model, settings: Settings, filters: SearchFilters = {}, now = Date.now(), limit = 80): Recommendation[] {
  const status = new Map<string, Submission[]>();
  for (const s of submissions) { const list = status.get(s.slug) ?? []; list.push(s); status.set(s.slug, list); }
  const skill = new Map(model.skills.map(s => [s.tag, s]));
  const history = makeHistoryProfile(problems, submissions, now, settings.useContestRatings);
  const recentTags = new Map<string, number>();
  const bySlug = new Map(problems.map(p => [p.slug, p]));
  for (const s of submissions) if (now - s.timestamp < 7 * DAY) for (const tag of bySlug.get(s.slug)?.tags ?? []) recentTags.set(tag, (recentTags.get(tag) ?? 0) + 1);
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

    const rating = problemRating(p, settings.useContestRatings);
    const fit = recommendationAbility(p, skill, history, settings, now);
    const probability = expected(fit.ability, rating);
    if (filters.minProbability !== undefined && probability < filters.minProbability || filters.maxProbability !== undefined && probability > filters.maxProbability) continue;

    const similarity = similarityToHistory(p, history, now, settings.useContestRatings);
    const familiarity = history.solved.length ? clamp(0.68 * similarity.score + 0.32 * topicFamiliarity(p.tags, history), 0, 1) : 0;
    // Select a gentle next step from the user's topic history. Unknown topics start at the introductory range.
    const gap = rating - fit.topicLevel;
    const progression = Math.exp(-Math.abs(gap - 75) / 420);
    const weakness = p.tags.length ? p.tags.reduce((n, t) => n + (skill.get(t)?.weak ? 1 : 0), 0) / p.tags.length : 0;
    const exploration = history.solved.length ? p.tags.length ? p.tags.reduce((n, t) => n + (1 - (skill.get(t)?.confidence ?? 0)), 0) / p.tags.length : 1 : 1;
    const fatigue = p.tags.length ? Math.min(1, p.tags.reduce((n, t) => n + (recentTags.get(t) ?? 0), 0) / (p.tags.length * 5)) : 0;
    const negativeFeedback = events.filter(s => s.source === 'feedback' && s.status !== 'accepted').reduce((max, s) => {
      const recency = decayWeight((now - s.timestamp) / DAY, 30);
      const unsuitable = s.minutes && s.minutes >= 120 ? 0.32 : s.status === 'failed' ? 0.18 : 0.08;
      return Math.max(max, unsuitable * recency);
    }, 0);
    const w = settings.weights;
    const targetWeight = clamp(w.targetFit / 4, 0, 2);
    const weaknessWeight = clamp(w.weakness / 2, 0, 2);
    const explorationWeight = clamp(w.exploration / 1.5, 0, 2);
    // Initial mix: 60% history/similarity, 25% progression, 10% weak areas, 5% exploration.
    const progressionScore = progression * 0.55 + targetFit(probability) * 0.45;
    const score = 0.60 * familiarity + 0.25 * progressionScore * targetWeight + 0.10 * weaknessWeight * weakness + 0.05 * explorationWeight * exploration
      + 0.08 * w.quality * qualityScore(p)
      - 0.10 * w.fatigue * fatigue - negativeFeedback + (review ? 0.4 : 0);
    const firstTag = p.tags.find(t => history.topic.has(t)) ?? p.tags[0];
    const topicName = firstTag ?? 'new topics';
    const reason = review
      ? `Review due after ${Math.floor((now - lastAccepted!.timestamp) / DAY)} days. ${firstTag ?? 'This topic'} needs reinforcement.`
      : history.solved.length && similarity.example
        ? `Similar to ${similarity.example.problem.title}; shares ${similarity.sharedTags.slice(0, 2).join(' and ')}. ${p.difficulty} difficulty fits your ${topicName} progression. Predicted solve chance ${Math.round(probability * 100)}%.`
        : history.solved.length && history.topic.has(topicName)
          ? `Matches your recent ${topicName} practice. ${p.difficulty} difficulty fits your demonstrated range; predicted solve chance ${Math.round(probability * 100)}%.`
          : history.solved.length
            ? `Introduces ${topicName} at an introductory level. Predicted solve chance ${Math.round(probability * 100)}%.`
            : `Beginner-friendly starting point. Predicted solve chance ${Math.round(probability * 100)}%.`;
    candidates.push({ problem: p, score, probability, estimatedMinutes: Math.round(({ Easy: 20, Medium: 40, Hard: 65 })[p.difficulty] * (1.2 - probability * 0.4)), reason, review, status: state, group: groupFor(p, filters.groupBy, model) });
  }
  const stableTie = (a: Recommendation, b: Recommendation) => a.problem.slug.localeCompare(b.problem.slug);
  if (filters.sort === 'difficulty') candidates.sort((a, b) => problemRating(a.problem, settings.useContestRatings) - problemRating(b.problem, settings.useContestRatings) || stableTie(a, b));
  else if (filters.sort === 'acceptance') candidates.sort((a, b) => b.problem.acceptance - a.problem.acceptance || stableTie(a, b));
  else if (filters.sort === 'likes') candidates.sort((a, b) => b.problem.likes - a.problem.likes || stableTie(a, b));
  else if (filters.sort === 'newest') candidates.sort((a, b) => Number(b.problem.id) - Number(a.problem.id) || stableTie(a, b));
  else candidates.sort((a, b) => b.score - a.score || stableTie(a, b));
  if (filters.sort && filters.sort !== 'best') return candidates.slice(0, limit);
  const result: Recommendation[] = [];
  const used = new Map<string, number>();
  while (candidates.length && result.length < limit) {
    let best = 0, bestScore = -Infinity;
    for (let i = 0; i < Math.min(candidates.length, 250); i++) {
      const c = candidates[i];
      const diversity = c.problem.tags.length ? c.problem.tags.reduce((n, t) => n + 1 / (1 + (used.get(t) ?? 0)), 0) / c.problem.tags.length : 1;
      const value = c.score + settings.weights.diversity * diversity;
      if (value > bestScore || (value === bestScore && stableTie(c, candidates[best]) < 0)) { best = i; bestScore = value; }
    }
    const [picked] = candidates.splice(best, 1); picked.score = bestScore; result.push(picked);
    for (const tag of picked.problem.tags) used.set(tag, (used.get(tag) ?? 0) + 1);
  }
  return result;
}
