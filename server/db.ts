import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// SQLite through Node's built-in driver, so there is nothing to compile on
// install. The file lives in data/ (gitignored) unless DATABASE_PATH says
// otherwise. Tests use ':memory:'.

const dbPath = process.env.DATABASE_PATH ?? path.resolve(import.meta.dirname, '..', 'data', 'mmd.sqlite');
if (dbPath !== ':memory:') mkdirSync(path.dirname(dbPath), { recursive: true });

export const db = new DatabaseSync(dbPath);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;

  -- One row per PDHC connection: where to fetch from and which token to use.
  -- provider_token and push_secret are never sent to the browser.
  CREATE TABLE IF NOT EXISTS connections (
    id                INTEGER PRIMARY KEY,
    name              TEXT NOT NULL,
    base_url          TEXT NOT NULL,
    provider_token    TEXT NOT NULL,
    gateway_url       TEXT,
    push_secret       TEXT,
    poll_enabled      INTEGER NOT NULL DEFAULT 0,
    feed_since        TEXT,
    last_test_at      TEXT,
    last_test_ok      INTEGER,
    last_test_message TEXT,
    last_sync_at      TEXT,
    last_sync_message TEXT,
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL
  );

  -- Patients as they arrive inside a ServiceRequest. PDHC (ips.pdhc) owns the
  -- patient; this is a copy so the app can show who the plan belongs to.
  CREATE TABLE IF NOT EXISTS patients (
    guid         TEXT PRIMARY KEY,
    display_name TEXT,
    birth_date   TEXT,
    gender       TEXT,
    fhir_json    TEXT,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
  );

  -- One row per ServiceRequest, with the raw FHIR resource and the keys needed
  -- to report back to gateway.pdhc later (grant_token) and to acknowledge a
  -- push (receipt_token).
  CREATE TABLE IF NOT EXISTS service_requests (
    guid              TEXT PRIMARY KEY,
    connection_id     INTEGER REFERENCES connections(id) ON DELETE SET NULL,
    patient_guid      TEXT NOT NULL REFERENCES patients(guid),
    source            TEXT NOT NULL CHECK (source IN ('push', 'poll', 'demo')),
    status            TEXT,
    intent            TEXT,
    priority          TEXT,
    title             TEXT,
    authored_on       TEXT,
    period_start      TEXT NOT NULL,
    period_end        TEXT NOT NULL,
    period_end_given  INTEGER NOT NULL,
    contract_guid     TEXT,
    provider_org_guid TEXT,
    match_guid        TEXT,
    receipt_token     TEXT,
    grant_token       TEXT,
    ack_status        TEXT,
    pdhc_updated_at   TEXT,
    seen_at           TEXT,
    checksum          TEXT NOT NULL,
    fhir_json         TEXT NOT NULL,
    received_at       TEXT NOT NULL,
    updated_at        TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS service_requests_patient ON service_requests(patient_guid);

  -- The care plans inside a ServiceRequest (one request may carry several, e.g.
  -- diabetes, reumatologi and ADHD). Replaced when PDHC sends a changed
  -- version of the same ServiceRequest.
  CREATE TABLE IF NOT EXISTS care_plans (
    id                   INTEGER PRIMARY KEY,
    service_request_guid TEXT NOT NULL REFERENCES service_requests(guid) ON DELETE CASCADE,
    fhir_id              TEXT,
    title                TEXT,
    description          TEXT,
    status               TEXT,
    goals_json           TEXT NOT NULL,
    fhir_json            TEXT
  );

  -- The lines on the map. activity_key is stable across re-deliveries, so
  -- performances (below) survive when the care plan is replaced.
  CREATE TABLE IF NOT EXISTS activities (
    id                INTEGER PRIMARY KEY,
    care_plan_id      INTEGER NOT NULL REFERENCES care_plans(id) ON DELETE CASCADE,
    position          INTEGER NOT NULL,
    activity_key      TEXT NOT NULL,
    title             TEXT NOT NULL,
    description       TEXT,
    performer_type    TEXT,
    status            TEXT,
    timing_json       TEXT NOT NULL,
    transactions_json TEXT NOT NULL,
    UNIQUE (care_plan_id, activity_key)
  );

  -- Stops that have been done. stop_index is the occurrence number on the
  -- activity's line, counted from the start of the plan.
  CREATE TABLE IF NOT EXISTS performances (
    id                   INTEGER PRIMARY KEY,
    service_request_guid TEXT NOT NULL REFERENCES service_requests(guid) ON DELETE CASCADE,
    activity_key         TEXT NOT NULL,
    stop_index           INTEGER NOT NULL,
    performed_at         TEXT NOT NULL,
    source               TEXT NOT NULL CHECK (source IN ('patient', 'demo')),
    UNIQUE (service_request_guid, activity_key, stop_index)
  );

  -- Everything that arrived, including what was rejected.
  CREATE TABLE IF NOT EXISTS inbound_log (
    id                   INTEGER PRIMARY KEY,
    received_at          TEXT NOT NULL,
    channel              TEXT NOT NULL CHECK (channel IN ('push', 'poll', 'demo')),
    connection_id        INTEGER REFERENCES connections(id) ON DELETE SET NULL,
    service_request_guid TEXT,
    outcome              TEXT NOT NULL CHECK (outcome IN ('created', 'updated', 'unchanged', 'rejected', 'error')),
    message              TEXT
  );
`);

// --- Version 2: the patient app --------------------------------------------------
// Upgrades a version 1 database in place, then adds the app's tables.

const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
if (version < 2) {
  const columns = (table: string) =>
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
  if (!columns('connections').includes('gateway_url')) db.exec('ALTER TABLE connections ADD COLUMN gateway_url TEXT');
  if (!columns('service_requests').includes('seen_at')) db.exec('ALTER TABLE service_requests ADD COLUMN seen_at TEXT');

  // Version 1 allowed one care plan per request. SQLite cannot drop a UNIQUE
  // constraint, so the table is rebuilt. Foreign keys are off meanwhile, or
  // dropping the old table would delete every activity with it.
  const unique = (db.prepare('PRAGMA index_list(care_plans)').all() as { unique: number; origin: string }[]).some(
    (index) => index.unique === 1 && index.origin === 'u',
  );
  if (unique) {
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec(`
      BEGIN;
      CREATE TABLE care_plans_v2 (
        id                   INTEGER PRIMARY KEY,
        service_request_guid TEXT NOT NULL REFERENCES service_requests(guid) ON DELETE CASCADE,
        fhir_id              TEXT,
        title                TEXT,
        description          TEXT,
        status               TEXT,
        goals_json           TEXT NOT NULL,
        fhir_json            TEXT
      );
      INSERT INTO care_plans_v2 SELECT id, service_request_guid, fhir_id, title, description, status, goals_json, fhir_json FROM care_plans;
      DROP TABLE care_plans;
      ALTER TABLE care_plans_v2 RENAME TO care_plans;
      COMMIT;
    `);
    db.exec('PRAGMA foreign_keys = ON');
  }
  db.exec('PRAGMA user_version = 2');
}

db.exec(`
  CREATE INDEX IF NOT EXISTS care_plans_request ON care_plans(service_request_guid);

  -- Values the patient reports, with the stamp the flow asks for: patient
  -- generated, from MMD (and which device), and where in which plan. The
  -- report status says whether gateway.pdhc has recorded it.
  CREATE TABLE IF NOT EXISTS observations (
    id                   INTEGER PRIMARY KEY,
    patient_guid         TEXT NOT NULL REFERENCES patients(guid),
    service_request_guid TEXT NOT NULL REFERENCES service_requests(guid) ON DELETE CASCADE,
    activity_key         TEXT NOT NULL,
    stop_index           INTEGER,
    name                 TEXT NOT NULL,
    transaction_guid     TEXT,
    concept_guid         TEXT,
    value                TEXT NOT NULL,
    unit                 TEXT,
    recorded_at          TEXT NOT NULL,
    patient_reported     INTEGER NOT NULL DEFAULT 1,
    source_app           TEXT NOT NULL,
    device               TEXT,
    care_plan_ref        TEXT,
    plan_day             INTEGER,
    note                 TEXT,
    report_status        TEXT NOT NULL CHECK (report_status IN ('pending', 'sent', 'failed', 'demo')),
    report_message       TEXT,
    reported_at          TEXT,
    confirmed            INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS observations_patient ON observations(patient_guid, recorded_at);

  -- The chat between the patient and the care team, plus system notes such as
  -- "a new plan arrived".
  CREATE TABLE IF NOT EXISTS messages (
    id                   INTEGER PRIMARY KEY,
    patient_guid         TEXT NOT NULL REFERENCES patients(guid),
    sender               TEXT NOT NULL CHECK (sender IN ('patient', 'care-team', 'system')),
    text                 TEXT NOT NULL,
    service_request_guid TEXT,
    created_at           TEXT NOT NULL,
    fhir_json            TEXT,
    cdr_status           TEXT,
    cdr_message          TEXT
  );
  CREATE INDEX IF NOT EXISTS messages_patient ON messages(patient_guid, created_at);

  -- The latest IPS (International Patient Summary, a FHIR document Bundle)
  -- per patient, fetched through Health Connect. In the demo: synthetic.
  CREATE TABLE IF NOT EXISTS ips_documents (
    patient_guid TEXT PRIMARY KEY REFERENCES patients(guid),
    source       TEXT NOT NULL,
    synthetic    INTEGER NOT NULL,
    bundle_json  TEXT NOT NULL,
    fetched_at   TEXT NOT NULL
  );
  DROP TABLE IF EXISTS clinical_results;
`);

// Columns added after the tables first shipped in this version.
for (const [table, column] of [
  ['messages', 'fhir_json'],
  ['messages', 'cdr_status'],
  ['messages', 'cdr_message'],
] as const) {
  const names = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
  if (!names.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);
}

export const now = () => new Date().toISOString();

/** Runs fn inside a transaction and rolls back if it throws. */
export function transaction<T>(fn: () => T): T {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

type Param = string | number | null;

/** SQLite cannot bind undefined or booleans; this turns them into null and 0/1. */
export function params(values: Record<string, unknown>): Record<string, Param> {
  const out: Record<string, Param> = {};
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null) out[key] = null;
    else if (typeof value === 'boolean') out[key] = value ? 1 : 0;
    else if (typeof value === 'number' || typeof value === 'string') out[key] = value;
    else out[key] = JSON.stringify(value);
  }
  return out;
}

export function all<T>(sql: string, values: Record<string, unknown> = {}): T[] {
  return db.prepare(sql).all(params(values)) as unknown as T[];
}

export function get<T>(sql: string, values: Record<string, unknown> = {}): T | undefined {
  return db.prepare(sql).get(params(values)) as unknown as T | undefined;
}

export function run(sql: string, values: Record<string, unknown> = {}) {
  return db.prepare(sql).run(params(values));
}
