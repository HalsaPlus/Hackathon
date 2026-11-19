import type { ActivityView, TestReportResult, Transaction } from '../shared/types.ts';
import { all } from './db.ts';
import { reportStop } from './report.ts';
import { getPatientView } from './store.ts';

// Test data for the round trip to PDHC, from the admin console's "Send test
// observations" button. For every open request from a connection, one set of
// synthetic values per activity is reported exactly as if the patient had done
// it in the app: same stamping (patient reported, source MMD), same stop on
// the line, same call to gateway.pdhc with the request's grant_token and the
// care plan's transaction GUIDs. A note says it is test data, and it travels
// to PDHC with every value.
//
// The values differ from click to click and now and then fall outside the
// plan's range (a glucose above 8, a short night), so the receiving side sees
// realistic data and not the same numbers every time.

const DAY = 24 * 60 * 60 * 1000;

export const TEST_NOTE = 'Testdata från MMD:s admin-konsol (syntetisk).';

interface Rule {
  min: number;
  max: number;
  decimals: number;
}

/** Realistic spreads for what the plans measure, a little wider than the plan's own range. */
const RULES: [RegExp, Rule][] = [
  [/glu[ck]os|blood ?sugar|blodsocker|\bcgm\b/i, { min: 4.4, max: 9.8, decimals: 1 }],
  [/sleep|sömn/i, { min: 4.8, max: 8.9, decimals: 1 }],
  [/systol/i, { min: 104, max: 148, decimals: 0 }],
  [/diastol/i, { min: 62, max: 94, decimals: 0 }],
  [/heart ?rate|pulse|puls/i, { min: 54, max: 96, decimals: 0 }],
  // Self-rated on 0–10.
  [/anxiety|ångest|stress|pain|smärta|fatigue|trötthet|mood|humör/i, { min: 0, max: 10, decimals: 0 }],
];

function fromRange(t: Transaction): Rule {
  if (t.rangeMin !== undefined && t.rangeMax !== undefined && t.rangeMax > t.rangeMin) {
    const span = t.rangeMax - t.rangeMin;
    return {
      min: t.rangeMin >= 0 ? Math.max(0, t.rangeMin - span * 0.1) : t.rangeMin - span * 0.1,
      max: t.rangeMax + span * 0.15,
      decimals: span < 20 ? 1 : 0,
    };
  }
  return { min: 0, max: 10, decimals: 0 };
}

/** One synthetic value for a transaction. `random` is injectable for tests. */
export function testValue(t: Transaction, random: () => number = Math.random): string {
  const rule = RULES.find(([pattern]) => pattern.test(t.name))?.[1] ?? fromRange(t);
  return (rule.min + random() * (rule.max - rule.min)).toFixed(rule.decimals);
}

/**
 * The stop to report: the latest one already due, or else the next one if it
 * is due within a day (the same limit reportStop has for the patient app).
 */
function reportableStop(activity: ActivityView) {
  const now = Date.now();
  return (
    activity.stops.filter((s) => Date.parse(s.dueAt) <= now).at(-1) ??
    activity.stops.find((s) => Date.parse(s.dueAt) <= now + DAY)
  );
}

/**
 * Sends one set of test values per activity for every open request that came
 * through this connection. Closed requests and demo requests are left out.
 */
export async function sendTestReports(connectionId: number, random: () => number = Math.random): Promise<TestReportResult[]> {
  const rows = all<{ guid: string; patient_guid: string }>(
    "SELECT guid, patient_guid FROM service_requests WHERE connection_id = :connectionId AND source <> 'demo' ORDER BY received_at",
    { connectionId },
  );
  const results: TestReportResult[] = [];

  for (const row of rows) {
    const view = getPatientView(row.patient_guid);
    const request = view?.requests.find((r) => r.guid === row.guid);
    if (!view || !request || request.closed) continue;

    for (const activity of request.activities) {
      const base = {
        serviceRequestGuid: request.guid,
        patientName: view.patient.displayName,
        planTitle: request.carePlans[activity.planIndex]?.title ?? request.title,
        activity: activity.title,
      };
      const stop = reportableStop(activity);
      const skip = (message: string) =>
        results.push({ ...base, stopIndex: null, stopDueAt: null, values: [], status: 'skipped', message });
      if (!activity.transactions.length) {
        skip('Nothing to measure in this activity.');
        continue;
      }
      if (!stop) {
        skip(activity.timing.kind === 'unscheduled' ? 'The plan gives this activity no schedule, so it has no stops.' : 'No stop is due yet.');
        continue;
      }

      const values = activity.transactions.map((t) => ({ name: t.name, value: testValue(t, random) }));
      try {
        const result = await reportStop(row.patient_guid, {
          serviceRequestGuid: request.guid,
          activityKey: activity.key,
          stopIndex: stop.index,
          values,
          note: TEST_NOTE,
        });
        results.push({
          ...base,
          stopIndex: stop.index,
          stopDueAt: stop.dueAt,
          values: result.observations.map((o) => ({
            name: o.name,
            value: o.value,
            unit: o.unit,
            transactionGuid: activity.transactions.find((t) => t.name === o.name)?.transactionGuid ?? null,
          })),
          status: result.reportStatus,
          message: result.reportMessage,
        });
      } catch (error) {
        results.push({
          ...base,
          stopIndex: stop.index,
          stopDueAt: stop.dueAt,
          values: [],
          status: 'failed',
          message: error instanceof Error ? error.message : 'Reporting failed.',
        });
      }
    }
  }
  return results;
}
