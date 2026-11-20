import { parseDelivery } from './fhir.ts';
import { buildDemoIps } from './ips.ts';
import {
  activityStops,
  addMessage,
  clearPatientAppData,
  clearPerformances,
  getPatientView,
  insertObservation,
  logInbound,
  saveIps,
  seedPerformance,
  storeDelivery,
} from './store.ts';
import { run } from './db.ts';

// The demo case from the whiteboard: Andrea, flagged in the control tower,
// agrees on a new plan in the chat, and gets one request with three
// longitudinal care plans: diabetes, rheumatology and ADHD.
//
// It is shaped like a PDHC push (provider technical manual, section 4): a
// Bundle of type "message" with receipt_token and grant_token in meta.tag, and
// a ServiceRequest with a contained Patient, Goals and CarePlans. It goes
// through the same parser and store as a real delivery.
//
// Everything here is synthetic. Andrea is not a real person.

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const PATIENT_GUID = 'a7d3c1e2-5b4f-4c6a-9e8d-2f1b0c3d4e51';
const SERVICE_REQUEST_GUID = 'c4e2a9b1-7d3f-4e5a-8b6c-9d0e1f2a3b42';
const DEMO_NOTE = 'Demo mode: not sent to PDHC. The confirmation is simulated.';

function startOfToday() {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** The local calendar date, so a plan starting "today" starts today here, not in UTC. */
function isoDate(time: number) {
  const date = new Date(time);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function transaction(name: string, extra: Record<string, unknown> = {}) {
  return { concept_name: name, requirement_type: 'required', ...extra };
}

function goal(id: string, text: string, measure: string, detail: string) {
  return {
    resourceType: 'Goal',
    id,
    lifecycleStatus: 'active',
    description: { text },
    target: [{ measure: { text: measure }, detailString: detail }],
  };
}

export function buildDemoBundle(today = startOfToday()) {
  // The plan started eight days ago (today is day 9) and runs for twelve weeks.
  const start = today - 8 * DAY;
  const end = start + 12 * 7 * DAY;
  const period = { start: isoDate(start), end: isoDate(end) };

  return {
    resourceType: 'Bundle',
    type: 'message',
    meta: {
      tag: [
        { system: 'https://pdhc.se/delivery', code: 'receipt_token', display: 'demo-receipt' },
        { system: 'https://pdhc.se/delivery', code: 'grant_token', display: 'demo-grant' },
      ],
    },
    entry: [
      {
        resource: {
          resourceType: 'ServiceRequest',
          id: SERVICE_REQUEST_GUID,
          status: 'active',
          intent: 'order',
          priority: 'routine',
          code: { text: 'New plan: diabetes, rheumatology and ADHD' },
          subject: { reference: `Patient/${PATIENT_GUID}`, display: 'Andrea Lindqvist' },
          authoredOn: new Date(start - DAY).toISOString(),
          occurrencePeriod: period,
          basedOn: [{ reference: 'Contract/demo-contract' }],
          contained: [
            { resourceType: 'Patient', id: PATIENT_GUID, name: [{ given: ['Andrea'], family: 'Lindqvist' }], birthDate: '2002-04-11' },
            goal('goal-glucose', 'Morning blood glucose 4–8 mmol/L', 'Blood glucose', '4–8 mmol/L'),
            goal('goal-stiffness', 'Less joint stiffness in the morning', 'Joint stiffness', 'at most 3 of 10'),
            goal('goal-sleep', 'More even sleep and focus', 'Sleep', 'at least 7 hours'),
            {
              resourceType: 'CarePlan',
              id: 'diabetes',
              status: 'active',
              intent: 'plan',
              title: 'Diabetes',
              description: 'Blood glucose every morning, read from Health.',
              period,
              goal: [{ reference: '#goal-glucose' }],
              activity: [
                {
                  id: 'glucose',
                  detail: {
                    code: { text: 'Blood glucose' },
                    description: 'Measure your blood glucose in the morning. The value is read from Health.',
                    status: 'in-progress',
                    performer: [{ display: 'Patient' }],
                    scheduledTiming: { repeat: { frequency: 1, period: 1, periodUnit: 'd' } },
                  },
                  // plan.pdhc's concept for blood glucose (the CGM PlanDefinition).
                  transactions: [
                    transaction('Blood glucose', {
                      concept_guid: '1c34a590-fc2d-430c-92e6-d123b95fe392',
                      unit: 'mmol/L',
                      range_min: 3,
                      range_max: 10,
                    }),
                  ],
                },
                {
                  id: 'follow-up',
                  detail: {
                    code: { text: 'Follow-up with the care team' },
                    description: 'A review of all three plans. The plan is adjusted if needed.',
                    status: 'scheduled',
                    performer: [{ display: 'Practitioner' }],
                    scheduledTiming: { event: [new Date(start + 28 * DAY + 9 * HOUR).toISOString()] },
                  },
                },
              ],
            },
            {
              resourceType: 'CarePlan',
              id: 'rheumatology',
              status: 'active',
              intent: 'plan',
              title: 'Rheumatology',
              description: 'Rate joint stiffness every other morning.',
              period,
              goal: [{ reference: '#goal-stiffness' }],
              activity: [
                {
                  id: 'stiffness',
                  detail: {
                    code: { text: 'Joint stiffness' },
                    description: 'Rate how stiff your joints are this morning, from 0 to 10.',
                    status: 'in-progress',
                    performer: [{ display: 'Patient' }],
                    scheduledTiming: { repeat: { frequency: 1, period: 2, periodUnit: 'd' } },
                  },
                  transactions: [transaction('Joint stiffness (0–10)', { range_min: 0, range_max: 10 })],
                },
              ],
            },
            {
              resourceType: 'CarePlan',
              id: 'adhd',
              status: 'active',
              intent: 'plan',
              title: 'ADHD',
              description: 'An evening check of sleep and focus.',
              period,
              goal: [{ reference: '#goal-sleep' }],
              activity: [
                {
                  id: 'evening-check',
                  detail: {
                    code: { text: 'Sleep and focus' },
                    description: 'Hours slept last night (read from Health) and how well you could focus today, from 0 to 10.',
                    status: 'in-progress',
                    performer: [{ display: 'Patient' }],
                    scheduledTiming: { repeat: { frequency: 1, period: 1, periodUnit: 'd' } },
                  },
                  transactions: [
                    transaction('Sleep', { unit: 'h', range_min: 0, range_max: 14 }),
                    transaction('Focus (0–10)', { range_min: 0, range_max: 10 }),
                  ],
                },
              ],
            },
          ],
        },
      },
    ],
  };
}

/** A small deterministic wobble, so the history looks real but is the same every time. */
const wobble = (i: number, size: number) => (((i * 37) % 11) - 5) * (size / 5);

/** The past stops Andrea skipped, so the map shows missed stops too. */
const missed: Record<string, number[]> = {
  'diabetes:glucose': [5],
  'adhd:evening-check': [0],
};

/**
 * Creates (or recreates, with fresh dates) the demo request through the same
 * path as a real push, then fills in the history: done stops with values,
 * the chat that led to the plan, and a synthetic IPS.
 */
export function createDemo() {
  const today = startOfToday();
  const start = today - 8 * DAY;
  const parsed = parseDelivery(buildDemoBundle(today));
  const outcome = storeDelivery(parsed, { channel: 'demo', connectionId: null });
  logInbound('demo', null, parsed.guid, outcome, 'Demo request (synthetic data)');

  const patient = parsed.patient.guid;
  const sr = parsed.guid;
  clearPerformances(sr);
  clearPatientAppData(patient);
  run('UPDATE service_requests SET seen_at = NULL WHERE guid = :guid', { guid: sr });

  // The chat that led to the plan, the day before it started.
  const before = start - DAY;
  const chat: [number, 'patient' | 'care-team' | 'system', string][] = [
    [9.0, 'care-team', 'Hi Andrea! We can see that your blood glucose has been higher than planned lately. How are you?'],
    [9.4, 'patient', 'Not great. It is hard to keep my routines, and my joints are stiff in the mornings.'],
    [9.6, 'care-team', 'Thank you for telling us. Would you like more support? We can make a new plan together.'],
    [9.7, 'patient', 'Yes, please.'],
    [10.1, 'care-team', 'We are sending you a plan with goals for diabetes, rheumatology and ADHD. You will find it here in the app.'],
  ];
  for (const [hour, sender, text] of chat) addMessage(patient, sender, text, null, new Date(before + hour * HOUR).toISOString());
  addMessage(patient, 'system', 'New plan from the care team', sr, new Date(before + 10.2 * HOUR).toISOString());
  run('UPDATE service_requests SET seen_at = :at WHERE guid = :guid', { guid: sr, at: new Date(start + 7 * HOUR).toISOString() });

  // What Andrea has done so far, with values, stamped like real reports.
  const record = (key: string, index: number, due: number, offsetHours: number, values: [string, string, string | null, string | null][]) => {
    const at = new Date(due + offsetHours * HOUR).toISOString();
    seedPerformance(sr, key, index, at);
    for (const [name, value, unit, device] of values) {
      insertObservation({
        patientGuid: patient,
        serviceRequestGuid: sr,
        activityKey: key,
        stopIndex: index,
        name,
        transactionGuid: null,
        conceptGuid: name === 'Blood glucose' ? '1c34a590-fc2d-430c-92e6-d123b95fe392' : null,
        value,
        unit,
        recordedAt: at,
        device,
        carePlanRef: key.split(':')[0],
        planDay: Math.floor((due - start) / DAY) + 1,
        note: null,
        reportStatus: 'demo',
        reportMessage: DEMO_NOTE,
        confirmed: true,
      });
    }
  };

  for (const carePlan of parsed.carePlans) {
    for (const activity of carePlan.activities) {
      const stops = activityStops(sr, activity.key) ?? [];
      stops.forEach((dueDate, index) => {
        const due = dueDate.getTime();
        const isToday = due >= today && due < today + DAY;
        if ((missed[activity.key] ?? []).includes(index)) return;
        if (activity.key === 'diabetes:glucose' && (due < today || isToday)) {
          const value = (8.6 - (index / 8) * 2.3 + wobble(index, 0.3)).toFixed(1);
          record(activity.key, index, due, 7.2, [['Blood glucose', value, 'mmol/L', 'Health (simulated)']]);
        } else if (due >= today) {
          return;
        } else if (activity.key === 'rheumatology:stiffness') {
          record(activity.key, index, due, 7.5, [['Joint stiffness (0–10)', String(Math.max(2, 5 - Math.floor(index / 2))), null, null]]);
        } else if (activity.key === 'adhd:evening-check') {
          record(activity.key, index, due, 19, [
            ['Sleep', (6.1 + index * 0.14 + wobble(index, 0.2)).toFixed(1), 'h', 'Health (simulated)'],
            ['Focus (0–10)', String(Math.min(7, 4 + Math.floor(index / 3))), null, null],
          ]);
        }
      });
    }
  }

  addMessage(patient, 'care-team', 'We have looked at your values from this week. It looks good. Keep it up!', null, new Date(today - DAY + 15 * HOUR).toISOString());
  saveIps(patient, buildDemoIps(patient, today), 'IPS via Health Connect (synthetic)', true);

  return getPatientView(patient)!;
}
