import './env.ts'; // Must stay first: loads .env before anything reads it.
import { halsaPlusFromEnv } from './mount.ts';

// Runs the Hälsa+ API on its own. In the MMD service it is mounted at
// /halsa-plus instead (see server/index.ts in the repo root).

const port = Number(process.env.PORT) || 3002;
halsaPlusFromEnv().listen(port, '0.0.0.0', () => {
  console.log(`Hälsa+ demo API (synthetic data) on http://localhost:${port}`);
});
