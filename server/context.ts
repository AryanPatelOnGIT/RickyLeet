import { AsyncLocalStorage } from 'node:async_hooks';

// Every request runs as one "owner". Locally there is a single owner; when hosted
// (MULTI_USER=true, or automatically on Vercel) each browser gets its own anonymous ID.
export const LOCAL_OWNER = 'local';
export const multiUser = process.env.MULTI_USER ? process.env.MULTI_USER === 'true' : !!process.env.VERCEL;
const storage = new AsyncLocalStorage<string>();
export const currentOwner = () => storage.getStore() ?? LOCAL_OWNER;
export const runAsOwner = <T>(owner: string, fn: () => T): T => storage.run(owner, fn);
