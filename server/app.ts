import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { randomUUID } from 'node:crypto';
import { api } from './routes/api.js';
import { LOCAL_OWNER, multiUser, runAsOwner } from './context.js';
import './db/index.js';

const OWNER_COOKIE = 'rl_uid';
const ownerPattern = new RegExp(`(?:^|;\\s*)${OWNER_COOKIE}=([0-9a-f-]{36})(?:;|$)`);

export const app = express();
app.disable('x-powered-by');
app.use(cors({ origin: /^http:\/\/(localhost|127\.0\.0\.1):5173$/ }));
app.use(express.json({ limit: '2mb' }));
// Runs after the body parser so the owner context reaches every route handler.
app.use((req, res, next) => {
  if (!multiUser) { runAsOwner(LOCAL_OWNER, next); return; }
  let owner = ownerPattern.exec(req.headers.cookie ?? '')?.[1];
  if (!owner) {
    owner = randomUUID();
    res.setHeader('Set-Cookie', `${OWNER_COOKIE}=${owner}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax${req.secure || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : ''}`);
  }
  runAsOwner(owner, next);
});
app.use('/api', api);
app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(500).json({ error: error.message }));
