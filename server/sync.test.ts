import assert from 'node:assert/strict';
import { test } from 'node:test';

// Fetching from PDHC end to end, with request.pdhc and plan.pdhc stubbed.
// Must be set before db.ts loads.
process.env.DATABASE_PATH = ':memory:';
const { run, now } = await import('./db.ts');
const { syncConnection } = await import('./sync.ts');
const { getPatientView } = await import('./store.ts');
const { reportStop } = await import('./report.ts');
const { describeTiming } = await import('./schedule.ts');
const { sendTestReports, testValue, TEST_NOTE } = await import('./testreport.ts');

const BASE = 'https://request.example/api/v1';
const TEMPLATE_URL = 'https://plan.pdhc.se/api/v1/plandefinitions/pd-1';
const PATIENT = 'p-sync';

// --- What PDHC answers ------------------------------------------------------------

const concept = (code: string, display: string) => ({ concept: { coding: [{ system: 'urn:pdhc:concept', code, display }] } });

/** The FHIR resource as request.pdhc delivered it on 2026-11-19 (ids made up). */
function fhirResource(sr: string, weekly: [string, string][] = [['c-sys', 'systolic-blood-pressure']]) {
  return {
    resourceType: 'ServiceRequest',
    id: sr,
    status: 'active', // stays "active" even when PDHC has archived the request
    intent: 'order',
    subject: { reference: `#patient-${PATIENT}`, display: 'Test Testsson' },
    authoredOn: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
    instantiatesCanonical: [TEMPLATE_URL],
    contained: [
      { resourceType: 'Patient', id: `patient-${PATIENT}`, name: [{ text: 'Test Testsson' }] },
      {
        resourceType: 'CarePlan',
        id: `careplan-${sr}`,
        title: 'MMD_plan',
        instantiatesCanonical: [TEMPLATE_URL],
        activity: [
          { performedActivity: [concept('c-sleep', 'sleep-duration')] },
          { performedActivity: weekly.map(([code, display]) => concept(code, display)) },
        ],
      },
    ],
  };
}

/** `care_plan` as /provider/download sends it: frozen, with this request's own transaction GUIDs. */
const frozenCarePlan = {
  care_plan_guid: 'cp-1',
  frozen_at: '2026-11-19T13:38:06.649249',
  plan_definition_guid: 'pd-1',
  plan_definition_title: 'MMD_plan',
  plan_definition_version: '1.0.0',
  activities: [
    {
      activity_guid: 'a-1',
      title: 'Sleep',
      description: 'rapportera sömntid',
      performer_type: 'Patient',
      timing_type: 'repeat',
      timing: { repeat: { duration: 1, durationUnit: 'min', frequency: 1, period: 1, periodUnit: 'd' } },
      transactions: [
        { transaction_guid: 'tx-frozen-sleep', concept_guid: 'c-sleep', concept_name: 'sleep-duration', unit: 'h', range_min: 0, range_max: 12, requirement_type: 'required', response_type: 'numeric' },
      ],
    },
    {
      // When this request was made, the template gave the weekly report no schedule.
      activity_guid: 'a-2',
      title: 'Veckorapport',
      description: null,
      performer_type: 'Practitioner',
      timing_type: null,
      timing: null,
      transactions: [
        { transaction_guid: 'tx-frozen-sys', concept_guid: 'c-sys', concept_name: 'systolic-blood-pressure', unit: 'mmHg', range_min: 100, range_max: 130, requirement_type: 'required', response_type: 'numeric' },
      ],
    },
  ],
};

/** The live template, edited since: other transaction GUIDs and a weekly schedule. Must not be used. */
const liveTemplate = {
  activities: [
    { sort_order: 0, title: 'Sleep', timing_type: 'repeat', timing_frequency: 1, timing_period: 1, timing_period_unit: 'd', transactions: [{ transaction_guid: 'tx-live-sleep', concept_guid: 'c-sleep', concept_name: 'sleep-duration' }] },
    { sort_order: 1, title: 'Veckorapport', timing_type: 'repeat', timing_frequency: 1, timing_period: 1, timing_period_unit: 'wk', transactions: [{ transaction_guid: 'tx-live-sys', concept_guid: 'c-sys', concept_name: 'systolic-blood-pressure' }] },
  ],
};

