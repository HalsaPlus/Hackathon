import './env.ts'; // Must stay first: loads .env before anything reads it.
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import express from 'express';
import { loginConfigured, setupAuth } from './auth.ts';
import { setupApi, setupPushEndpoint } from './routes.ts';
import { startPolling } from './sync.ts';

const isProd = process.env.NODE_ENV === 'production';
const port = Number(process.env.PORT) || 3001;
const root = path.resolve(import.meta.dirname, '..');
const distDir = path.join(root, 'dist');
const POLL_INTERVAL_MS = 60_000;

const app = express();
const server = createServer(app);

app.disable('x-powered-by');
// When deployed behind a proxy that terminates HTTPS, this makes req.secure
// and req.ip reflect the visitor rather than the proxy.
app.set('trust proxy', 1);

// --- Public ----------------------------------------------------------------

app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    environment: isProd ? 'production' : 'development',
    loginConfigured,
    uptimeSeconds: Math.round(process.uptime()),
  });
});

// PDHC pushes ServiceRequests here. It authenticates with X-Push-Secret,
// not with a login session, so it is registered before setupAuth().
setupPushEndpoint(app);

// --- Login -----------------------------------------------------------------
// Everything below this line requires a signed-in session.

setupAuth(app);
if (!loginConfigured) {
  console.warn('ADMIN_PASSWORD is not set: nobody can sign in. Set it in .env (see .env.example).');
}

// --- API -------------------------------------------------------------------

setupApi(app);

app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// --- Web app ---------------------------------------------------------------

if (isProd) {
  const indexHtml = path.join(distDir, 'index.html');
  if (!existsSync(indexHtml)) {
    console.error('dist/index.html is missing. Run "npm run build" before "npm start".');
    process.exit(1);
  }
  app.use('/assets', express.static(path.join(distDir, 'assets'), { immutable: true, maxAge: '1y' }));
  app.use(express.static(distDir));
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    res.sendFile(indexHtml);
  });
} else {
  // In development Vite runs inside this server, so there is one port and
  // hot reload works without a proxy.
  const { createServer: createViteServer } = await import('vite');
  const vite = await createViteServer({
    root,
    appType: 'spa',
    server: { middlewareMode: true, hmr: { server } },
  });
  app.use(vite.middlewares);
}

startPolling(POLL_INTERVAL_MS);

server.listen(port, '0.0.0.0', () => {
  console.log(`MMD listening on http://localhost:${port} (${isProd ? 'production' : 'development'})`);
});

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});
