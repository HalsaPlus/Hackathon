import { randomUUID } from 'node:crypto';
import { HALSA_SERIES, halsaSeriesFor } from '../shared/halsa.ts';
import type { ReportResult, SentReport } from '../shared/types.ts';
import { ANDREA_GUID, ANDREA_IDENTIFIER, type ChannelSettings, getChannelSettings, log, request, shortAnswer } from './careteam-channel.ts';
import { db, get, now, run } from './db.ts';
import { gatewayValue } from './pdhc.ts';
import { getObservations, type ServiceRequestRow, setReportOutcome } from './store.ts';

// The patient's reported values to the care team's system instead of
// gateway.pdhc (valuesTarget 'careteam' in the care-team channel settings).
//
// reportStop (server/report.ts) does everything before the send as always:
// the plan checks, storing the values here, demo mode for demo requests. Then
// this POSTs one FHIR Bundle of type transaction to {valuesUrl}, one
// Observation per value, with the channel's token and auth header. A 2xx
// marks the values sent and confirmed, and the Observation ids it answers
// with are stored as the receipt; anything else marks them failed.
// The token never reaches the log or an answer. SYNTHETIC DATA ONLY.

db.exec(`
  -- The care team's id for each value sent to it: the receipt.
  CREATE TABLE IF NOT EXISTS careteam_value_receipts (
    observation_id INTEGER PRIMARY KEY,
    remote_id      TEXT,
    sent_at        TEXT NOT NULL
  );
`);

/** One stored value, as reportStop has it after insertObservation. */
export interface StoredValue {
  id: number;
  name: string;
  value: string;
  unit: string | null;
  recordedAt: string;
  note: string | null;
  transactionGuid: string | null;
  conceptGuid: string | null;
  responseType?: string;
  device: string | null;
}

export const valuesTarget = () => getChannelSettings().valuesTarget;

const MMD = 'https://mmd.halsaplus.se/fhir';
const UCUM = 'http://unitsofmeasure.org';
const CATEGORY = 'http://terminology.hl7.org/CodeSystem/observation-category';

/** Units as MMD's plans write them, to UCUM. Others are sent as text only. */
const UCUM_CODES: Record<string, string> = {
  mmhg: 'mm[Hg]',
  'mm[hg]': 'mm[Hg]',
  'mmol/l': 'mmol/L',
  'mg/dl': 'mg/dL',
  kg: 'kg',
  g: 'g',
  cm: 'cm',
  m: 'm',
  h: 'h',
  hour: 'h',
  hours: 'h',
  timmar: 'h',
  min: 'min',
  minutes: 'min',
  minuter: 'min',
  bpm: '/min',
  '/min': '/min',
  '%': '%',
  'kg/m2': 'kg/m2',
  'kg/m²': 'kg/m2',
  steps: '{steps}',
  steg: '{steps}',
  '°c': 'Cel',
  cel: 'Cel',
};

const isRating = (v: StoredValue) => {
  const series = halsaSeriesFor({ conceptGuid: v.conceptGuid ?? undefined, name: v.name });
  return !!series && !!HALSA_SERIES[series].rating;
};

function value(v: StoredValue) {
  const number = gatewayValue(v.value, v.responseType);
  if (typeof number !== 'number') return { valueString: v.value };
  const unit = v.unit && v.unit !== '1–7' ? v.unit : null;
  const code = unit ? UCUM_CODES[unit.toLowerCase()] : undefined;
  return { valueQuantity: { value: number, ...(unit ? { unit } : {}), ...(code ? { system: UCUM, code } : {}) } };
}

/** One FHIR Observation for a reported value. */
export function toObservation(v: StoredValue, request: Pick<ServiceRequestRow, 'guid' | 'patient_guid'>) {
  const survey = isRating(v);
  return {
    resourceType: 'Observation',
    meta: {
      tag: [
        { system: `${MMD}/source`, code: 'MMD', display: 'Source: MMD' },
        { system: `${MMD}/provenance`, code: 'patient-reported', display: 'Patient reported' },
      ],
    },
    identifier: [{ system: `${MMD}/observation`, value: `mmd-observation-${v.id}` }],
    status: 'final',
    category: [{ coding: [survey ? { system: CATEGORY, code: 'survey', display: 'Survey' } : { system: CATEGORY, code: 'vital-signs', display: 'Vital Signs' }] }],
    code: {
      text: v.name,
      coding: [
        ...(v.conceptGuid ? [{ system: 'urn:pdhc:concept', code: v.conceptGuid, display: v.name }] : []),
        ...(v.transactionGuid ? [{ system: 'urn:pdhc:transaction', code: v.transactionGuid, display: v.name }] : []),
      ],
    },
    subject: { reference: `Patient/${request.patient_guid}`, ...(request.patient_guid === ANDREA_GUID ? { identifier: ANDREA_IDENTIFIER } : {}) },
    basedOn: [{ reference: `ServiceRequest/${request.guid}` }],
    effectiveDateTime: v.recordedAt,
    ...value(v),
    ...(v.device ? { device: { display: v.device } } : {}),
    ...(v.note ? { note: [{ text: v.note }] } : {}),
  };
}

