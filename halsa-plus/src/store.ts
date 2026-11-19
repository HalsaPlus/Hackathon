import type { Database } from './db.ts';
import type { ObservationType, StoredObservation } from './synthetic/dataset.ts';

// Reading observations and devices for one patient. Every query is scoped to
// the patient the bearer token belongs to.

interface ObservationDbRow {
  id: string;
  type: ObservationType;
  source_type: StoredObservation['sourceType'];
  device_id: string | null;
  available_at: number;
  effective_date_time: string | null;
  period_start: string | null;
  period_end: string | null;
  issued: string | null;
  value: number | null;
  comparator: StoredObservation['comparator'] | null;
  unit: string | null;
  components_json: string | null;
  performer_json: string | null;
}

export interface Found {
  at: number;
  observation: StoredObservation;
}

function toObservation(row: ObservationDbRow): Found {
  const o: StoredObservation = {
    id: row.id,
    type: row.type,
    sourceType: row.source_type,
    deviceId: row.device_id,
    ...(row.performer_json ? { performer: JSON.parse(row.performer_json) } : {}),
    ...(row.effective_date_time ? { effectiveDateTime: row.effective_date_time } : {}),
    ...(row.period_start && row.period_end ? { effectivePeriod: { start: row.period_start, end: row.period_end } } : {}),
    ...(row.issued ? { issued: row.issued } : {}),
    ...(row.value !== null ? { value: row.value } : {}),
    ...(row.comparator ? { comparator: row.comparator } : {}),
    ...(row.unit ? { unit: row.unit } : {}),
    ...(row.components_json ? { components: JSON.parse(row.components_json) } : {}),
  };
  return { at: row.available_at, observation: o };
}

const COLUMNS = `id, type, source_type, device_id, available_at, effective_date_time, period_start, period_end, issued,
  value, comparator, unit, components_json, performer_json`;

export interface ObservationQuery {
  patientGuid: string;
  types: ObservationType[];
  from: number;
  to: number;
  deviceId?: string;
  after?: [number, string];
  limit: number;
}

/** One page, oldest first, plus whether there is more. */
export function findObservations(database: Database, q: ObservationQuery) {
  const rows = database.all<ObservationDbRow>(
    `SELECT ${COLUMNS} FROM observations
     WHERE patient_guid = :patientGuid
       AND available_at >= :from AND available_at <= :to
       AND type IN (SELECT value FROM json_each(:types))
       AND (:deviceId IS NULL OR device_id = :deviceId)
       AND (:afterAt IS NULL OR available_at > :afterAt OR (available_at = :afterAt AND id > :afterId))
     ORDER BY available_at, id
     LIMIT :limit`,
    {
      patientGuid: q.patientGuid,
      from: q.from,
      to: q.to,
      types: JSON.stringify(q.types),
      deviceId: q.deviceId,
      afterAt: q.after?.[0],
      afterId: q.after?.[1],
      limit: q.limit + 1,
    },
  );
  return { items: rows.slice(0, q.limit).map(toObservation), more: rows.length > q.limit };
}

/** The latest observation of each type at or before asOf. */
export function latestObservations(database: Database, patientGuid: string, types: ObservationType[], asOf: number) {
  return types.flatMap((type) => {
    const row = database.get<ObservationDbRow>(
      `SELECT ${COLUMNS} FROM observations
       WHERE patient_guid = :patientGuid AND type = :type AND available_at <= :asOf
       ORDER BY available_at DESC, id DESC LIMIT 1`,
      { patientGuid, type, asOf },
    );
    return row ? [toObservation(row)] : [];
  });
}

export function findObservation(database: Database, patientGuid: string, id: string) {
  const row = database.get<ObservationDbRow>(`SELECT ${COLUMNS} FROM observations WHERE patient_guid = :patientGuid AND id = :id`, { patientGuid, id });
  return row ? toObservation(row) : undefined;
}

export interface DeviceDbRow {
  id: string;
  type: string;
  name: string;
  source: string;
  types_json: string;
  since: string | null;
}

export function listDevices(database: Database, patientGuid: string) {
  return database.all<DeviceDbRow>('SELECT id, type, name, source, types_json, since FROM devices WHERE patient_guid = :patientGuid ORDER BY created_at, rowid', {
    patientGuid,
  });
}

/** Time of the device's latest observation at or before asOf. */
export function lastSync(database: Database, deviceId: string, asOf: number) {
  return database.get<{ at: number | null }>('SELECT MAX(available_at) AS at FROM observations WHERE device_id = :deviceId AND available_at <= :asOf', {
    deviceId,
    asOf,
  })?.at ?? null;
}
