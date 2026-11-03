import type { Model, Profile, SearchFilters, SearchResponse, Settings, SyncStatus } from '../../shared/types';
export type Bootstrap = { hosted: boolean; settings: Settings; profile: Profile; model: Model; catalogCount: number; tags: string[]; catalogJob: { running: boolean; loaded: number; total: number; phase: string; error: string }; syncStatus: SyncStatus };

// On the hosted site the server keeps nothing per visitor. This browser holds the visitor's data,
// sends it with each request, and saves the updated copy the server returns. Locally the server
// never returns a copy, so nothing is stored here.
const stateKey = 'rickyleet:visitor-state';
let memoryState: unknown, storageFailed = false;
function readState() { try { const raw = localStorage.getItem(stateKey); return raw ? JSON.parse(raw) : memoryState; } catch { return memoryState; } }
function writeState(value: unknown) {
  memoryState = value;
  try { localStorage.setItem(stateKey, JSON.stringify(value)); storageFailed = false; }
  catch { storageFailed = true; try { localStorage.removeItem(stateKey); } catch { /* storage is unavailable; this tab keeps its in-memory copy */ } }
}
export const browserStorageFailed = () => storageFailed;

// Requests run one at a time so a slower response can never overwrite newer saved data.
let queue: Promise<unknown> = Promise.resolve();
export function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const send = async () => {
    const state = method === 'GET' ? undefined : readState();
    const payload = state === undefined ? body : { ...(body as Record<string, unknown> | undefined), visitorState: state };
    const response = await fetch(`/api${path}`, { method, headers: { 'content-type': 'application/json' }, body: payload === undefined ? undefined : JSON.stringify(payload) });
    const data = await response.json().catch(() => ({}));
    if (data && typeof data === 'object' && 'visitorState' in data) { writeState(data.visitorState); delete data.visitorState; }
    if (!response.ok) throw new Error(data.error ?? `Request failed: ${response.status}`);
    return data as T;
  };
  const result = queue.then(send, send);
  queue = result.catch(() => undefined);
  return result;
}
export const bootstrap = () => api<Bootstrap>('/bootstrap', 'POST');
export const search = (filters: SearchFilters) => api<SearchResponse>('/search', 'POST', filters);
export const searchCached = (filters: SearchFilters) => api<SearchResponse>('/search/cached', 'POST', filters);
export const saveSettings = (settings: Settings) => api<Settings>('/settings', 'PUT', settings);
