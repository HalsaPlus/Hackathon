// Adds a patient (synthetic data only), with the Hälsa+ app as her device for
// values she enters herself. Prints the patient's guid; then create a token:
//
//   npm run patient:create -- --name "Test Testsson" --pnr 191212121212 --birth-date 1912-12-12 [--guid <guid>] [--gender female] [--height-cm 170]
//   npm run token:create -- --patient <guid> --label "Test Testsson phone"
//
// Uses HALSA_DATABASE_PATH (or halsa-plus/.data/halsa-plus.sqlite).

import '../src/env.ts';
import { openDatabase } from '../src/db.ts';
import { createPatient } from '../src/patients.ts';
import { args, fail } from './cli.ts';

const a = args();
if (!a.name) fail('Usage: npm run patient:create -- --name <text> [--pnr <12 digits>] [--birth-date YYYY-MM-DD] [--guid <guid>] [--gender <text>] [--height-cm <number>]');

const database = openDatabase();
try {
  const guid = createPatient(database, {
    guid: a.guid,
    name: a.name,
    personalIdentityNumber: a.pnr,
    birthDate: a['birth-date'],
    gender: a.gender,
    heightCm: a['height-cm'] ? Number(a['height-cm']) : undefined,
  });
  console.log(`Patient created: ${guid}`);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
} finally {
  database.close();
}