/** What plan.pdhc says about the stress concept: a 1–7 slider, bound to SNOMED CT. */
const PLAN_PDHC: Record<string, unknown> = {
  'https://plan.pdhc.se/api/v1/concepts/c-stress': {
    concept_name: 'stress',
    concept_display_text: 'Stress',
    range_low: 1,
    range_high: 7,
    response_type_url: 'https://plan.pdhc.se/api/v1/lookup/response-types/slider',
    canonical_lib_url: 'https://plan.pdhc.se/api/v1/lookup/canonical-libs/snomed',
    canonical_refnumber: '73595000',
  },
  'https://plan.pdhc.se/api/v1/lookup/response-types/slider': { response_type_name: 'Slider' },
  'https://plan.pdhc.se/api/v1/lookup/canonical-libs/snomed': { canonical_lib_name: 'snomed', canonical_lib_url: 'http://snomed.info/sct' },
};

const pdhc = {
  feed: [] as { service_request_guid: string; updated_at: string; sr_status: string }[],
  downloads: new Map<string, Record<string, unknown>>(),
  calls: [] as string[],
  /** What gateway.pdhc received at /provider/report/{sr}. */
  reports: [] as { sr: string; body: any }[],
};

function download(
  sr: string,
  state: { sr_status: string; is_open: boolean },
  carePlan: Record<string, unknown> = frozenCarePlan,
  weekly?: [string, string][],
) {
  return {
    fhir_resource: fhirResource(sr, weekly),
    grant_token: `grant-${sr}`,
    patient_guid: PATIENT,
    contract_guid: 'con-1',
    service_request_guid: sr,
    care_plan_guid: String(carePlan.care_plan_guid),
    care_plan: carePlan,
    ...state,
  };
}

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  pdhc.calls.push(url);
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const reported = url.match(/\/provider\/report\/([^/?]+)/)?.[1];
  if (reported && init?.method === 'POST') {
    const body = JSON.parse(String(init.body));
    pdhc.reports.push({ sr: reported, body });
    // Like the live gateway (2026-11-19): a numeric value sent as text is refused.
    const text = body.report_payload.observations.findIndex((o: { value: unknown }) => typeof o.value !== 'number');
    if (text !== -1) {
      return json({ code: 'VALIDATION_ERROR', message: 'Observation validation failed', details: [{ field: 'value', message: 'Expected numeric value, got str', observation_index: text }] }, 422);
    }
    return json({ action: 'created', is_late: false, observations_stored: body.report_payload.observations.length, receipt_guid: 'rcpt-1', service_request_guid: reported, status: 'accepted' }, 202);
  }
  if (url.startsWith(`${BASE}/provider/feed`)) return json({ items: pdhc.feed, total: pdhc.feed.length });
  if (PLAN_PDHC[url]) return json(PLAN_PDHC[url]);
  const sr = url.match(/\/provider\/download\/([^/?]+)/)?.[1];
  if (sr) return pdhc.downloads.has(sr) ? json(pdhc.downloads.get(sr)) : json({ code: 'not_found' }, 404);
  if (url.startsWith(TEMPLATE_URL)) return json(liveTemplate);
  return json({ code: 'not_found' }, 404);
}) as typeof fetch;

const at = now();
const connectionId = Number(
  run(
    `INSERT INTO connections (name, base_url, gateway_url, provider_token, poll_enabled, created_at, updated_at)
     VALUES ('PDHC test', :base, :base, 'test-token', 0, :at, :at)`,
    { base: BASE, at },
  ).lastInsertRowid,
);

