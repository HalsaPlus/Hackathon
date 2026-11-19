import { existsSync } from 'node:fs';
import path from 'node:path';

// Loads .env for local use, as in the MMD app. Import this file first in
// index.ts. Variables that are already set (on Render, for example) win.
const envFile = path.resolve(import.meta.dirname, '..', '.env');
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}
