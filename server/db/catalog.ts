import type { Problem } from '../../shared/types.js';
import { problemCount, saveProblems } from './index.js';
import { catalogSnapshot } from './catalogSnapshot.js';

export type CatalogRow = [id: string, slug: string, title: string, difficulty: Problem['difficulty'], acceptance: number, tags: string[], paid: boolean, likes: number, dislikes: number, rating?: number];
// An empty database, including every new Vercel instance, starts from the bundled public catalog.
export function seedBundledCatalog() {
  if (problemCount() || !catalogSnapshot.length) return;
  saveProblems(catalogSnapshot.map(([id, slug, title, difficulty, acceptance, tags, paid, likes, dislikes, rating]) => ({ id, slug, title, difficulty, acceptance, tags, paid, likes, dislikes, rating })));
}