// --- The tests ------------------------------------------------------------------

test("uses the frozen care_plan from the download, not the live template", async () => {
  pdhc.feed = [{ service_request_guid: 'sr-1', updated_at: '2026-11-19T13:38:48', sr_status: 'active' }];
  pdhc.downloads.set('sr-1', download('sr-1', { sr_status: 'active', is_open: true }));

  const result = await syncConnection(connectionId);
  assert.equal(result.message, 'Fetched: 1 new.');
  assert.ok(!pdhc.calls.some((url) => url.startsWith(TEMPLATE_URL)), 'plan.pdhc should not be asked');

  const request = getPatientView(PATIENT)!.requests[0];
  assert.equal(request.carePlanGuid, 'cp-1');
  assert.equal(request.pdhcStatus, 'active');
  assert.equal(request.closed, false);
  const [sleep, weekly] = request.activities;
  assert.deepEqual([sleep.title, describeTiming(sleep.timing), sleep.transactions[0].transactionGuid], ['Sleep', 'Once a day', 'tx-frozen-sleep']);
  assert.deepEqual(
    [weekly.title, weekly.timing.kind, weekly.performerType, weekly.transactions[0].transactionGuid, weekly.transactions[0].unit],
    ['Veckorapport', 'unscheduled', 'Practitioner', 'tx-frozen-sys', 'mmHg'],
  );
});

test('notices a request that PDHC has archived, hides it and stops reports', async () => {
  // Archived requests vanish from the feed; the FHIR resource still says active.
  pdhc.feed = [];
  pdhc.downloads.set('sr-1', download('sr-1', { sr_status: 'archived', is_open: false }));

  const result = await syncConnection(connectionId);
  assert.equal(result.message, 'Fetched: 1 closed in PDHC.');
  const request = getPatientView(PATIENT)!.requests[0];
  assert.equal(request.status, 'active');
  assert.equal(request.pdhcStatus, 'archived');
  assert.equal(request.closed, true);

  const sleep = request.activities[0];
  await assert.rejects(
    reportStop(PATIENT, { serviceRequestGuid: request.guid, activityKey: sleep.key, stopIndex: 0, values: [{ name: 'sleep-duration', value: '7' }] }),
    /closed/,
  );

  // Once closed, it is not downloaded again.
  pdhc.calls = [];
  await syncConnection(connectionId);
  assert.ok(!pdhc.calls.some((url) => url.includes('/provider/download/')));
});

test('a request missing from the feed but still open is not downloaded every minute', async () => {
  pdhc.feed = [{ service_request_guid: 'sr-2', updated_at: '2026-11-19T17:51:53', sr_status: 'active' }];
  pdhc.downloads.set('sr-2', download('sr-2', { sr_status: 'active', is_open: true }));
  await syncConnection(connectionId);

  pdhc.feed = [];
  pdhc.calls = [];
  await syncConnection(connectionId);
  await syncConnection(connectionId);
  assert.equal(pdhc.calls.filter((url) => url.includes('/provider/download/sr-2')).length, 1);
  assert.equal(getPatientView(PATIENT)!.requests.find((r) => r.guid === 'sr-2')!.closed, false);
});

