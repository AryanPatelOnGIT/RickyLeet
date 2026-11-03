import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { randomUUID } from 'node:crypto';
import { api } from './routes/api.js';
import { LOCAL_OWNER, multiUser, runAsOwner } from './context.js';
import { deleteVisitorState, exportVisitorState, importVisitorState } from './db/index.js';
import { seedBundledCatalog } from './db/catalog.js';

seedBundledCatalog();
const localHost = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

export const app = express();
app.disable('x-powered-by');
app.use(cors({ origin: /^http:\/\/(localhost|127\.0\.0\.1):5173$/ }));
app.use(express.json({ limit: '4mb' }));
// Runs after the body parser so the owner context reaches every route handler.
app.use((req, res, next) => {
  if (!multiUser) {
    // Single-user mode serves the owner's private data and session, so it only answers this computer.
    if (!localHost.test(req.headers.host ?? '')) { res.status(403).json({ error: 'This RickyLeet server runs in single-user local mode. Set MULTI_USER=true to host it for other people.' }); return; }
    runAsOwner(LOCAL_OWNER, next); return;
  }
  // Hosted: the visitor's own browser sends its saved data with every non-GET request and gets the
  // updated copy back. The throwaway owner is deleted when the response ends, so no visitor's data
  // stays on the server or reaches another visitor, and any server instance can answer any request.
  const owner = `visitor:${randomUUID()}`;
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body as Record<string, unknown> : undefined;
  const incoming = body?.visitorState;
  if (body) delete body.visitorState;
  let done = false;
  const cleanup = () => { if (!done) { done = true; runAsOwner(owner, deleteVisitorState); } };
  res.on('close', cleanup);
  runAsOwner(owner, () => {
    importVisitorState(incoming);
    // GET responses never carry state, so a read can never replace the browser's copy with an empty one.
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const send = res.json.bind(res);
      res.json = (payload: unknown) => { const visitorState = done ? undefined : runAsOwner(owner, exportVisitorState); cleanup(); return send(payload && typeof payload === 'object' && !Array.isArray(payload) && visitorState ? { ...payload, visitorState } : payload); };
    }
    next();
  });
});
app.use('/api', api);
app.use((error: Error & { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(error.status && error.status >= 400 && error.status < 600 ? error.status : 500).json({ error: error.message }));
