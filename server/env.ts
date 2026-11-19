import { existsSync } from 'node:fs';
import path from 'node:path';

// Loads .env for local use. Import this file first in index.ts, so the values
// are in place before other modules read process.env. Variables that are
// already set win.
//
// This is done here instead of with Node's --env-file flag, because that flag
// combined with --watch makes the dev server restart in a loop.
const envFile = path.resolve(import.meta.dirname, '..', '.env');
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}