test('sends test observations for open requests, with the frozen transaction GUIDs and a test note', async () => {
  pdhc.reports = [];
  const results = await sendTestReports(connectionId, {}, () => 0.5);

  // sr-1 is closed, so nothing goes for it. In sr-2 the sleep line has a stop
  // due; the weekly report has no schedule in its frozen care plan.
  assert.deepEqual(
    results.map((r) => [r.serviceRequestGuid, r.activity, r.status]),
    [
      ['sr-2', 'Sleep', 'sent'],
      ['sr-2', 'Veckorapport', 'skipped'],
    ],
  );
  assert.equal(results[0].message, 'Received by PDHC (receipt rcpt-1, 1 stored).');
  assert.equal(results[0].sent[0].receiptGuid, 'rcpt-1');
  assert.equal(results[0].values[0].transactionGuid, 'tx-frozen-sleep');

  assert.equal(pdhc.reports.length, 1);
  const [{ sr, body }] = pdhc.reports;
  assert.equal(sr, 'sr-2');
  assert.equal(body.patient_guid, PATIENT);
  assert.equal(body.grant_token, 'grant-sr-2');
  const [observation] = body.report_payload.observations;
  assert.equal(observation.transaction_guid, 'tx-frozen-sleep');
  // The note says it is test data and which parameter the value was meant for.
  assert.equal(observation.notes, `${TEST_NOTE} sleep-duration = ${observation.value} h`);
  // A JSON number, since the transaction is numeric.
  assert.equal(typeof observation.value, 'number');
  assert.ok(observation.value >= 4.8 && observation.value <= 8.9);
  // Only what the gateway wants: no concept or unit.
  assert.deepEqual(Object.keys(observation).sort(), ['notes', 'recorded_at', 'transaction_guid', 'value']);
});

test('test values vary and fit what is measured', () => {
  const glucose = { name: 'CGM', rangeMin: 4, rangeMax: 8, unit: 'mmol/L' };
  assert.equal(testValue(glucose, () => 0), '4.4');
  assert.equal(testValue(glucose, () => 0.999), '9.8'); // now and then above the plan's range
  assert.equal(testValue({ name: 'anxiety' }, () => 0.42), '4'); // a 0–10 rating, whole numbers
  assert.equal(testValue({ name: 'systolic-blood-pressure', rangeMin: 100, rangeMax: 130 }, () => 0.5), '126');
  // Something unknown with a range: around the range, never below zero when the range starts at zero.
  assert.equal(testValue({ name: 'steps-ish', rangeMin: 0, rangeMax: 100 }, () => 0), '0');
  const values = new Set(Array.from({ length: 20 }, () => testValue(glucose)));
  assert.ok(values.size > 5, 'values should vary between clicks');
});

test('numeric values go to the gateway as numbers, other answers as text', async () => {
  const { gatewayValue } = await import('./pdhc.ts');
  assert.equal(gatewayValue('7.2', 'numeric'), 7.2);
  assert.equal(gatewayValue('7,2', 'numeric'), 7.2);
  assert.equal(gatewayValue('125', undefined), 125); // type unknown: a plain number is sent as one
  assert.equal(gatewayValue('done', 'numeric'), 'done');
  assert.equal(gatewayValue('7', 'string'), '7');
});

// A later request whose frozen weekly report has a schedule and four parameters.
const WEEKLY: [string, string][] = [
  ['c-sys', 'systolic-blood-pressure'],
  ['c-dia', 'diastolic-blood-pressure'],
  ['c-anx', 'anxiety'],
  ['c-stress', 'stress'],
];
const weeklyCarePlan = {
  ...frozenCarePlan,
  care_plan_guid: 'cp-2',
  activities: [
    frozenCarePlan.activities[0],
    {
      ...frozenCarePlan.activities[1],
      timing_type: 'repeat',
      timing: { repeat: { count: 8, frequency: 1, period: 1, periodUnit: 'wk' } },
      transactions: WEEKLY.map(([code, name]) => ({
        transaction_guid: `tx-${code}`,
        concept_guid: code,
        concept_name: name,
        requirement_type: 'required',
        response_type: 'numeric',
      })),
    },
  ],
};

