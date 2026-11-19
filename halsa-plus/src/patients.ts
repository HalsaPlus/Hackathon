import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { now, type Database } from './db.ts';

// Patients and their API tokens. One bearer token identifies one patient.
// Only a SHA-256 hash of a token is stored; the raw token is returned once.

export const PERSONNUMMER_SYSTEM = 'urn:oid:1.2.752.129.2.1.3.1';

export interface PatientRow {
  guid: string;
  name: string;
  personal_identity_number: string | null;
  birth_date: string | null;
  identifier_system: string | null;
  gender: string | null;
  height_cm: number | null;
  created_at: string;
}

export interface NewPatient {
  guid?: string;
  name: string;
  personalIdentityNumber?: string;
  birthDate?: string;
  identifierSystem?: string;
  gender?: string;
  heightCm?: number;
}

/** "200207252388" → "20020725-2388" (the usual way to write a Swedish personal identity number). */
export function displayPersonalIdentityNumber(value: string | null) {
  return value && /^\d{12}$/.test(value) ? `${value.slice(0, 8)}-${value.slice(8)}` : value;
}

export function getPatient(database: Database, guid: string) {
  return database.get<PatientRow>('SELECT * FROM patients WHERE guid = :guid', { guid });
}

/**
 * Adds a patient and the Hälsa+ app as her device (for values she enters by
 * hand). Returns the guid. Throws if the guid or personal identity number exists.
 */
export function createPatient(database: Database, input: NewPatient, appDeviceId: string = randomUUID()) {
  const guid = input.guid ?? randomUUID();
  if (input.personalIdentityNumber !== undefined && !/^\d{12}$/.test(input.personalIdentityNumber)) {
    throw new Error('The personal identity number must be 12 digits, for example 200207252388.');
  }
  const at = now();
  database.transaction(() => {
    database.run(
      `INSERT INTO patients (guid, name, personal_identity_number, birth_date, identifier_system, gender, height_cm, created_at)
       VALUES (:guid, :name, :pnr, :birthDate, :system, :gender, :heightCm, :at)`,
      {
        guid,
        name: input.name,
        pnr: input.personalIdentityNumber,
        birthDate: input.birthDate,
        system: input.personalIdentityNumber ? (input.identifierSystem ?? PERSONNUMMER_SYSTEM) : input.identifierSystem,
        gender: input.gender,
        heightCm: input.heightCm,
        at,
      },
    );
    database.run(
      `INSERT INTO devices (id, patient_guid, type, name, source, types_json, since, created_at)
       VALUES (:id, :guid, 'app', 'Hälsa+ app', 'manual-entry', :types, :since, :at)`,
      { id: appDeviceId, guid, types: ['anxiety', 'stress', 'blood-pressure', 'glucose', 'bmi', 'sleep'], since: at.slice(0, 10), at },
    );
  });
  return guid;
}

export const hashToken = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');

/** A new random token for a patient. The raw value is returned once and never stored. */
export function createToken(database: Database, patientGuid: string, label: string) {
  if (!getPatient(database, patientGuid)) throw new Error(`There is no patient ${patientGuid}.`);
  const token = `hp_${randomBytes(32).toString('base64url')}`;
  database.run(
    `INSERT INTO patient_tokens (patient_guid, token_hash, label, created_at) VALUES (:guid, :hash, :label, :at)`,
    { guid: patientGuid, hash: hashToken(token), label, at: now() },
  );
  return token;
}

/** Makes sure a given token (e.g. from HALSA_ANDREA_TOKEN) exists for the patient. Stores only its hash. */
export function ensureToken(database: Database, patientGuid: string, token: string, label: string) {
  if (token.length < 16) throw new Error('A token must be at least 16 characters.');
  const hash = hashToken(token);
  const existing = database.get<{ patient_guid: string }>('SELECT patient_guid FROM patient_tokens WHERE token_hash = :hash', { hash });
  if (existing && existing.patient_guid !== patientGuid) throw new Error('This token already belongs to another patient.');
  if (!existing) {
    database.run(
      `INSERT INTO patient_tokens (patient_guid, token_hash, label, created_at) VALUES (:guid, :hash, :label, :at)`,
      { guid: patientGuid, hash, label, at: now() },
    );
  }
}

/**
 * The patient a bearer token belongs to, or undefined. Compares the hash
 * with every active token's hash in constant time.
 */
export function patientForToken(database: Database, token: string): PatientRow | undefined {
  const hash = Buffer.from(hashToken(token), 'hex');
  let match: string | undefined;
  for (const row of database.all<{ patient_guid: string; token_hash: string }>(
    'SELECT patient_guid, token_hash FROM patient_tokens WHERE revoked_at IS NULL',
  )) {
    if (timingSafeEqual(hash, Buffer.from(row.token_hash, 'hex'))) match = row.patient_guid;
  }
  return match ? getPatient(database, match) : undefined;
}
