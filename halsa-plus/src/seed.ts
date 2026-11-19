import { now, type Database } from './db.ts';
import { getPatient } from './patients.ts';
import { ANDREA, ANDREA_DEVICES, buildDataset, dataWindow, type Entry } from './synthetic/dataset.ts';

// Seeds Andrea and loads her generated data (SYNTHETIC TEST DATA ONLY).
// Idempotent: rows are inserted with INSERT OR IGNORE on fixed ids, and the
// generator gives the same values every time, so a restart only adds the
// days that are new in the moving window. What she entered herself is never
// touched.

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
        `INSERT OR IGNORE INTO devices (id, patient_guid, type, name, source, types_json, since, created_at)
         VALUES (:id, :guid, :type, :name, :source, :types, :since, :at)`,
        { id: d.id, guid: ANDREA.guid, type: d.type, name: d.name, source: d.source, types: d.types, since: d.since, at },
      );
    }
  });

  const state = database.get<{ seeded_until: number }>('SELECT seeded_until FROM seed_state WHERE patient_guid = :guid', { guid: ANDREA.guid });
  if (state && state.seeded_until >= window.end) return { inserted: 0 };

  const { entries } = buildDataset(startDate);
  let inserted = 0;
  database.transaction(() => {
    const insert = database.db.prepare(INSERT_OBSERVATION.replace('INSERT', 'INSERT OR IGNORE'));
    for (const entry of entries) {
      inserted += Number(insert.run(observationRow(ANDREA.guid, entry, entry.observation.type === 'crp' ? 'external-lab' : 'generated', at)).changes);
    }
    database.run(
      `INSERT INTO seed_state (patient_guid, seeded_until, updated_at) VALUES (:guid, :until, :at)
       ON CONFLICT (patient_guid) DO UPDATE SET seeded_until = MAX(seeded_until, excluded.seeded_until), updated_at = excluded.updated_at`,
      { guid: ANDREA.guid, until: window.end, at },
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