test('one value per report: its own report, its own time, and no two parameters share a value', async () => {
  pdhc.feed = [{ service_request_guid: 'sr-3', updated_at: '2026-11-19T18:30:00', sr_status: 'active' }];
  pdhc.downloads.set('sr-3', download('sr-3', { sr_status: 'active', is_open: true }, weeklyCarePlan, WEEKLY));
  await syncConnection(connectionId);

  pdhc.reports = [];
  const results = await sendTestReports(connectionId);
  const weekly = results.find((r) => r.serviceRequestGuid === 'sr-3' && r.activity === 'Veckorapport')!;
  assert.equal(weekly.status, 'sent');
  assert.equal(weekly.sent.length, 4);
  assert.equal(weekly.message, 'Received by PDHC: 4 of 4 reports.');

  const sr3 = pdhc.reports.filter((r) => r.sr === 'sr-3');
  const weeklyReports = sr3.filter((r) => r.body.report_payload.observations[0].transaction_guid !== 'tx-frozen-sleep');
  assert.equal(weeklyReports.length, 4);
  assert.ok(weeklyReports.every((r) => r.body.report_payload.observations.length === 1));
  const observations = weeklyReports.map((r) => r.body.report_payload.observations[0]);
  assert.deepEqual(observations.map((o) => o.transaction_guid), ['tx-c-sys', 'tx-c-dia', 'tx-c-anx', 'tx-c-stress']);
  assert.equal(new Set(observations.map((o) => o.recorded_at)).size, 4);
  assert.ok(observations.every((o, i) => o.notes === `${TEST_NOTE} ${WEEKLY[i][1]} = ${o.value}`));

  // Stress stays on the concept's own 1–7 scale, in whole numbers (a slider).
  const stress = observations.find((o) => o.transaction_guid === 'tx-c-stress')!;
  assert.ok(Number.isInteger(stress.value) && stress.value >= 1 && stress.value <= 7, `stress ${stress.value}`);

  // Every value in the click is different, so a value on the wrong parameter can be traced.
  const all = pdhc.reports.flatMap((r) => r.body.report_payload.observations.map((o: { value: number }) => o.value));
  assert.equal(new Set(all).size, all.length);
});

test('all values of an activity in one report, as the patient app sends them', async () => {
  pdhc.reports = [];
  const results = await sendTestReports(connectionId, { onePerReport: false });
  const weekly = results.find((r) => r.serviceRequestGuid === 'sr-3' && r.activity === 'Veckorapport')!;
  assert.equal(weekly.sent.length, 1);
  const report = pdhc.reports.find((r) => r.sr === 'sr-3' && r.body.report_payload.observations.length === 4)!;
  assert.deepEqual(
    report.body.report_payload.observations.map((o: { transaction_guid: string }) => o.transaction_guid),
    ['tx-c-sys', 'tx-c-dia', 'tx-c-anx', 'tx-c-stress'],
  );
  assert.equal(new Set(report.body.report_payload.observations.map((o: { recorded_at: string }) => o.recorded_at)).size, 1);
});

test("test values keep to the concept's own scale and response type on plan.pdhc", async () => {
  const { conceptInfo } = await import('./concepts.ts');
  const stress = await conceptInfo('c-stress');
  assert.deepEqual(stress, {
    guid: 'c-stress',
    name: 'stress',
    rangeLow: 1,
    rangeHigh: 7,
    responseType: 'Slider',
    unit: undefined,
    term: { system: 'http://snomed.info/sct', code: '73595000', display: 'Stress' },
  });
  // 0–10 for a rating, cut to the concept's 1–7.
  assert.equal(testValue({ name: 'stress' }, () => 0, stress), '1');
  assert.equal(testValue({ name: 'stress' }, () => 0.999, stress), '7');
  // Blood pressure as an Integer concept; glucose keeps its decimal.
  assert.equal(testValue({ name: 'systolic-blood-pressure' }, () => 0.5, { guid: 'x', name: null, rangeLow: 60, rangeHigh: 250, responseType: 'Integer' }), '126');
  assert.equal(testValue({ name: 'CGM' }, () => 0.5, { guid: 'x', name: null, rangeLow: 2, rangeHigh: 22, responseType: 'numerical' }), '7.1');
  // A concept that cannot be read leaves the realistic spread alone.
  assert.equal(await conceptInfo('c-unknown'), undefined);
});
