import { now, type Database } from './db.ts';
import { getPatient } from './patients.ts';
import { ANDREA, ANDREA_DEVICES, buildDataset, dataWindow, type Entry } from './synthetic/dataset.ts';

// Seeds Andrea and loads her generated data (SYNTHETIC TEST DATA ONLY).
// Idempotent: rows are inserted with INSERT OR IGNORE on fixed ids, and the
// generator gives the same values every time, so a restart only adds the
// days that are new in the moving window. What she entered herself is never
// touched.
//
// DATA_VERSION goes up when the generator itself changes (version 2: the
// self-ratings are 1–7, and steps, energy, mood and depression are new). An
// older database then gets its generated rows replaced once.

export const DATA_VERSION = 2;

export function seedAndrea(database: Database, startDate: string) {
  const window = dataWindow(startDate);
  const at = now();
  database.transaction(() => {
    if (!getPatient(database, ANDREA.guid)) {
      database.run(
        `INSERT INTO patients (guid, name, personal_identity_number, birth_date, identifier_system, gender, height_cm, created_at)
         VALUES (:guid, :name, :pnr, :birthDate, :system, :gender, :heightCm, :at)`,
        {
          guid: ANDREA.guid,
          name: ANDREA.name,
          pnr: ANDREA.personalIdentityNumber,
          birthDate: ANDREA.birthDate,
          system: ANDREA.identifierSystem,
          gender: ANDREA.gender,
          heightCm: ANDREA.heightCm,
          at,
        },
      );
    }
    for (const d of ANDREA_DEVICES) {
      database.run(
        `INSERT INTO devices (id, patient_guid, type, name, source, types_json, since, created_at)
         VALUES (:id, :guid, :type, :name, :source, :types, :since, :at)
         ON CONFLICT (id) DO UPDATE SET types_json = excluded.types_json`,
        { id: d.id, guid: ANDREA.guid, type: d.type, name: d.name, source: d.source, types: d.types, since: d.since, at },
      );
    }
  });

  const state = database.get<{ seeded_until: number; data_version: number }>(
    'SELECT seeded_until, data_version FROM seed_state WHERE patient_guid = :guid',
    { guid: ANDREA.guid },
  );
  const outdated = !!state && state.data_version < DATA_VERSION;
  if (state && !outdated && state.seeded_until >= window.end) return { inserted: 0 };

  const { entries } = buildDataset(startDate);
  let inserted = 0;
  database.transaction(() => {
    // Only what the generator made; entered values and lab results stay.
    if (outdated) database.run(`DELETE FROM observations WHERE patient_guid = :guid AND source = 'generated'`, { guid: ANDREA.guid });
    const insert = database.db.prepare(INSERT_OBSERVATION.replace('INSERT', 'INSERT OR IGNORE'));
    for (const entry of entries) {
      inserted += Number(insert.run(observationRow(ANDREA.guid, entry, entry.observation.type === 'crp' ? 'external-lab' : 'generated', at)).changes);
    }
    database.run(
      `INSERT INTO seed_state (patient_guid, seeded_until, data_version, updated_at) VALUES (:guid, :until, :version, :at)
       ON CONFLICT (patient_guid) DO UPDATE SET
         seeded_until = CASE WHEN :outdated = 1 THEN excluded.seeded_until ELSE MAX(seeded_until, excluded.seeded_until) END,
         data_version = excluded.data_version, updated_at = excluded.updated_at`,
      { guid: ANDREA.guid, until: window.end, version: DATA_VERSION, outdated, at },
    );
  });
  return { inserted };
}

export const INSERT_OBSERVATION = `
  INSERT INTO observations (patient_guid, id, type, source, source_type, device_id, available_at, effective_date_time,
    period_start, period_end, issued, value, comparator, unit, components_json, performer_json, created_at)
  VALUES (:patientGuid, :id, :type, :source, :sourceType, :deviceId, :availableAt, :effectiveDateTime,
    :periodStart, :periodEnd, :issued, :value, :comparator, :unit, :components, :performer, :createdAt)`;

type Bindable = string | number | null;

/** An observation as named SQL parameters (null for what it does not have). */
export function observationRow(patientGuid: string, { at, observation: o }: Entry, source: string, createdAt: string): Record<string, Bindable> {
  return {
    patientGuid,
    id: o.id,
    type: o.type,
    source,
    sourceType: o.sourceType,
    deviceId: o.deviceId,
    availableAt: at,
    effectiveDateTime: o.effectiveDateTime ?? null,
    periodStart: o.effectivePeriod?.start ?? null,
    periodEnd: o.effectivePeriod?.end ?? null,
    issued: o.issued ?? null,
    value: o.value ?? null,
    comparator: o.comparator ?? null,
    unit: o.unit ?? null,
    components: o.components ? JSON.stringify(o.components) : null,
    performer: o.performer ? JSON.stringify(o.performer) : null,
    createdAt,
  };
}
