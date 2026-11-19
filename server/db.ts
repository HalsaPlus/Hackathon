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
    checksum          TEXT NOT NULL,
    fhir_json         TEXT NOT NULL,
    received_at       TEXT NOT NULL,
    updated_at        TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS service_requests_patient ON service_requests(patient_guid);

  -- The care plan inside a ServiceRequest. Replaced when PDHC sends a changed
  -- version of the same ServiceRequest.
  CREATE TABLE IF NOT EXISTS care_plans (
    id                   INTEGER PRIMARY KEY,
    service_request_guid TEXT NOT NULL UNIQUE REFERENCES service_requests(guid) ON DELETE CASCADE,
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
