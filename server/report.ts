import type { ReportInput, ReportResult, ReportStatus, SentReport, Transaction } from '../shared/types.ts';
import { gatewayValue, reportToGateway } from './pdhc.ts';
import {
  activityStops,
  gatewayUrlOf,
  getActivity,
  getConnection,
  getObservations,
  getServiceRequestRow,
  insertObservation,
  isClosed,
  setPerformed,
  setReportOutcome,
} from './store.ts';

// Step 6–7 of the flow: the patient reports a stop. The values are stored with
// the stamp (patient reported, source MMD, device, plan and day in the plan),
// the stop is marked done, and the values go to gateway.pdhc when the request
// came through a real connection. A demo request stays in demo mode and says so.

const DAY = 24 * 60 * 60 * 1000;

export class ReportError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

function clean(value: unknown, max: number) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

/** Only for reports MMD makes itself (the admin console's test button), never from the patient app's input. */
export interface ReportOptions {
  /** Send each value in a report of its own, with its own recorded_at. */
  onePerReport?: boolean;
  /** A note per value instead of the one in the input. */
  noteFor?: (value: { name: string; value: string; unit: string | null }) => string;
}

export async function reportStop(patientGuid: string, input: ReportInput, options: ReportOptions = {}): Promise<ReportResult> {
  const request = getServiceRequestRow(clean(input.serviceRequestGuid, 100));
  if (!request || request.patient_guid !== patientGuid) throw new ReportError('The plan was not found.', 404);
  if (isClosed(request)) throw new ReportError('This plan has been closed by the care team, so it no longer takes reports.', 409);
  const activity = getActivity(request.guid, clean(input.activityKey, 200));
  if (!activity) throw new ReportError('The activity was not found.', 404);
  const stops = activityStops(request.guid, activity.activity_key) ?? [];
  const index = Number(input.stopIndex);
  if (!Number.isSafeInteger(index) || index < 0 || index >= stops.length) throw new ReportError('The stop is not on the line.');
  if (stops[index].getTime() > Date.now() + DAY) throw new ReportError('This stop is still in the future.');

  const transactions = JSON.parse(activity.transactions_json) as Transaction[];
  const values = (Array.isArray(input.values) ? input.values : []).slice(0, 20).map((v) => {
    const name = clean(v.name, 120);
    const known = transactions.find((t) => t.name === name);
    return {
      name: name || activity.title,
      value: clean(v.value, 200),
      unit: clean(v.unit, 40) || known?.unit || null,
      transactionGuid: known?.transactionGuid ?? null,
      responseType: known?.responseType,
      conceptGuid: known?.conceptGuid ?? null,
      device: clean(v.device, 80) || null,
    };
  });
  // An activity with nothing to measure is reported as simply done.
  if (values.length === 0) values.push({ name: activity.title, value: 'done', unit: null, transactionGuid: null, responseType: undefined, conceptGuid: null, device: null });
  if (values.some((v) => !v.value)) throw new ReportError('Every value needs to be filled in.');

  const startedAt = Date.now();
  const planDay = Math.floor((startedAt - Date.parse(request.period_start)) / DAY) + 1;
  const note = clean(input.note, 500) || null;
  const stored = values.map((v, i) => {
    // One value per report: each gets its own time, a second apart, so no two
    // values from the same stop share recorded_at at PDHC.
    const recordedAt = options.onePerReport ? new Date(startedAt + i * 1000).toISOString() : new Date(startedAt).toISOString();
    const valueNote = options.noteFor?.(v) ?? note;
    const id = insertObservation({
      patientGuid,
      serviceRequestGuid: request.guid,
      activityKey: activity.activity_key,
      stopIndex: index,
      name: v.name,
      transactionGuid: v.transactionGuid,
      conceptGuid: v.conceptGuid,
      value: v.value,
      unit: v.unit,
      recordedAt,
      device: v.device,
      carePlanRef: activity.plan_fhir_id,
      planDay,
      note: valueNote,
      reportStatus: 'pending',
      reportMessage: null,
      confirmed: false,
    });
    return { ...v, id, recordedAt, note: valueNote };
  });
  const ids = stored.map((v) => v.id);
  setPerformed(request.guid, activity.activity_key, index, true);

  const connection = request.connection_id !== null ? getConnection(request.connection_id) : undefined;
  if (request.source === 'demo' || !connection) {
    const message = 'Demo mode: not sent to PDHC. The confirmation is simulated.';
    setReportOutcome(ids, 'demo', message, true);
    return { observations: getObservations(ids), reportStatus: 'demo', reportMessage: message, sent: [] };
  }
  if (!request.grant_token) {
    const message = 'No grant_token for this plan, so PDHC cannot accept the report.';
    setReportOutcome(ids, 'failed', message, false);
    return { observations: getObservations(ids), reportStatus: 'failed', reportMessage: message, sent: [] };
  }

  // The gateway matches each value to the plan by transaction_guid; without
  // one, the concept GUID is the closest fallback (not tried against PDHC).
  const sendable = stored.filter((v) => v.transactionGuid || v.conceptGuid);
  if (sendable.length === 0) {
    const message = 'The plan has no transaction or concept ids for these values, so they cannot be matched in PDHC.';
    setReportOutcome(ids, 'failed', message, false);
    return { observations: getObservations(ids), reportStatus: 'failed', reportMessage: message, sent: [] };
  }

  const batches = options.onePerReport ? sendable.map((v) => [v]) : [sendable];
  const sent: SentReport[] = [];
  let failed = 0;
  for (const batch of batches) {
    const observations = batch.map((v) => ({
      name: v.name,
      transaction_guid: (v.transactionGuid ?? v.conceptGuid)!,
      value: gatewayValue(v.value, v.responseType),
      recorded_at: v.recordedAt,
      ...(v.note ? { notes: v.note } : {}),
    }));
    let report: SentReport;
    let threw = false;
    try {
      const answer = await reportToGateway(connection, gatewayUrlOf(connection), request.guid, {
        patient_guid: request.patient_guid,
        grant_token: request.grant_token,
        status: 'in-progress',
        report_payload: { observations: observations.map(({ name: _name, ...o }) => o) },
      });
      const details = [answer.receiptGuid && `receipt ${answer.receiptGuid}`, answer.stored !== null && `${answer.stored} stored`].filter(Boolean);
      report = {
        observations,
        received: answer.received,
        receiptGuid: answer.receiptGuid,
        stored: answer.stored,
        message: answer.received
          ? `Received by PDHC${details.length ? ` (${details.join(', ')})` : ''}.`
          : `Sent. PDHC answered "${answer.status}".`,
      };
    } catch (error) {
      threw = true;
      failed += 1;
      report = {
        observations,
        received: false,
        receiptGuid: null,
        stored: null,
        message: error instanceof Error ? error.message : 'Sending to PDHC failed.',
      };
    }
    sent.push(report);
    // Every value carries the outcome of the call it went in.
    setReportOutcome(
      batch.map((v) => v.id),
      threw ? 'failed' : 'sent',
      report.message,
      report.received,
    );
  }

  const status: ReportStatus = failed === sent.length ? 'failed' : 'sent';
  const message =
    sent.length === 1
      ? sent[0].message
      : failed === 0
        ? `Received by PDHC: ${sent.filter((s) => s.received).length} of ${sent.length} reports.`
        : `${failed} of ${sent.length} reports failed: ${sent.find((s) => !s.received)?.message ?? ''}`;
  return { observations: getObservations(ids), reportStatus: status, reportMessage: message, sent };
}
