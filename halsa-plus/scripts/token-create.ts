// Creates an API token for a patient and prints it ONCE. Only its hash is stored.
//
//   npm run token:create -- --patient <guid> --label <text>
//
// Uses HALSA_DATABASE_PATH (or halsa-plus/.data/halsa-plus.sqlite).

import '../src/env.ts';
import { openDatabase } from '../src/db.ts';
import { createToken } from '../src/patients.ts';
import { args, fail } from './cli.ts';

const { patient, label } = args();
if (!patient || !label) fail('Usage: npm run token:create -- --patient <guid> --label <text>');

const database = openDatabase();
try {
  const token = createToken(database, patient, label);
  console.log(`Token for patient ${patient} (${label}). It is shown only now; store it safely:\n\n${token}\n`);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
} finally {
  database.close();
}
