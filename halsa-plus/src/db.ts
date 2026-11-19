import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// SQLite through Node's built-in driver, in the same style as the MMD app's
// server/db.ts. The file is halsa-plus/.data/halsa-plus.sqlite (git-ignored)
// unless HALSA_DATABASE_PATH says otherwise; on Render it is
// /var/data/halsa-plus.sqlite on the service's disk. Tests use ':memory:' or
// a temporary file.
//
// Unlike server/db.ts this opens a database per call instead of one per
// process, so tests can run several patients' databases and restarts.

export const DEFAULT_DATABASE_PATH = path.resolve(import.meta.dirname, '..', '.data', 'halsa-plus.sqlite');

const SCHEMA = `
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;

  -- Hälsa+ users. Only Andrea for now; more are added with npm run patient:create.
  CREATE TABLE IF NOT EXISTS patients (
    guid                     TEXT PRIMARY KEY,
    name                     TEXT NOT NULL,
    personal_identity_number TEXT UNIQUE,
    birth_date               TEXT,
    identifier_system        TEXT,
    gender                   TEXT,
    height_cm                REAL,
    created_at               TEXT NOT NULL
  );

  -- One or more API tokens per patient. Only a SHA-256 hash is stored; the raw
  -- token is shown once when it is created.
  CREATE TABLE IF NOT EXISTS patient_tokens (
    id           INTEGER PRIMARY KEY,
    patient_guid TEXT NOT NULL REFERENCES patients(guid) ON DELETE CASCADE,
    token_hash   TEXT NOT NULL UNIQUE,
    label        TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    revoked_at   TEXT
  );
  CREATE INDEX IF NOT EXISTS patient_tokens_patient ON patient_tokens(patient_guid);

  -- A patient's devices, and the Hälsa+ app itself for what she enters by hand.
  CREATE TABLE IF NOT EXISTS devices (
    id           TEXT PRIMARY KEY,
    patient_guid TEXT NOT NULL REFERENCES patients(guid) ON DELETE CASCADE,
    type         TEXT NOT NULL CHECK (type IN ('cgm-sensor', 'blood-pressure-monitor', 'scale', 'smartwatch', 'app')),
    name         TEXT NOT NULL,
    source       TEXT NOT NULL CHECK (source IN ('bluetooth', 'manual-entry')),
    types_json   TEXT NOT NULL,
    since        TEXT,
    created_at   TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS devices_patient ON devices(patient_guid);

  -- Every observation. source says where the row came from: the synthetic
  -- generator, the patient (POST /observations) or an external lab.
  -- available_at (ms since 1970) is when it becomes known: the effective
  -- time, the wake time for sleep, or issued for lab results.
  CREATE TABLE IF NOT EXISTS observations (
    patient_guid        TEXT NOT NULL REFERENCES patients(guid) ON DELETE CASCADE,
    id                  TEXT NOT NULL,
    type                TEXT NOT NULL CHECK (type IN ('blood-pressure', 'glucose', 'sleep', 'anxiety', 'stress', 'bmi', 'crp')),
    source              TEXT NOT NULL CHECK (source IN ('generated', 'patient-entered', 'external-lab')),
    source_type         TEXT NOT NULL CHECK (source_type IN ('device', 'patient-reported', 'external-lab')),
    device_id           TEXT REFERENCES devices(id),
    available_at        INTEGER NOT NULL,
    effective_date_time TEXT,
    period_start        TEXT,
    period_end          TEXT,
    issued              TEXT,
    value               REAL,
    comparator          TEXT CHECK (comparator IN ('<', '<=', '>', '>=')),
    unit                TEXT,
    components_json     TEXT,
    performer_json      TEXT,
    created_at          TEXT NOT NULL,
    PRIMARY KEY (patient_guid, id)
  );
  CREATE INDEX IF NOT EXISTS observations_time ON observations(patient_guid, available_at, id);
  CREATE INDEX IF NOT EXISTS observations_type_time ON observations(patient_guid, type, available_at);
  CREATE INDEX IF NOT EXISTS observations_device_time ON observations(device_id, available_at);

  -- Every consent decision, never changed or deleted (the triggers enforce it).
  -- The latest row for a request is the one that applies.
  CREATE TABLE IF NOT EXISTS consent_decisions (
    id           INTEGER PRIMARY KEY,
    patient_guid TEXT NOT NULL REFERENCES patients(guid),
    request_id   TEXT NOT NULL,
    decision     TEXT NOT NULL CHECK (decision IN ('accept', 'decline')),
    decided_at   TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS consent_decisions_request ON consent_decisions(patient_guid, request_id, id);
  CREATE TRIGGER IF NOT EXISTS consent_decisions_no_update BEFORE UPDATE ON consent_decisions
    BEGIN SELECT RAISE(ABORT, 'consent_decisions is append-only'); END;
  CREATE TRIGGER IF NOT EXISTS consent_decisions_no_delete BEFORE DELETE ON consent_decisions
    BEGIN SELECT RAISE(ABORT, 'consent_decisions is append-only'); END;

  -- How far the generated data has been loaded for a patient, so a restart
  -- does not reload what is already there.
  CREATE TABLE IF NOT EXISTS seed_state (
    patient_guid TEXT PRIMARY KEY REFERENCES patients(guid) ON DELETE CASCADE,
    seeded_until INTEGER NOT NULL,
    updated_at   TEXT NOT NULL
  );
`;

type Param = string | number | null;

/** SQLite cannot bind undefined or booleans; this turns them into null and 0/1 (as in server/db.ts). */
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

export const now = () => new Date().toISOString();

export interface Database {
  db: DatabaseSync;
  all<T>(sql: string, values?: Record<string, unknown>): T[];
  get<T>(sql: string, values?: Record<string, unknown>): T | undefined;
  run(sql: string, values?: Record<string, unknown>): ReturnType<ReturnType<DatabaseSync['prepare']>['run']>;
  transaction<T>(fn: () => T): T;
  close(): void;
}

export function openDatabase(file: string = process.env.HALSA_DATABASE_PATH || DEFAULT_DATABASE_PATH): Database {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  return {
    db,
    all: <T>(sql: string, values: Record<string, unknown> = {}) => db.prepare(sql).all(params(values)) as unknown as T[],
    get: <T>(sql: string, values: Record<string, unknown> = {}) => db.prepare(sql).get(params(values)) as unknown as T | undefined,
    run: (sql: string, values: Record<string, unknown> = {}) => db.prepare(sql).run(params(values)),
    transaction<T>(fn: () => T): T {
      db.exec('BEGIN');
      try {
        const result = fn();
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    close: () => db.close(),
  };
}
