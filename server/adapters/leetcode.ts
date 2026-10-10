import type { Problem, Profile, Submission } from '../../shared/types.js';

const endpoint = 'https://leetcode.com/graphql/';
let lastRequest = 0;
let queue = Promise.resolve();
let csrfToken = '';
async function prepareSession(session: string) {
  if (csrfToken) return;
  await throttle();
  const response = await fetch('https://leetcode.com/', { headers: { cookie: `LEETCODE_SESSION=${session}` }, signal: AbortSignal.timeout(20000) });
  const cookies = response.headers.getSetCookie?.() ?? [response.headers.get('set-cookie') ?? ''];
  csrfToken = cookies.map(c => /(?:^|;\s*)csrftoken=([^;]+)/.exec(c)?.[1]).find(Boolean) ?? '';
}
async function throttle() { const task = queue.then(async () => { const delay = Math.max(0, 1050 - (Date.now() - lastRequest)); if (delay) await new Promise(resolve => setTimeout(resolve, delay)); lastRequest = Date.now(); }); queue = task.catch(() => {}); await task; }
async function gql<T>(query: string, variables: Record<string, unknown> = {}, session?: string): Promise<T> {
  for (let attempt = 0; attempt < 4; attempt++) {
    await throttle();
    try {
      const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', 'referer': 'https://leetcode.com/', 'origin': 'https://leetcode.com', ...(session ? { cookie: `LEETCODE_SESSION=${session}${csrfToken ? `; csrftoken=${csrfToken}` : ''}`, ...(csrfToken ? { 'x-csrftoken': csrfToken } : {}) } : {}) }, body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(20000) });
      if (response.status === 429 || response.status >= 500) throw new Error(`LeetCode HTTP ${response.status}`);
      if (!response.ok) throw new Error(`LeetCode HTTP ${response.status}`);
      const payload = await response.json() as { data?: T; errors?: { message: string }[] };
      if (payload.errors?.length) throw new Error(payload.errors[0].message);
      if (!payload.data) throw new Error('LeetCode returned no data');
      return payload.data;
    } catch (error) {
      if (attempt === 3) throw error;
      await new Promise(resolve => setTimeout(resolve, 1000 * 2 ** attempt));
    }
  }
  throw new Error('LeetCode request failed');
}

type RawQuestion = { questionFrontendId: string; title: string; titleSlug: string; difficulty: string; acRate: number; topicTags?: { name: string }[]; paidOnly: boolean };
export async function fetchCatalog(onPage?: (problems: Problem[], total: number) => void): Promise<number> {
  const query = `query catalog($skip: Int!, $limit: Int!) { problemsetQuestionListV2(categorySlug: "", limit: $limit, skip: $skip, filters: {filterCombineType: ALL}) { questions { questionFrontendId title titleSlug difficulty acRate topicTags { name } paidOnly } } }`;
  let total = 0;
  for (let skip = 0; ; skip += 100) {
    const data = await gql<{ problemsetQuestionListV2: { questions: RawQuestion[] } }>(query, { skip, limit: 100 });
    const questions = data.problemsetQuestionListV2.questions ?? [];
    if (!questions.length) break;
    total += questions.length;
    onPage?.(questions.map(q => ({ id: q.questionFrontendId, title: q.title, slug: q.titleSlug, difficulty: ({ EASY: 'Easy', MEDIUM: 'Medium', HARD: 'Hard' } as const)[q.difficulty as 'EASY' | 'MEDIUM' | 'HARD'] ?? 'Medium', acceptance: Math.round((Number(q.acRate) || 0) * 1000) / 10, tags: (q.topicTags ?? []).map(t => t.name), paid: !!q.paidOnly, likes: 0, dislikes: 0 })), 0);
    if (questions.length < 100) break;
  }
  return total;
}

