import './env.ts'; // Must stay first: loads .env before anything reads it.
import { createApp } from './app.ts';

const port = Number(process.env.PORT) || 3002;
const token = process.env.HALSA_API_TOKEN?.trim() || undefined;
const corsOrigins = (process.env.CORS_ORIGINS ?? '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

let demoNow: number | undefined;
if (process.env.DEMO_NOW) {
  demoNow = Date.parse(process.env.DEMO_NOW);
  if (Number.isNaN(demoNow)) throw new Error(`DEMO_NOW is not an ISO 8601 date-time: ${process.env.DEMO_NOW}`);
}

if (!token) console.warn('HALSA_API_TOKEN is not set: every endpoint except /api/v1/health answers 503.');

const app = createApp({ token, corsOrigins, demoNow });
app.listen(port, '0.0.0.0', () => {
  console.log(`Hälsa+ demo API (synthetic data) on http://localhost:${port}`);
});
