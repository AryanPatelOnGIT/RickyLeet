import type { Model, Profile, Recommendation, SearchFilters, SearchResponse, Settings } from '../../shared/types';
export type Bootstrap = { settings: Settings; profile: Profile; model: Model; catalogCount: number; tags: string[]; companies: string[]; catalogJob: { running: boolean; loaded: number; total: number; phase: string; error: string }; lists: { id: number; name: string }[]; syncError?: string };
export async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> { const response = await fetch(`/api${path}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); const data = await response.json(); if (!response.ok) throw new Error(data.error ?? `Request failed: ${response.status}`); return data as T; }
export const bootstrap = () => api<Bootstrap>('/bootstrap');
export const search = (filters: SearchFilters) => api<SearchResponse>('/search', 'POST', filters);
export const saveSettings = (settings: Settings) => api<Settings>('/settings', 'PUT', settings);
export const getPlan = () => api<Recommendation[]>('/plan');