export function toTransactionBundle(values: StoredValue[], request: Pick<ServiceRequestRow, 'guid' | 'patient_guid'>) {
  return {
    resourceType: 'Bundle',
    type: 'transaction',
    timestamp: new Date().toISOString(),
    entry: values.map((v) => ({
      fullUrl: `urn:uuid:${randomUUID()}`,
      resource: toObservation(v, request),
      request: { method: 'POST', url: 'Observation' },
    })),
  };
}

type Json = Record<string, any>;

/** The Observation ids in their answer, in the order sent: a transaction-response Bundle, or a plain resource or id list. */
export function receiptIds(answer: unknown, count: number): (string | null)[] {
  const body = (answer ?? {}) as Json;
  const fromEntry = (entry: Json) => {
    const location = typeof entry?.response?.location === 'string' ? entry.response.location : '';
    const match = location.match(/Observation\/([^/?#]+)/);
    if (match) return match[1];
    if (typeof entry?.resource?.id === 'string') return entry.resource.id;
    return null;
  };
  let ids: (string | null)[] = [];
  if (Array.isArray(body.entry)) ids = body.entry.map(fromEntry);
  else if (Array.isArray(body.ids)) ids = body.ids.map((id: unknown) => (typeof id === 'string' || typeof id === 'number' ? String(id) : null));
  else if (count === 1 && typeof body.id === 'string' && body.resourceType !== 'Bundle') ids = [body.id];
  return Array.from({ length: count }, (_, i) => ids[i] ?? null);
}

async function post(settings: ChannelSettings, bundle: unknown) {
  if (!settings.token) throw new Error("The care-team channel has no token, so the values were not sent.");
  let response: globalThis.Response;
  try {
    response = await request(settings, 'POST', settings.valuesUrl, bundle);
  } catch (error) {
    throw new Error(`Could not reach the care team's system${error instanceof Error ? `: ${error.message}` : '.'}`);
  }
  if (!response.ok) {
    const detail = await shortAnswer(response, settings);
    throw new Error(`The care team's system answered ${response.status}${detail ? `: ${detail.slice(0, 120)}` : '.'}`);
  }
  return response.json().catch(() => null);
}

/** Sends the stored values of one report to the care team's system and records the outcome. */
export async function sendValuesToCareTeam(request: ServiceRequestRow, values: StoredValue[]): Promise<ReportResult> {
  const settings = getChannelSettings();
  const ids = values.map((v) => v.id);
  const observations = values.map((v) => ({
    name: v.name,
    transaction_guid: v.transactionGuid ?? v.conceptGuid ?? '',
    value: gatewayValue(v.value, v.responseType),
    recorded_at: v.recordedAt,
    ...(v.note ? { notes: v.note } : {}),
  }));
  let report: SentReport;
  try {
    const answer = await post(settings, toTransactionBundle(values, request));
    const remote = receiptIds(answer, values.length);
    const at = now();
    for (const [i, id] of ids.entries()) {
      run(
        `INSERT INTO careteam_value_receipts (observation_id, remote_id, sent_at) VALUES (:id, :remote, :at)
         ON CONFLICT (observation_id) DO UPDATE SET remote_id = excluded.remote_id, sent_at = excluded.sent_at`,
        { id, remote: remote[i], at },
      );
    }
    const known = remote.filter((id): id is string => !!id);
    report = {
      observations,
      received: true,
      receiptGuid: known.length ? known.join(',') : null,
      stored: known.length || values.length,
      message: `Received by the care team (${values.length} ${values.length === 1 ? 'value' : 'values'}).`,
    };
    log('values', 'delivered', `${values.length} Observation(s) for ServiceRequest/${request.guid}${known.length ? `: ${known.join(', ')}` : ''}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Sending to the care team's system failed.";
    report = { observations, received: false, receiptGuid: null, stored: null, message };
    log('values', 'failed', message);
  }
  setReportOutcome(ids, report.received ? 'sent' : 'failed', report.message, report.received);
  return { observations: getObservations(ids), reportStatus: report.received ? 'sent' : 'failed', reportMessage: report.message, sent: [report] };
}

/** The care team's id for each value sent to it (null: sent, but their answer named no id). */
export function valueReceipt(observationId: number): string | null | undefined {
  return get<{ remote_id: string | null }>('SELECT remote_id FROM careteam_value_receipts WHERE observation_id = :id', { id: observationId })?.remote_id;
}
