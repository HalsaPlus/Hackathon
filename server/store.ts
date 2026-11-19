import { createHash } from 'node:crypto';
import type {
  ActivityView,
  AppView,
  ConnectionView,
  Goal,
  InboundLogEntry,
  MessageView,
  ObservationView,
  PatientSummary,
  PatientView,
  ReportStatus,
  ServiceRequestView,
  Timing,
  Transaction,
} from '../shared/types.ts';
import { all, get, now, run, transaction } from './db.ts';
import type { ParsedCarePlan, ParsedDelivery } from './fhir.ts';
import { parseIps } from './ips.ts';
import { type CdrOutcome, toCommunication } from './messaging.ts';
import { DEFAULT_PLAN_DAYS, describeTiming, longestBounds, occurrences } from './schedule.ts';

// Everything that reads or writes the database.

const DAY = 24 * 60 * 60 * 1000;

// --- Rows -------------------------------------------------------------------------

export interface ConnectionRow {
  id: number;
  name: string;
  base_url: string;
  provider_token: string;
  gateway_url: string | null;
  push_secret: string | null;
  poll_enabled: number;
  feed_since: string | null;
  last_test_at: string | null;
  last_test_ok: number | null;
  last_test_message: string | null;
  last_sync_at: string | null;
  last_sync_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface ServiceRequestRow {
  guid: string;
  connection_id: number | null;
  connection_name: string | null;
  patient_guid: string;
  seen_at: string | null;
  source: 'push' | 'poll' | 'demo';
  status: string | null;
  intent: string | null;
  priority: string | null;
  title: string | null;
  authored_on: string | null;
  period_start: string;
  period_end: string;
  period_end_given: number;
  receipt_token: string | null;
  grant_token: string | null;
  ack_status: string | null;
  pdhc_updated_at: string | null;
  pdhc_status: string | null;
  is_open: number | null;
  care_plan_guid: string | null;
  checksum: string;
  received_at: string;
  updated_at: string;
}

/** sr_status values that mean PDHC has closed the request. */
const CLOSED_STATUSES = new Set(['archived', 'revoked', 'completed', 'cancelled', 'entered-in-error']);

export function isClosed(row: Pick<ServiceRequestRow, 'is_open' | 'pdhc_status'>) {
  return row.is_open === 0 || (row.pdhc_status !== null && CLOSED_STATUSES.has(row.pdhc_status));
}

interface CarePlanRow {
  id: number;
  fhir_id: string | null;
  title: string | null;
  description: string | null;
  status: string | null;
  goals_json: string;
}

export interface ActivityRow {
  care_plan_id: number;
  activity_key: string;
  title: string;
  description: string | null;
  performer_type: string | null;
  status: string | null;
  timing_json: string;
  transactions_json: string;
}

// --- Connections -------------------------------------------------------------------

/**
 * Reports go to gateway.pdhc, not to request.pdhc. When no gateway URL is
 * set, it is derived from the connection's URL.
 */
export function gatewayUrlOf(row: Pick<ConnectionRow, 'gateway_url' | 'base_url'>): string {
  if (row.gateway_url) return row.gateway_url;
  return row.base_url.replace('://request.pdhc.se', '://gateway.pdhc.se');
}

export function toConnectionView(row: ConnectionRow): ConnectionView {
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.base_url,
    gatewayUrl: gatewayUrlOf(row),
    tokenHint: `…${row.provider_token.slice(-4)}`,
    hasPushSecret: !!row.push_secret,
    pollEnabled: row.poll_enabled === 1,
    lastTestAt: row.last_test_at,
    lastTestOk: row.last_test_ok === null ? null : row.last_test_ok === 1,
    lastTestMessage: row.last_test_message,
    lastSyncAt: row.last_sync_at,
    lastSyncMessage: row.last_sync_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listConnections(): ConnectionRow[] {
  return all<ConnectionRow>('SELECT * FROM connections ORDER BY id');
}

export function getConnection(id: number): ConnectionRow | undefined {
  return get<ConnectionRow>('SELECT * FROM connections WHERE id = :id', { id });
}

// --- Inbound log ---------------------------------------------------------------------

export function logInbound(
  channel: InboundLogEntry['channel'],
  connectionId: number | null,
  serviceRequestGuid: string | null,
  outcome: InboundLogEntry['outcome'],
  message: string | null,
) {
  run(
    `INSERT INTO inbound_log (received_at, channel, connection_id, service_request_guid, outcome, message)
     VALUES (:at, :channel, :connectionId, :guid, :outcome, :message)`,
    { at: now(), channel, connectionId, guid: serviceRequestGuid, outcome, message: message?.slice(0, 500) },
  );
  // Keep the log from growing without bound (rejected pushes, for instance).
  run('DELETE FROM inbound_log WHERE id <= (SELECT MAX(id) - 1000 FROM inbound_log)');
}

export function listInboundLog(limit = 50): InboundLogEntry[] {
  return all<{
    id: number;
    received_at: string;
    channel: InboundLogEntry['channel'];
    connection_name: string | null;
    service_request_guid: string | null;
    outcome: InboundLogEntry['outcome'];
    message: string | null;
  }>(
    `SELECT l.*, c.name AS connection_name FROM inbound_log l
     LEFT JOIN connections c ON c.id = l.connection_id
     ORDER BY l.id DESC LIMIT :limit`,
    { limit },
  ).map((row) => ({
    id: row.id,
    receivedAt: row.received_at,
    channel: row.channel,
    connectionName: row.connection_name,
    serviceRequestGuid: row.service_request_guid,
    outcome: row.outcome,
    message: row.message,
  }));
}

// --- Storing a delivery ----------------------------------------------------------------

export interface StoreOptions {
  channel: 'push' | 'poll' | 'demo';
  connectionId: number | null;
  matchGuid?: string;
  pdhcUpdatedAt?: string;
}

function checksumOf(parsed: ParsedDelivery) {
  // The activities are included because they also depend on the plan template
  // on plan.pdhc, which can change, or be readable now when it was not before.
  const content = JSON.stringify([
    parsed.serviceRequest,
    parsed.carePlans.map((p) => [p.fhir, p.activities]),
    parsed.patient.fhir ?? null,
  ]);
  return createHash('sha256').update(content).digest('hex');
}

/** Start and end of the plan. PDHC normally sends occurrencePeriod; if not, a sensible default. */
function resolvePeriod(parsed: ParsedDelivery) {
  const start = Date.parse(parsed.periodStart ?? parsed.authoredOn ?? '') || Date.now();
  const givenEnd = Date.parse(parsed.periodEnd ?? '');
  if (!Number.isNaN(givenEnd) && givenEnd > start) {
    return { start: new Date(start).toISOString(), end: new Date(givenEnd).toISOString(), endGiven: true };
  }
  const timings = parsed.carePlans.flatMap((plan) => plan.activities.map((a) => a.timing));
  const length = Math.max(longestBounds(timings), DEFAULT_PLAN_DAYS * DAY);
  return { start: new Date(start).toISOString(), end: new Date(start + length).toISOString(), endGiven: false };
}

function insertCarePlan(serviceRequestGuid: string, carePlan: ParsedCarePlan) {
  const result = run(
    `INSERT INTO care_plans (service_request_guid, fhir_id, title, description, status, goals_json, fhir_json)
     VALUES (:guid, :fhirId, :title, :description, :status, :goals, :fhir)`,
    {
      guid: serviceRequestGuid,
      fhirId: carePlan.fhirId,
      title: carePlan.title,
      description: carePlan.description,
      status: carePlan.status,
      goals: JSON.stringify(carePlan.goals),
      fhir: JSON.stringify(carePlan.fhir),
    },
  );
  carePlan.activities.forEach((activity, position) => {
    run(
      `INSERT INTO activities (care_plan_id, position, activity_key, title, description, performer_type, status, timing_json, transactions_json)
       VALUES (:carePlanId, :position, :key, :title, :description, :performer, :status, :timing, :transactions)`,
      {
        carePlanId: Number(result.lastInsertRowid),
        position,
        key: activity.key,
        title: activity.title,
        description: activity.description,
        performer: activity.performerType,
        status: activity.status,
        timing: JSON.stringify(activity.timing),
        transactions: JSON.stringify(activity.transactions),
      },
    );
  });
}

/**
 * Saves a parsed delivery. The same ServiceRequest delivered again replaces
 * the care plan if anything changed; stops already marked as done are kept.
 */
export function storeDelivery(parsed: ParsedDelivery, options: StoreOptions): 'created' | 'updated' | 'unchanged' {
  const checksum = checksumOf(parsed);
  const period = resolvePeriod(parsed);
  const timestamp = now();

  return transaction(() => {
    run(
      `INSERT INTO patients (guid, display_name, birth_date, gender, fhir_json, created_at, updated_at)
       VALUES (:guid, :name, :birthDate, :gender, :fhir, :at, :at)
       ON CONFLICT (guid) DO UPDATE SET
         display_name = COALESCE(excluded.display_name, display_name),
         birth_date   = COALESCE(excluded.birth_date, birth_date),
         gender       = COALESCE(excluded.gender, gender),
         fhir_json    = COALESCE(excluded.fhir_json, fhir_json),
         updated_at   = excluded.updated_at`,
      {
        guid: parsed.patient.guid,
        name: parsed.patient.displayName,
        birthDate: parsed.patient.birthDate,
        gender: parsed.patient.gender,
        fhir: parsed.patient.fhir ? JSON.stringify(parsed.patient.fhir) : null,
        at: timestamp,
      },
    );

    const existing = get<ServiceRequestRow>('SELECT * FROM service_requests WHERE guid = :guid', { guid: parsed.guid });

    // Keys may arrive later than the request (a push first, a download later),
    // so they are updated even when nothing else changed.
    const keys = {
      guid: parsed.guid,
      connectionId: options.connectionId ?? existing?.connection_id ?? null,
      receiptToken: parsed.receiptToken ?? existing?.receipt_token ?? null,
      grantToken: parsed.grantToken ?? existing?.grant_token ?? null,
      pdhcUpdatedAt: options.pdhcUpdatedAt ?? existing?.pdhc_updated_at ?? null,
      // PDHC's status lives outside the FHIR resource, so it can change while
      // the resource does not.
      pdhcStatus: parsed.pdhcStatus ?? existing?.pdhc_status ?? null,
      isOpen: parsed.isOpen ?? (existing?.is_open == null ? null : existing.is_open === 1),
      carePlanGuid: parsed.carePlanGuid ?? existing?.care_plan_guid ?? null,
    };

    if (existing && existing.checksum === checksum) {
      run(
        `UPDATE service_requests SET connection_id = :connectionId, receipt_token = :receiptToken,
           grant_token = :grantToken, pdhc_updated_at = :pdhcUpdatedAt, pdhc_status = :pdhcStatus,
           is_open = :isOpen, care_plan_guid = :carePlanGuid WHERE guid = :guid`,
        keys,
      );
      return 'unchanged';
    }

    const values = {
      ...keys,
      patientGuid: parsed.patient.guid,
      source: options.channel,
      status: parsed.status,
      intent: parsed.intent,
      priority: parsed.priority,
      title: parsed.title,
      authoredOn: parsed.authoredOn,
      periodStart: period.start,
      periodEnd: period.end,
      periodEndGiven: period.endGiven,
      contractGuid: parsed.contractGuid,
      providerOrgGuid: parsed.providerOrgGuid,
      matchGuid: options.matchGuid ?? null,
      checksum,
      fhir: JSON.stringify(parsed.serviceRequest),
      at: timestamp,
    };

    if (existing) {
      run(
        `UPDATE service_requests SET connection_id = :connectionId, patient_guid = :patientGuid, source = :source,
           status = :status, intent = :intent, priority = :priority, title = :title, authored_on = :authoredOn,
           period_start = :periodStart, period_end = :periodEnd, period_end_given = :periodEndGiven,
           contract_guid = :contractGuid, provider_org_guid = :providerOrgGuid, match_guid = COALESCE(:matchGuid, match_guid),
           receipt_token = :receiptToken, grant_token = :grantToken, pdhc_updated_at = :pdhcUpdatedAt,
           pdhc_status = :pdhcStatus, is_open = :isOpen, care_plan_guid = :carePlanGuid,
           checksum = :checksum, fhir_json = :fhir, updated_at = :at
         WHERE guid = :guid`,
        values,
      );
      run('DELETE FROM care_plans WHERE service_request_guid = :guid', { guid: parsed.guid });
    } else {
      run(
        `INSERT INTO service_requests (guid, connection_id, patient_guid, source, status, intent, priority, title,
           authored_on, period_start, period_end, period_end_given, contract_guid, provider_org_guid, match_guid,
           receipt_token, grant_token, pdhc_updated_at, pdhc_status, is_open, care_plan_guid, checksum, fhir_json,
           received_at, updated_at)
         VALUES (:guid, :connectionId, :patientGuid, :source, :status, :intent, :priority, :title,
           :authoredOn, :periodStart, :periodEnd, :periodEndGiven, :contractGuid, :providerOrgGuid, :matchGuid,
           :receiptToken, :grantToken, :pdhcUpdatedAt, :pdhcStatus, :isOpen, :carePlanGuid, :checksum, :fhir,
           :at, :at)`,
        values,
      );
    }
    for (const carePlan of parsed.carePlans) insertCarePlan(parsed.guid, carePlan);
    // The patient sees a new plan as a note in the chat, linking to it.
    if (!existing) addMessage(parsed.patient.guid, 'system', 'New plan from the care team', parsed.guid, timestamp);
    return existing ? 'updated' : 'created';
  });
}

/** Requests fetched through this connection's feed that MMD still treats as open. */
export function openRequestGuids(connectionId: number): string[] {
  return all<Pick<ServiceRequestRow, 'guid' | 'is_open' | 'pdhc_status'>>(
    "SELECT guid, is_open, pdhc_status FROM service_requests WHERE connection_id = :connectionId AND source = 'poll'",
    { connectionId },
  )
    .filter((row) => !isClosed(row))
    .map((row) => row.guid);
}

/** Saves what PDHC says about a request's state, without touching the plan. */
export function setPdhcState(guid: string, state: { status: string | null; isOpen: boolean | null; carePlanGuid?: string | null }) {
  run(
    `UPDATE service_requests SET pdhc_status = COALESCE(:status, pdhc_status), is_open = COALESCE(:isOpen, is_open),
       care_plan_guid = COALESCE(:carePlanGuid, care_plan_guid), updated_at = :at WHERE guid = :guid`,
    { guid, status: state.status, isOpen: state.isOpen, carePlanGuid: state.carePlanGuid ?? null, at: now() },
  );
  return isClosed(get<ServiceRequestRow>('SELECT * FROM service_requests WHERE guid = :guid', { guid }) ?? { is_open: null, pdhc_status: null });
}

export function setAckStatus(guid: string, status: string) {
  run('UPDATE service_requests SET ack_status = :status WHERE guid = :guid', { guid, status });
}

export function serviceRequestPdhcUpdatedAt(guid: string): string | null | undefined {
  return get<{ pdhc_updated_at: string | null }>('SELECT pdhc_updated_at FROM service_requests WHERE guid = :guid', { guid })
    ?.pdhc_updated_at;
}

// --- Stops done ------------------------------------------------------------------------

export function activityStops(serviceRequestGuid: string, activityKey: string) {
  const request = get<ServiceRequestRow>('SELECT * FROM service_requests WHERE guid = :guid', { guid: serviceRequestGuid });
  if (!request) return undefined;
  const activity = get<ActivityRow>(
    `SELECT a.* FROM activities a JOIN care_plans c ON c.id = a.care_plan_id
     WHERE c.service_request_guid = :guid AND a.activity_key = :key`,
    { guid: serviceRequestGuid, key: activityKey },
  );
  if (!activity) return undefined;
  return occurrences(JSON.parse(activity.timing_json) as Timing, new Date(request.period_start), new Date(request.period_end)).dates;
}

export function setPerformed(
  serviceRequestGuid: string,
  activityKey: string,
  index: number,
  performed: boolean,
  source: 'patient' | 'demo' = 'patient',
) {
  if (performed) {
    run(
      `INSERT INTO performances (service_request_guid, activity_key, stop_index, performed_at, source)
       VALUES (:guid, :key, :index, :at, :source)
       ON CONFLICT (service_request_guid, activity_key, stop_index) DO NOTHING`,
      { guid: serviceRequestGuid, key: activityKey, index, at: now(), source },
    );
  } else {
    run('DELETE FROM performances WHERE service_request_guid = :guid AND activity_key = :key AND stop_index = :index', {
      guid: serviceRequestGuid,
      key: activityKey,
      index,
    });
  }
}

export function seedPerformance(serviceRequestGuid: string, activityKey: string, index: number, performedAt: string) {
  run(
    `INSERT INTO performances (service_request_guid, activity_key, stop_index, performed_at, source)
     VALUES (:guid, :key, :index, :at, 'demo')
     ON CONFLICT (service_request_guid, activity_key, stop_index) DO UPDATE SET performed_at = excluded.performed_at`,
    { guid: serviceRequestGuid, key: activityKey, index, at: performedAt },
  );
}

export function clearPerformances(serviceRequestGuid: string) {
  run('DELETE FROM performances WHERE service_request_guid = :guid', { guid: serviceRequestGuid });
}

// --- Views for the web app -----------------------------------------------------------------

export function listPatients(): PatientSummary[] {
  return all<{
    guid: string;
    display_name: string | null;
    birth_date: string | null;
    gender: string | null;
    updated_at: string;
    request_count: number;
    latest_title: string | null;
  }>(
    `SELECT p.guid, p.display_name, p.birth_date, p.gender, p.updated_at,
       (SELECT COUNT(*) FROM service_requests s WHERE s.patient_guid = p.guid) AS request_count,
       (SELECT s.title FROM service_requests s WHERE s.patient_guid = p.guid ORDER BY s.received_at DESC LIMIT 1) AS latest_title
     FROM patients p ORDER BY p.updated_at DESC`,
  ).map((row) => ({
    guid: row.guid,
    displayName: row.display_name,
    birthDate: row.birth_date,
    gender: row.gender,
    requestCount: row.request_count,
    latestRequestTitle: row.latest_title,
    updatedAt: row.updated_at,
  }));
}

function requestView(row: ServiceRequestRow): ServiceRequestView {
  const carePlans = all<CarePlanRow>('SELECT * FROM care_plans WHERE service_request_guid = :guid ORDER BY id', {
    guid: row.guid,
  });
  const planIdOf = (plan: CarePlanRow) => plan.fhir_id ?? `plan-${plan.id}`;
  const performed = new Map<string, string>();
  for (const p of all<{ activity_key: string; stop_index: number; performed_at: string }>(
    'SELECT activity_key, stop_index, performed_at FROM performances WHERE service_request_guid = :guid',
    { guid: row.guid },
  )) {
    performed.set(`${p.activity_key}#${p.stop_index}`, p.performed_at);
  }

  const start = new Date(row.period_start);
  const end = new Date(row.period_end);
  const activities: ActivityView[] = carePlans.flatMap((plan, planIndex) =>
    all<ActivityRow>('SELECT * FROM activities WHERE care_plan_id = :id ORDER BY position', { id: plan.id }).map(
        (activity) => {
          const timing = JSON.parse(activity.timing_json) as Timing;
          const { dates, truncated } = occurrences(timing, start, end);
          return {
            key: activity.activity_key,
            planId: planIdOf(plan),
            planIndex,
            title: activity.title,
            description: activity.description,
            performerType: activity.performer_type,
            status: activity.status,
            schedule: describeTiming(timing),
            timing,
            transactions: JSON.parse(activity.transactions_json) as Transaction[],
            stops: dates.map((date, index) => ({
              index,
              dueAt: date.toISOString(),
              performedAt: performed.get(`${activity.activity_key}#${index}`) ?? null,
            })),
            truncated,
          };
        },
      ),
  );

  return {
    guid: row.guid,
    title: row.title,
    status: row.status,
    intent: row.intent,
    priority: row.priority,
    source: row.source,
    connectionName: row.connection_name,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    periodEndGiven: row.period_end_given === 1,
    authoredOn: row.authored_on,
    receivedAt: row.received_at,
    updatedAt: row.updated_at,
    ackStatus: row.ack_status,
    hasGrantToken: !!row.grant_token,
    pdhcStatus: row.pdhc_status,
    closed: isClosed(row),
    carePlanGuid: row.care_plan_guid,
    seenAt: row.seen_at,
    carePlans: carePlans.map((plan) => ({
      id: planIdOf(plan),
      title: plan.title,
      description: plan.description,
      status: plan.status,
      goals: JSON.parse(plan.goals_json) as Goal[],
    })),
    activities,
  };
}

export function getPatientView(guid: string): PatientView | undefined {
  const patient = get<{
    guid: string;
    display_name: string | null;
    birth_date: string | null;
    gender: string | null;
    updated_at: string;
  }>('SELECT guid, display_name, birth_date, gender, updated_at FROM patients WHERE guid = :guid', { guid });
  if (!patient) return undefined;
  const requests = all<ServiceRequestRow>(
    `SELECT s.*, c.name AS connection_name FROM service_requests s
     LEFT JOIN connections c ON c.id = s.connection_id
     WHERE s.patient_guid = :guid ORDER BY s.received_at DESC`,
    { guid },
  ).map(requestView);
  return {
    patient: {
      guid: patient.guid,
      displayName: patient.display_name,
      birthDate: patient.birth_date,
      gender: patient.gender,
      updatedAt: patient.updated_at,
    },
    requests,
  };
}

// --- The patient app -------------------------------------------------------------------

export function getServiceRequestRow(guid: string): ServiceRequestRow | undefined {
  return get<ServiceRequestRow>(
    `SELECT s.*, c.name AS connection_name FROM service_requests s
     LEFT JOIN connections c ON c.id = s.connection_id WHERE s.guid = :guid`,
    { guid },
  );
}

/** One activity in a request, with the id of the care plan it belongs to. */
export function getActivity(serviceRequestGuid: string, activityKey: string) {
  return get<ActivityRow & { plan_fhir_id: string | null; plan_row_id: number }>(
    `SELECT a.*, c.fhir_id AS plan_fhir_id, c.id AS plan_row_id FROM activities a
     JOIN care_plans c ON c.id = a.care_plan_id
     WHERE c.service_request_guid = :guid AND a.activity_key = :key`,
    { guid: serviceRequestGuid, key: activityKey },
  );
}

export function markSeen(serviceRequestGuid: string) {
  run('UPDATE service_requests SET seen_at = COALESCE(seen_at, :at) WHERE guid = :guid', { guid: serviceRequestGuid, at: now() });
}

export function addMessage(
  patientGuid: string,
  sender: MessageView['sender'],
  text: string,
  serviceRequestGuid: string | null = null,
  at: string = now(),
): MessageView {
  const result = run(
    `INSERT INTO messages (patient_guid, sender, text, service_request_guid, created_at)
     VALUES (:patient, :sender, :text, :sr, :at)`,
    { patient: patientGuid, sender, text: text.slice(0, 2000), sr: serviceRequestGuid, at },
  );
  const id = Number(result.lastInsertRowid);
  // Keep every message as a FHIR R5 Communication too.
  const communication = toCommunication({ id, patientGuid, sender, text, serviceRequestGuid, createdAt: at });
  run('UPDATE messages SET fhir_json = :fhir WHERE id = :id', { id, fhir: JSON.stringify(communication) });
  return { id, sender, text, serviceRequestGuid, createdAt: at, cdrStatus: null };
}

export function setMessageCdrOutcome(id: number, outcome: CdrOutcome) {
  run('UPDATE messages SET cdr_status = :status, cdr_message = :message WHERE id = :id', {
    id,
    status: outcome.status,
    message: outcome.message,
  });
}

/** The chat as FHIR Communications, for the control tower's dashboard. */
export function listCommunications(patientGuid: string | null) {
  const rows = all<{ fhir_json: string | null }>(
    `SELECT fhir_json FROM messages WHERE fhir_json IS NOT NULL ${patientGuid ? 'AND patient_guid = :p' : ''}
     ORDER BY created_at DESC LIMIT 500`,
    patientGuid ? { p: patientGuid } : {},
  );
  return rows.map((row) => JSON.parse(row.fhir_json!) as unknown);
}

export interface NewObservation {
  patientGuid: string;
  serviceRequestGuid: string;
  activityKey: string;
  stopIndex: number | null;
  name: string;
  transactionGuid: string | null;
  conceptGuid: string | null;
  value: string;
  unit: string | null;
  recordedAt: string;
  device: string | null;
  carePlanRef: string | null;
  planDay: number | null;
  note: string | null;
  reportStatus: ReportStatus;
  reportMessage: string | null;
  confirmed: boolean;
}

/** The source app in every stamp. The PAT tells PDHC the same thing on its side. */
export const SOURCE_APP = 'MMD';

export function insertObservation(o: NewObservation): number {
  const result = run(
    `INSERT INTO observations (patient_guid, service_request_guid, activity_key, stop_index, name, transaction_guid,
       concept_guid, value, unit, recorded_at, patient_reported, source_app, device, care_plan_ref, plan_day, note,
       report_status, report_message, reported_at, confirmed)
     VALUES (:patient, :sr, :key, :stop, :name, :tx, :concept, :value, :unit, :at, 1, :app, :device, :plan, :day, :note,
       :status, :message, :reportedAt, :confirmed)`,
    {
      patient: o.patientGuid,
      sr: o.serviceRequestGuid,
      key: o.activityKey,
      stop: o.stopIndex,
      name: o.name,
      tx: o.transactionGuid,
      concept: o.conceptGuid,
      value: o.value,
      unit: o.unit,
      at: o.recordedAt,
      app: SOURCE_APP,
      device: o.device,
      plan: o.carePlanRef,
      day: o.planDay,
      note: o.note,
      status: o.reportStatus,
      message: o.reportMessage,
      reportedAt: o.reportStatus === 'pending' ? null : o.recordedAt,
      confirmed: o.confirmed,
    },
  );
  return Number(result.lastInsertRowid);
}

export function setReportOutcome(ids: number[], status: ReportStatus, message: string, confirmed: boolean) {
  for (const id of ids) {
    run(
      `UPDATE observations SET report_status = :status, report_message = :message, reported_at = :at, confirmed = :confirmed
       WHERE id = :id`,
      { id, status, message, at: now(), confirmed },
    );
  }
}

interface ObservationRow {
  id: number;
  service_request_guid: string;
  activity_key: string;
  stop_index: number | null;
  name: string;
  value: string;
  unit: string | null;
  recorded_at: string;
  patient_reported: number;
  source_app: string;
  device: string | null;
  care_plan_ref: string | null;
  plan_day: number | null;
  report_status: ReportStatus;
  report_message: string | null;
  confirmed: number;
}

function toObservationView(row: ObservationRow): ObservationView {
  return {
    id: row.id,
    serviceRequestGuid: row.service_request_guid,
    activityKey: row.activity_key,
    stopIndex: row.stop_index,
    name: row.name,
    value: row.value,
    unit: row.unit,
    recordedAt: row.recorded_at,
    patientReported: row.patient_reported === 1,
    sourceApp: row.source_app,
    device: row.device,
    carePlanRef: row.care_plan_ref,
    planDay: row.plan_day,
    reportStatus: row.report_status,
    reportMessage: row.report_message,
    confirmed: row.confirmed === 1,
  };
}

export function getObservations(ids: number[]): ObservationView[] {
  return ids
    .map((id) => get<ObservationRow>('SELECT * FROM observations WHERE id = :id', { id }))
    .filter((row): row is ObservationRow => !!row)
    .map(toObservationView);
}

/** Stores the patient's latest IPS, fetched through Health Connect (or synthetic in the demo). */
export function saveIps(patientGuid: string, bundle: unknown, source: string, synthetic: boolean) {
  run(
    `INSERT INTO ips_documents (patient_guid, source, synthetic, bundle_json, fetched_at)
     VALUES (:patient, :source, :synthetic, :bundle, :at)
     ON CONFLICT (patient_guid) DO UPDATE SET source = excluded.source, synthetic = excluded.synthetic,
       bundle_json = excluded.bundle_json, fetched_at = excluded.fetched_at`,
    { patient: patientGuid, source, synthetic, bundle: JSON.stringify(bundle), at: now() },
  );
}

/** Removes what the demo seeded for a patient, so the demo can be recreated with fresh dates. */
export function clearPatientAppData(patientGuid: string) {
  run('DELETE FROM observations WHERE patient_guid = :p', { p: patientGuid });
  run('DELETE FROM messages WHERE patient_guid = :p', { p: patientGuid });
  run('DELETE FROM ips_documents WHERE patient_guid = :p', { p: patientGuid });
}

/** Everything the patient app shows, in one call. */
export function getAppView(patientGuid: string): AppView | undefined {
  const view = getPatientView(patientGuid);
  if (!view) return undefined;
  const since = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000).toISOString();
  const observations = all<ObservationRow>(
    'SELECT * FROM observations WHERE patient_guid = :p AND recorded_at >= :since ORDER BY recorded_at',
    { p: patientGuid, since },
  ).map(toObservationView);
  const ipsRow = get<{ source: string; synthetic: number; bundle_json: string; fetched_at: string }>(
    'SELECT source, synthetic, bundle_json, fetched_at FROM ips_documents WHERE patient_guid = :p',
    { p: patientGuid },
  );
  const ips = ipsRow ? parseIps(JSON.parse(ipsRow.bundle_json), ipsRow.source, ipsRow.synthetic === 1, ipsRow.fetched_at) : null;
  const messages: MessageView[] = all<{
    id: number;
    sender: MessageView['sender'];
    text: string;
    service_request_guid: string | null;
    created_at: string;
    cdr_status: MessageView['cdrStatus'];
  }>('SELECT * FROM messages WHERE patient_guid = :p ORDER BY created_at, id', { p: patientGuid }).map((row) => ({
    id: row.id,
    sender: row.sender,
    text: row.text,
    serviceRequestGuid: row.service_request_guid,
    createdAt: row.created_at,
    cdrStatus: row.cdr_status,
  }));
  return { patient: view.patient, requests: view.requests, observations, ips, messages };
}
