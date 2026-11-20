import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createApp, type AppOptions } from './app.ts';
import { openDatabase, type Database } from './db.ts';
import { createPatient, createToken, hashToken } from './patients.ts';
import { seedAndrea } from './seed.ts';
import { ANDREA } from './synthetic/dataset.ts';

// SYNTHETIC TEST DATA ONLY. Tokens per patient, persistence and the seed.

const NOW = Date.parse('2026-11-19T12:00:00Z');
const ANDREA_TOKEN = 'test-token-andrea-0123456789';
const tempDb = () => path.join(mkdtempSync(path.join(tmpdir(), 'halsa-plus-test-')), 'halsa-plus.sqlite');
type Body = any;

/** Starts the API on a database; returns a fetch helper per token and a stop function. */
async function start(database: Database, extra: Partial<AppOptions> = {}) {
  const app = createApp({ database, andreaToken: ANDREA_TOKEN, corsOrigins: [], now: () => NOW, startDate: '2026-11-19', ...extra });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const call = async (token: string, method: string, url: string, body?: unknown) => {
    const res = await fetch(base + url, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: (await res.json()) as Body };
  };
  return { call, stop: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

test('one token per patient: each patient sees only her own data', async () => {
  const database = openDatabase(':memory:');
  const api = await start(database);
  const other = createPatient(database, { name: 'Test Testsson', personalIdentityNumber: '191212121212', birthDate: '1912-12-12', heightCm: 180 });
  const otherToken = createToken(database, other, 'test');

  const meA = await api.call(ANDREA_TOKEN, 'GET', '/api/v1/me');
  const meB = await api.call(otherToken, 'GET', '/api/v1/me');
  assert.equal(meA.body.id, ANDREA.guid);
  assert.equal(meB.body.id, other);
  assert.equal(meB.body.identifier[0].display, '19121212-1212');

  // The other patient has no generated data, only the app as a device.
  assert.deepEqual((await api.call(otherToken, 'GET', '/api/v1/observations')).body.items, []);
  const devicesB = (await api.call(otherToken, 'GET', '/api/v1/devices')).body.items;
  assert.deepEqual(devicesB.map((d: { type: string }) => d.type), ['app']);

  // What B enters is visible to B only.
  const entered = await api.call(otherToken, 'POST', '/api/v1/observations', { type: 'stress', value: 6 });
  assert.equal(entered.status, 201);
  const forB = (await api.call(otherToken, 'GET', '/api/v1/observations?type=stress')).body.items;
  assert.deepEqual(forB.map((o: { id: string }) => o.id), [entered.body.id]);
  const forA = (await api.call(ANDREA_TOKEN, 'GET', '/api/v1/observations?type=stress&from=2026-11-19T00:00:00Z')).body.items;
  assert.ok(!forA.some((o: { id: string }) => o.id === entered.body.id));
  assert.ok((await api.call(ANDREA_TOKEN, 'GET', '/api/v1/devices')).body.items.every((d: { id: string }) => d.id !== devicesB[0].id));

  // Consent decisions too.
  await api.call(otherToken, 'POST', '/api/v1/requests/sr-1/consent', { decision: 'decline' });
  assert.equal((await api.call(otherToken, 'GET', '/api/v1/requests/sr-1/consent')).body.items.length, 1);
  assert.deepEqual((await api.call(ANDREA_TOKEN, 'GET', '/api/v1/requests/sr-1/consent')).body.items, []);

  // A revoked token no longer works.
  database.run('UPDATE patient_tokens SET revoked_at = :at WHERE patient_guid = :guid', { at: new Date().toISOString(), guid: other });
  assert.equal((await api.call(otherToken, 'GET', '/api/v1/me')).status, 401);
  await api.stop();
  database.close();
});

test('tokens are stored only as hashes', () => {
  const database = openDatabase(':memory:');
  seedAndrea(database, '2026-11-19');
  const token = createToken(database, ANDREA.guid, 'test');
  const rows = database.all<{ token_hash: string }>('SELECT token_hash FROM patient_tokens');
  assert.deepEqual(rows.map((r) => r.token_hash), [hashToken(token)]);
  assert.ok(!JSON.stringify(database.all('SELECT * FROM patient_tokens')).includes(token));
  database.close();
});

test('seeding is idempotent: the same rows and values on every start', () => {
  const file = tempDb();
  const snapshot = (database: Database) =>
    database.all<Record<string, unknown>>('SELECT * FROM observations ORDER BY available_at, id').map(({ created_at: _, ...row }) => row);
  const first = openDatabase(file);
  assert.ok(seedAndrea(first, '2026-11-19').inserted > 20_000);
  const before = snapshot(first);
  first.close();

  const second = openDatabase(file);
  assert.equal(seedAndrea(second, '2026-11-19').inserted, 0);
  assert.deepEqual(snapshot(second), before);
  assert.equal(second.get<{ n: number }>('SELECT COUNT(*) AS n FROM patients')!.n, 1);
  // A later start only adds the new days; earlier rows are unchanged.
  const later = seedAndrea(second, '2026-11-21');
  assert.ok(later.inserted > 0);
  assert.deepEqual(snapshot(second).slice(0, before.length), before);
  second.close();
});

test('HALSA_ANDREA_TOKEN is ensured once, hashed', async () => {
  const database = openDatabase(':memory:');
  (await start(database)).stop();
  (await start(database)).stop();
  assert.equal(database.get<{ n: number }>('SELECT COUNT(*) AS n FROM patient_tokens')!.n, 1);
  assert.equal(database.get<{ token_hash: string }>('SELECT token_hash FROM patient_tokens')!.token_hash, hashToken(ANDREA_TOKEN));
  database.close();
});

test('entered values and consent decisions persist across a restart', async () => {
  const file = tempDb();
  let database = openDatabase(file);
  let api = await start(database);
  const anxiety = await api.call(ANDREA_TOKEN, 'POST', '/api/v1/observations', { type: 'anxiety', value: 4, effectiveDateTime: '2026-11-19T11:30:00Z' });
  assert.equal(anxiety.status, 201);
  assert.deepEqual([anxiety.body.type, anxiety.body.value, anxiety.body.sourceType, anxiety.body.status], ['anxiety', 4, 'patient-reported', 'final']);
  const bmi = await api.call(ANDREA_TOKEN, 'POST', '/api/v1/observations', { type: 'bmi', components: [{ code: 'weight', value: 61.2 }] });
  assert.equal(bmi.body.value, 21.7);
  await api.call(ANDREA_TOKEN, 'POST', '/api/v1/requests/sr-42/consent', { decision: 'accept' });
  await api.call(ANDREA_TOKEN, 'POST', '/api/v1/requests/sr-42/consent', { decision: 'decline' });
  await api.stop();
  database.close();

  database = openDatabase(file);
  api = await start(database);
  const items = (await api.call(ANDREA_TOKEN, 'GET', '/api/v1/observations?type=anxiety,bmi&from=2026-11-19T00:00:00Z')).body.items;
  assert.deepEqual(items.map((o: { id: string }) => o.id).filter((id: string) => id === anxiety.body.id || id === bmi.body.id).sort(), [anxiety.body.id, bmi.body.id].sort());
  const history = (await api.call(ANDREA_TOKEN, 'GET', '/api/v1/requests/sr-42/consent')).body.items;
  assert.deepEqual(history.map((d: { decision: string }) => d.decision), ['accept', 'decline']);
  // Append-only: the database refuses to change or delete a decision.
  assert.throws(() => database.run("UPDATE consent_decisions SET decision = 'accept'"), /append-only/);
  assert.throws(() => database.run('DELETE FROM consent_decisions'), /append-only/);
  await api.stop();
  database.close();
});

test('POST /observations checks the input', async () => {
  const database = openDatabase(':memory:');
  const api = await start(database);
  for (const [body, code] of [
    [{ type: 'crp', value: 3 }, 'invalid_type'],
    [{ type: 'stress', value: 11 }, 'invalid_value'],
    [{ type: 'stress', value: 8 }, 'invalid_value'],
    [{ type: 'anxiety', value: 0 }, 'invalid_value'],
    [{ type: 'mood', value: 0 }, 'invalid_value'],
    [{ type: 'depression', value: 7.5 }, 'invalid_value'],
    [{ type: 'stress', value: 2.5 }, 'invalid_value'],
    [{ type: 'steps', value: 4000 }, 'invalid_type'],
    [{ type: 'anxiety', value: 3, effectiveDateTime: '2026-11-25T08:00:00Z' }, 'invalid_time'],
    [{ type: 'blood-pressure', components: [{ code: 'systolic', value: 120 }] }, 'invalid_value'],
  ] as const) {
    const res = await api.call(ANDREA_TOKEN, 'POST', '/api/v1/observations', body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(res.body.error.code, code, JSON.stringify(body));
  }
  const bp = await api.call(ANDREA_TOKEN, 'POST', '/api/v1/observations', {
    type: 'blood-pressure',
    components: [{ code: 'systolic', value: 118 }, { code: 'diastolic', value: 76 }, { code: 'pulse', value: 64 }],
  });
  assert.equal(bp.status, 201);
  assert.equal(bp.body.effectiveDateTime, '2026-11-19T12:00:00Z', 'defaults to the demo clock');
  for (const [type, value] of [['energy', 1], ['mood', 7], ['stress', 4], ['anxiety', 2], ['depression', 3]] as const) {
    const rating = await api.call(ANDREA_TOKEN, 'POST', '/api/v1/observations', { type, value });
    assert.equal(rating.status, 201, type);
    assert.deepEqual([rating.body.type, rating.body.value, rating.body.unit, rating.body.sourceType], [type, value, '1–7', 'patient-reported']);
  }
  await api.stop();
  database.close();
});

test('CLI: patient:create and token:create add a patient whose token works', async () => {
  const file = tempDb();
  const env = { ...process.env, HALSA_DATABASE_PATH: file };
  const run = (script: string, ...args: string[]) => spawnSync(process.execPath, [path.join(import.meta.dirname, '..', 'scripts', script), ...args], { env, encoding: 'utf8' });
  const created = run('patient-create.ts', '--name', 'Test Testsson', '--pnr', '191212121212', '--birth-date', '1912-12-12');
  assert.equal(created.status, 0, created.stderr);
  const guid = /Patient created: (\S+)/.exec(created.stdout)![1];
  const tokenRun = run('token-create.ts', '--patient', guid, '--label', 'cli test');
  assert.equal(tokenRun.status, 0, tokenRun.stderr);
  const token = /(hp_\S+)/.exec(tokenRun.stdout)![1];

  const database = openDatabase(file);
  const api = await start(database);
  assert.equal((await api.call(token, 'GET', '/api/v1/me')).body.id, guid);
  await api.stop();
  database.close();
});

test('a database from the previous version is migrated: new types allowed, generated data redone, entered values kept', () => {
  const file = tempDb();
  // The previous schema: only seven types, and seed_state without data_version.
  const old = new DatabaseSync(file);
  old.exec(`
    CREATE TABLE patients (guid TEXT PRIMARY KEY, name TEXT NOT NULL, personal_identity_number TEXT UNIQUE, birth_date TEXT,
      identifier_system TEXT, gender TEXT, height_cm REAL, created_at TEXT NOT NULL);
    CREATE TABLE observations (
      patient_guid TEXT NOT NULL REFERENCES patients(guid) ON DELETE CASCADE, id TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('blood-pressure', 'glucose', 'sleep', 'anxiety', 'stress', 'bmi', 'crp')),
      source TEXT NOT NULL CHECK (source IN ('generated', 'patient-entered', 'external-lab')),
      source_type TEXT NOT NULL CHECK (source_type IN ('device', 'patient-reported', 'external-lab')),
      device_id TEXT, available_at INTEGER NOT NULL, effective_date_time TEXT, period_start TEXT, period_end TEXT, issued TEXT,
      value REAL, comparator TEXT, unit TEXT, components_json TEXT, performer_json TEXT, created_at TEXT NOT NULL,
      PRIMARY KEY (patient_guid, id));
    CREATE TABLE seed_state (patient_guid TEXT PRIMARY KEY, seeded_until INTEGER NOT NULL, updated_at TEXT NOT NULL);
    INSERT INTO patients VALUES ('${ANDREA.guid}', 'Andrea Lindqvist', '200207252388', '2002-07-25', 'urn:oid:1.2.752.129.2.1.3.1', 'female', 168, 'x');
    INSERT INTO observations (patient_guid, id, type, source, source_type, available_at, effective_date_time, value, unit, created_at)
      VALUES ('${ANDREA.guid}', 'stress-old-generated', 'stress', 'generated', 'patient-reported', 1, '2026-03-02T20:00:00Z', 9, '0–10', 'x'),
             ('${ANDREA.guid}', 'anxiety-entered-earlier', 'anxiety', 'patient-entered', 'patient-reported', 2, '2026-11-18T20:00:00Z', 9, '0–10', 'x');
    INSERT INTO seed_state VALUES ('${ANDREA.guid}', 9999999999999, 'x');
  `);
  old.close();

  const database = openDatabase(file);
  assert.ok(seedAndrea(database, '2026-11-19').inserted > 20_000, 'the generated data is loaded again');
  const kept = database
    .all<{ id: string }>("SELECT id FROM observations WHERE id IN ('stress-old-generated', 'anxiety-entered-earlier')")
    .map((r) => r.id);
  assert.deepEqual(kept, ['anxiety-entered-earlier'], 'old generated rows are replaced, entered values kept as entered');
  const counts = database.all<{ type: string; n: number }>('SELECT type, COUNT(*) AS n FROM observations GROUP BY type');
  for (const type of ['steps', 'energy', 'mood', 'depression']) assert.ok(counts.find((c) => c.type === type)!.n > 0, type);
  const stress = database.all<{ value: number }>("SELECT value FROM observations WHERE type = 'stress' AND source = 'generated'");
  assert.ok(stress.length > 0 && stress.every((r) => r.value >= 1 && r.value <= 7));
  // The next start does nothing.
  assert.equal(seedAndrea(database, '2026-11-19').inserted, 0);
  database.close();
});
