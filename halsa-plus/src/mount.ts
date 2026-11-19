import type { Express } from 'express';
import { createApp } from './app.ts';
import { openDatabase } from './db.ts';

// The Hälsa+ API configured from environment variables. Used both when it runs
// on its own (src/index.ts) and when the MMD server mounts it at /halsa-plus.
//
//   HALSA_DATABASE_PATH  SQLite file (default halsa-plus/.data/halsa-plus.sqlite)
//   HALSA_ANDREA_TOKEN   optional: makes sure this token exists for Andrea (stored hashed, never logged)
//   HALSA_CORS_ORIGINS   optional: browser origins, comma-separated
//   DEMO_NOW             optional: default for the demo clock (asOf)

export function halsaPlusFromEnv(env: NodeJS.ProcessEnv = process.env): Express {
  let demoNow: number | undefined;
  if (env.DEMO_NOW) {
    demoNow = Date.parse(env.DEMO_NOW);
    if (Number.isNaN(demoNow)) throw new Error(`DEMO_NOW is not an ISO 8601 date-time: ${env.DEMO_NOW}`);
  }
  return createApp({
    database: openDatabase(env.HALSA_DATABASE_PATH || undefined),
    corsOrigins: (env.HALSA_CORS_ORIGINS ?? '')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),
    demoNow,
    andreaToken: env.HALSA_ANDREA_TOKEN?.trim() || undefined,
  });
}