export async function fetchRatings(): Promise<Map<string, number>> {
  const response = await fetch('https://zerotrac.github.io/leetcode_problem_rating/data.json', { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`Rating dataset HTTP ${response.status}`);
  const rows = await response.json() as { TitleSlug?: string; Rating?: number | string }[];
  return new Map(rows.filter(r => r.TitleSlug && Number.isFinite(Number(r.Rating))).map(r => [r.TitleSlug!, Number(r.Rating)]));
}

export async function fetchVotes(slugs: string[], onBatch: (items: { slug: string; likes: number; dislikes: number }[]) => void) {
  for (let offset = 0; offset < slugs.length; offset += 40) {
    const batch = slugs.slice(offset, offset + 40).filter(s => /^[a-z0-9-]+$/.test(s));
    const fields = batch.map((slug, i) => `q${i}: question(titleSlug: ${JSON.stringify(slug)}) { likes dislikes }`).join(' ');
    try {
      const data = await gql<Record<string, { likes?: number; dislikes?: number } | null>>(`query votes { ${fields} }`);
      onBatch(batch.map((slug, i) => ({ slug, likes: data[`q${i}`]?.likes ?? 0, dislikes: data[`q${i}`]?.dislikes ?? 0 })));
    } catch { /* Leave neutral vote counts for this batch; cached catalog stays usable. */ }
  }
}

export async function fetchProfile(username: string): Promise<Profile> {
  const query = `query profile($username: String!) { matchedUser(username: $username) { username profile { ranking } submitStatsGlobal { acSubmissionNum { difficulty count } } tagProblemCounts { advanced { tagName problemsSolved } intermediate { tagName problemsSolved } fundamental { tagName problemsSolved } } } userContestRanking(username: $username) { rating } recentAcSubmissionList(username: $username, limit: 20) { id titleSlug timestamp } }`;
  const data = await gql<{ matchedUser: { username: string; profile?: { ranking?: number }; submitStatsGlobal?: { acSubmissionNum?: { difficulty: string; count: number }[] }; tagProblemCounts?: Record<string, { tagName: string; problemsSolved: number }[]> }; userContestRanking?: { rating?: number }; recentAcSubmissionList?: { id: string; titleSlug: string; timestamp: string }[] }>(query, { username });
  if (!data.matchedUser) throw new Error('LeetCode username not found');
  const solved = { Easy: 0, Medium: 0, Hard: 0 };
  for (const item of data.matchedUser.submitStatsGlobal?.acSubmissionNum ?? []) if (item.difficulty in solved) solved[item.difficulty as keyof typeof solved] = item.count;
  const tagStats: Record<string, number> = {};
  for (const group of Object.values(data.matchedUser.tagProblemCounts ?? {})) for (const item of group) tagStats[item.tagName] = item.problemsSolved;
  return { username, ranking: data.matchedUser.profile?.ranking, contestRating: data.userContestRanking?.rating, solved, tagStats, lastSync: Date.now() };
}

export async function fetchRecent(username: string): Promise<Submission[]> {
  const data = await gql<{ recentAcSubmissionList?: { id: string; titleSlug: string; timestamp: string }[] }>(`query recent($username: String!) { recentAcSubmissionList(username: $username, limit: 20) { id titleSlug timestamp } }`, { username });
  return (data.recentAcSubmissionList ?? []).map(s => ({ id: `public:${s.id}`, slug: s.titleSlug, timestamp: Number(s.timestamp) * 1000, status: 'accepted', attempts: 1, source: 'public' }));
}

export async function fetchFullHistory(session: string, knownIds = new Set<string>(), maxPages = 40): Promise<Submission[]> {
  await prepareSession(session);
  const query = `query history($offset: Int!, $limit: Int!) { submissionList(offset: $offset, limit: $limit) { hasNext submissions { id titleSlug statusDisplay timestamp runtime } } }`;
  const all: Submission[] = [];
  for (let page = 0; page < maxPages; page++) {
    const data = await gql<{ submissionList: { hasNext: boolean; submissions: { id: string; titleSlug: string; statusDisplay: string; timestamp: string; runtime?: string }[] } }>(query, { offset: page * 100, limit: 100 }, session);
    const list = data.submissionList?.submissions ?? [];
    all.push(...list.map(s => ({ id: `session:${s.id}`, slug: s.titleSlug, timestamp: Number(s.timestamp) * 1000, status: s.statusDisplay === 'Accepted' ? 'accepted' as const : 'failed' as const, attempts: 1, runtime: s.runtime, source: 'session' as const })));
    if (list.some(s => knownIds.has(`session:${s.id}`))) break;
    if (!data.submissionList?.hasNext || !list.length) break;
  }
  const failed = new Map<string, number>();
  for (const item of [...all].sort((a, b) => a.timestamp - b.timestamp)) {
    if (item.status === 'accepted') { item.attempts = (failed.get(item.slug) ?? 0) + 1; failed.set(item.slug, 0); }
    else failed.set(item.slug, (failed.get(item.slug) ?? 0) + 1);
  }
  return all;
}
