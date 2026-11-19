import type { ReportInput, ReportResult, ReportStatus, Transaction } from '../shared/types.ts';
import { now } from './db.ts';
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

export async function reportStop(patientGuid: string, input: ReportInput): Promise<ReportResult> {
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

  const recordedAt = now();
  const planDay = Math.floor((Date.now() - Date.parse(request.period_start)) / DAY) + 1;
  const note = clean(input.note, 500) || null;
  const ids = values.map((v) =>
    insertObservation({
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
      note,
      reportStatus: 'pending',
      reportMessage: null,
      confirmed: false,
    }),
  );
  setPerformed(request.guid, activity.activity_key, index, true);

  let status: ReportStatus;
  let message: string;
  let confirmed = false;
  const connection = request.connection_id !== null ? getConnection(request.connection_id) : undefined;

  if (request.source === 'demo' || !connection) {
    status = 'demo';
    message = 'Demo mode: not sent to PDHC. The confirmation is simulated.';
    confirmed = true;
  } else if (!request.grant_token) {
    status = 'failed';
    message = 'No grant_token for this plan, so PDHC cannot accept the report.';
  } else {
    // The gateway matches each value to the plan by transaction_guid. plan.pdhc
    // does not always send one; the concept GUID is the closest fallback
    // (interpretation, to verify against a real delivery).
    const sendable = values.filter((v) => v.transactionGuid || v.conceptGuid);
    if (sendable.length === 0) {
      status = 'failed';
      message = 'The plan has no transaction or concept ids for these values, so they cannot be matched in PDHC.';
    } else {
      try {
        const answer = await reportToGateway(connection, gatewayUrlOf(connection), request.guid, {
          patient_guid: request.patient_guid,
          grant_token: request.grant_token,
          status: 'in-progress',
          report_payload: {
            observations: sendable.map((v) => ({
              transaction_guid: (v.transactionGuid ?? v.conceptGuid)!,
              value: gatewayValue(v.value, v.responseType),
              recorded_at: recordedAt,
              ...(note ? { notes: note } : {}),
            })),
          },
        });
        status = 'sent';
        confirmed = answer.received;
        message = confirmed
          ? `Received by PDHC${answer.receiptGuid ? ` (receipt ${answer.receiptGuid})` : ''}.`
          : `Sent. PDHC answered "${answer.status}".`;
      } catch (error) {
        status = 'failed';
        message = error instanceof Error ? error.message : 'Sending to PDHC failed.';
      }
    }
  }

  setReportOutcome(ids, status, message, confirmed);
  return { observations: getObservations(ids), reportStatus: status, reportMessage: message };
}
