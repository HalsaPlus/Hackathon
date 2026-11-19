import assert from 'node:assert/strict';
import { test } from 'node:test';

// Use a throwaway database. Must be set before store.ts (and db.ts) load.
process.env.DATABASE_PATH = ':memory:';
const { parseDelivery, timingFromFhir, timingFromPdhcFields, InboundError } = await import('./fhir.ts');
const { occurrences, describeTiming } = await import('./schedule.ts');
const { buildDemoBundle, createDemo } = await import('./demo.ts');
const { storeDelivery, getPatientView, getAppView } = await import('./store.ts');
const { reportStop } = await import('./report.ts');
const { normalizeBaseUrl } = await import('./pdhc.ts');
const { applyPlanTemplates, planDefinitionUrl } = await import('./plandefinition.ts');

const DAY = 24 * 60 * 60 * 1000;

test('reads the example from the PDHC provider manual (section 3.2)', () => {
  const parsed = parseDelivery(
    {
      resourceType: 'ServiceRequest',
      id: 'sr-abc-123',
      status: 'active',
      intent: 'order',
      priority: 'routine',
      subject: { reference: 'Patient/pat-001', display: 'Test Testsson' },
      authoredOn: '2026-03-24T10:00:00Z',
      occurrencePeriod: { start: '2026-03-24', end: '2026-04-24' },
      contained: [
        {
          resourceType: 'CarePlan',
          id: 'cp-001',
          title: 'Mobility Assessment',
          goal: [
            {
              description: { text: 'Assess range of motion' },
              target: [{ measure: { text: 'Shoulder flexion' }, detailString: 'degrees' }],
            },
          ],
          activity: [{ detail: { description: 'Measure shoulder flexion bilaterally', status: 'not-started' } }],
        },
        { resourceType: 'Patient', id: 'pat-001', name: [{ given: ['Test'], family: 'Testsson' }] },
      ],
      basedOn: [{ reference: 'Contract/con-789' }],
    },
    { grantToken: 'grant-1', patientGuid: 'pat-001' },
  );

  assert.equal(parsed.guid, 'sr-abc-123');
  assert.equal(parsed.patient.guid, 'pat-001');
  assert.equal(parsed.patient.displayName, 'Test Testsson');
  assert.equal(parsed.contractGuid, 'con-789');
  assert.equal(parsed.grantToken, 'grant-1');
  assert.equal(parsed.title, 'Mobility Assessment');
  const [plan] = parsed.carePlans;
  assert.deepEqual(plan.goals, [{ text: 'Assess range of motion', target: 'Shoulder flexion: degrees' }]);
  assert.equal(plan.activities.length, 1);
  assert.equal(plan.activities[0].title, 'Measure shoulder flexion bilaterally');
  assert.equal(plan.activities[0].status, 'not-started');
  assert.equal(plan.activities[0].timing.kind, 'unscheduled');
});

test('reads several care plans and the delivery tags from a push Bundle', () => {
  const parsed = parseDelivery(buildDemoBundle());
  assert.equal(parsed.receiptToken, 'demo-receipt');
  assert.equal(parsed.grantToken, 'demo-grant');
  assert.deepEqual(
    parsed.carePlans.map((p) => p.title),
    ['Diabetes', 'Rheumatology', 'ADHD'],
  );
  assert.deepEqual(
    parsed.carePlans.flatMap((p) => p.activities.map((a) => a.key)),
    ['diabetes:glucose', 'diabetes:follow-up', 'rheumatology:stiffness', 'adhd:evening-check'],
  );
  assert.equal(parsed.carePlans[0].goals[0].text, 'Morning blood glucose 4–8 mmol/L');
});

test("reads plan.pdhc's flat timing fields (live PlanDefinition 'CGM')", () => {
  // As served by GET https://plan.pdhc.se/api/v1/PlanDefinition on 2026-11-19.
  const timing = timingFromPdhcFields({
    timing_type: 'repeat',
    timing_frequency: 1,
    timing_period: 1,
    timing_period_unit: 'd',
    timing_bounds_mode: 'duration',
    timing_bounds_duration_value: 3,
    timing_bounds_duration_unit: 'wk',
    timing_bounds_count: null,
  });
  assert.deepEqual(timing, { kind: 'repeat', frequency: 1, period: 1, periodUnit: 'd', boundsValue: 3, boundsUnit: 'wk' });
  assert.equal(describeTiming(timing!), 'Once a day for 3 weeks');

  const start = new Date('2026-01-01T00:00:00Z');
  const { dates } = occurrences(timing!, start, new Date(start.getTime() + 365 * DAY));
  assert.equal(dates.length, 21);
});

test('uses the actions of a PlanDefinition when no CarePlan is contained', () => {
  const parsed = parseDelivery({
    resourceType: 'ServiceRequest',
    id: 'sr-2',
    subject: { reference: 'Patient/p-2' },
    contained: [
      {
        resourceType: 'PlanDefinition',
        id: 'pd',
        title: 'Asthma home monitoring',
        action: [
          { title: 'Weekly home spirometry', timing_type: 'repeat', timing_frequency: 1, timing_period: 1, timing_period_unit: 'wk' },
        ],
      },
    ],
  });
  assert.equal(parsed.carePlans[0].activities[0].title, 'Weekly home spirometry');
  assert.equal(describeTiming(parsed.carePlans[0].activities[0].timing), 'Once a week');
});

// The shape request.pdhc delivered on 2026-11-19 (GET /provider/download/{sr}),
// with the patient and ids replaced: the CarePlan's activities only list
// concepts, and the plan template is on plan.pdhc.
const TEMPLATE_URL = 'https://plan.pdhc.se/api/v1/plandefinitions/pd-1';
const concept = (code: string, display: string) => ({
  concept: { coding: [{ system: 'urn:pdhc:concept', code, display }], text: display },
});
function pdhcDelivery() {
  return {
    resourceType: 'ServiceRequest',
    id: 'sr-real',
    status: 'active',
    intent: 'order',
    subject: { reference: '#patient-p-real', display: 'Test Testsson' },
    authoredOn: '2026-11-19T13:38:06Z',
    instantiatesCanonical: [TEMPLATE_URL],
    contained: [
      { resourceType: 'Patient', id: 'patient-p-real', name: [{ text: 'Test Testsson' }] },
      { resourceType: 'Goal', id: 'goal-0', description: { text: 'cgm_mean_glucose' } },
      {
        resourceType: 'CarePlan',
        id: 'careplan-sr-real',
        title: 'MMD_plan',
        status: 'active',
        instantiatesCanonical: [TEMPLATE_URL],
        goal: [{ reference: '#goal-0' }],
        activity: [
          { performedActivity: [concept('c-cgm', 'CGM')] },
          { performedActivity: [concept('c-sleep', 'sleep-duration')] },
          {
            performedActivity: [
              concept('c-sys', 'systolic-blood-pressure'),
              concept('c-dia', 'diastolic-blood-pressure'),
              concept('c-stress', 'stress'),
            ],
          },
        ],
      },
    ],
  };
}

// The template's activities as plan.pdhc serves them, shortened, and in
// another order than the delivery to show that they are matched by concept.
const transaction = (guid: string, conceptGuid: string, name: string, unit: string | null, min: number | null, max: number | null) => ({
  guid,
  transaction_guid: guid,
  concept_guid: conceptGuid,
  concept_name: name,
  concept_unit_name: unit,
  range_min: min,
  range_max: max,
  requirement_type: 'required',
  expected_value: null,
});
const noTiming = { timing_type: null, timing_frequency: null, timing_period: null, timing_period_unit: null, timing_bounds_mode: null, timing_bounds_count: null, timing_bounds_duration_value: null, timing_bounds_duration_unit: null };
const TEMPLATE = {
  guid: 'pd-1',
  title: 'MMD_plan',
  activities: [
    {
      ...noTiming,
      sort_order: 2,
      title: 'Veckorapport',
      performer_type: 'Practitioner',
      timing_period: 1,
      timing_period_unit: 'wk',
      transactions: [
        transaction('tx-sys', 'c-sys', 'systolic-blood-pressure', 'mmHg', 100, 130),
        transaction('tx-dia', 'c-dia', 'diastolic-blood-pressure', 'mmHg', 60, 80),
        transaction('tx-stress', 'c-stress', 'stress', null, null, null),
      ],
    },
    { ...noTiming, sort_order: 0, title: 'CGM', performer_type: 'Patient', timing_type: 'once', transactions: [transaction('tx-cgm', 'c-cgm', 'CGM', 'mmol/L', 4, 8)] },
    {
      ...noTiming,
      sort_order: 1,
      title: 'Sleep',
      description: 'rapportera sömntid',
      performer_type: 'Patient',
      timing_type: 'repeat',
      timing_frequency: 1,
      timing_period: 1,
      timing_period_unit: 'd',
      transactions: [transaction('tx-sleep', 'c-sleep', 'sleep-duration', 'h', 0, 12)],
    },
  ],
};

test('reads the concepts in a CarePlan as request.pdhc delivers it', () => {
  const parsed = parseDelivery(pdhcDelivery(), { patientGuid: 'p-real' });
  const [plan] = parsed.carePlans;
  assert.deepEqual(plan.instantiates, [TEMPLATE_URL]);
  assert.deepEqual(
    plan.activities.map((a) => [a.key, a.title, a.timing.kind]),
    [
      ['1-cgm', 'CGM', 'unscheduled'],
      ['2-sleep-duration', 'sleep-duration', 'unscheduled'],
      ['3-systolic-blood-pressure-diastolic-blood', 'systolic-blood-pressure, diastolic-blood-pressure, stress', 'unscheduled'],
    ],
  );
  assert.deepEqual(plan.activities[1].transactions, [{ conceptGuid: 'c-sleep', name: 'sleep-duration' }]);
});

test('fills in title, schedule and transactions from the plan template on plan.pdhc', async () => {
  const parsed = parseDelivery(pdhcDelivery(), { patientGuid: 'p-real' });
  const keysBefore = parsed.carePlans[0].activities.map((a) => a.key);
  const loaded: string[] = [];
  const problems = await applyPlanTemplates(parsed, async (url) => {
    loaded.push(url);
    return TEMPLATE;
  });
  assert.deepEqual(problems, []);
  assert.deepEqual(loaded, [TEMPLATE_URL]);

  const [cgm, sleep, weekly] = parsed.carePlans[0].activities;
  // The keys must not change, since stops done are stored per key.
  assert.deepEqual([cgm.key, sleep.key, weekly.key], keysBefore);
  assert.deepEqual(
    [cgm, sleep, weekly].map((a) => [a.title, describeTiming(a.timing), a.performerType]),
    [
      ['CGM', 'Once', 'Patient'],
      ['Sleep', 'Once a day', 'Patient'],
      ['Veckorapport', 'Once a week', 'Practitioner'],
    ],
  );
  assert.equal(sleep.description, 'rapportera sömntid');
  assert.equal(cgm.derivedTitle, undefined);
  assert.deepEqual(cgm.transactions, [
    { transactionGuid: 'tx-cgm', conceptGuid: 'c-cgm', name: 'CGM', requirement: 'required', rangeMin: 4, rangeMax: 8, expected: undefined, unit: 'mmol/L', responseType: undefined },
  ]);
  assert.deepEqual(
    weekly.transactions.map((t) => [t.transactionGuid, t.unit, t.rangeMin, t.rangeMax]),
    [
      ['tx-sys', 'mmHg', 100, 130],
      ['tx-dia', 'mmHg', 60, 80],
      ['tx-stress', undefined, undefined, undefined],
    ],
  );
});

test('keeps the delivery as it is when the plan template cannot be read', async () => {
  const parsed = parseDelivery(pdhcDelivery(), { patientGuid: 'p-real' });
  const problems = await applyPlanTemplates(parsed, async () => {
    throw new Error('plan.pdhc answered 503.');
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /MMD_plan.*503/);
  assert.equal(parsed.carePlans[0].activities[0].title, 'CGM');
  assert.equal(parsed.carePlans[0].activities[0].timing.kind, 'unscheduled');
});

test('only fetches plan templates from plan.pdhc', () => {
  assert.equal(planDefinitionUrl(`${TEMPLATE_URL}|1.0.0`), TEMPLATE_URL);
  assert.equal(planDefinitionUrl('http://plan.pdhc.se/api/v1/plandefinitions/pd-1'), undefined);
  assert.equal(planDefinitionUrl('https://plan.pdhc.se:8443/api/v1/plandefinitions/pd-1'), undefined);
  assert.equal(planDefinitionUrl('https://plan.pdhc.se.example.com/x'), undefined);
  assert.equal(planDefinitionUrl('https://169.254.169.254/latest'), undefined);
  assert.equal(planDefinitionUrl('not a url'), undefined);
});

test('a template activity with no timing is not read as daily', () => {
  assert.equal(timingFromPdhcFields(noTiming), undefined);
});

// The same template as plan.pdhc renders it in FHIR R5 (shape from PDHC,
// 2026-11-19, shortened): concepts as nested actions, timing as Timing with
// only `duration` for a single occasion, and the performer in participant.role.
const concepts = (...items: [string, string][]) =>
  items.map(([guid, title]) => ({
    title,
    _pdhc_concept_guid: guid,
    requiredBehavior: 'required',
    definitionCanonical: `https://plan.pdhc.se/api/v1/concepts/${guid}`,
  }));
const role = (text: string) => [{ type: 'practitioner', role: { text } }];
const FHIR_TEMPLATE = {
  resourceType: 'PlanDefinition',
  id: 'pd-fhir',
  title: 'MMD_plan',
  goal: [
    {
      description: { text: 'cgm_mean_glucose' },
      target: [{ detailRange: { low: { value: 4, unit: 'mmol/L' }, high: { value: 8, unit: 'mmol/L' } } }],
    },
  ],
  action: [
    { title: 'CGM', participant: role('Patient'), timingTiming: { repeat: { duration: 40, durationUnit: 'd' } }, action: concepts(['c-cgm', 'CGM']) },
    {
      title: 'Sleep',
      description: 'rapportera sömntid',
      participant: role('Patient'),
      timingTiming: { repeat: { frequency: 1, period: 1, periodUnit: 'd', duration: 1, durationUnit: 'min' } },
      action: concepts(['c-sleep', 'sleep-duration']),
    },
    {
      title: 'Veckorapport',
      participant: role('Practitioner'),
      action: concepts(['c-sys', 'systolic-blood-pressure'], ['c-dia', 'diastolic-blood-pressure'], ['c-stress', 'stress']),
    },
  ],
};

test("reads plan.pdhc's FHIR PlanDefinition: nested concepts, a single occasion, the participant's role", () => {
  const parsed = parseDelivery({ resourceType: 'ServiceRequest', id: 'sr-fhir', subject: { reference: 'Patient/p-fhir' }, contained: [FHIR_TEMPLATE] });
  const [plan] = parsed.carePlans;
  assert.deepEqual(
    plan.activities.map((a) => [a.title, describeTiming(a.timing), a.performerType, a.transactions.map((t) => t.conceptGuid)]),
    [
      ['CGM', 'Once', 'Patient', ['c-cgm']],
      ['Sleep', 'Once a day', 'Patient', ['c-sleep']],
      // The FHIR rendering has no schedule for this one, and nothing is made up.
      ['Veckorapport', describeTiming({ kind: 'unscheduled' }), 'Practitioner', ['c-sys', 'c-dia', 'c-stress']],
    ],
  );
  assert.deepEqual(plan.activities[0].transactions, [{ conceptGuid: 'c-cgm', name: 'CGM', requirement: 'required' }]);
  assert.deepEqual(plan.goals, [{ text: 'cgm_mean_glucose', target: '4–8 mmol/L' }]);
});

test('fills in a delivery from a FHIR plan template too', async () => {
  const parsed = parseDelivery(pdhcDelivery(), { patientGuid: 'p-real' });
  const problems = await applyPlanTemplates(parsed, async () => FHIR_TEMPLATE);
  assert.deepEqual(problems, []);
  assert.deepEqual(
    parsed.carePlans[0].activities.map((a) => [a.key, a.title, describeTiming(a.timing), a.performerType]),
    [
      ['1-cgm', 'CGM', 'Once', 'Patient'],
      ['2-sleep-duration', 'Sleep', 'Once a day', 'Patient'],
      ['3-systolic-blood-pressure-diastolic-blood', 'Veckorapport', describeTiming({ kind: 'unscheduled' }), 'Practitioner'],
    ],
  );
  assert.equal(parsed.carePlans[0].activities[2].transactions[0].requirement, 'required');
});

test('a FHIR Timing with only a duration is one occasion, not a daily one', () => {
  assert.deepEqual(timingFromFhir({ repeat: { duration: 40, durationUnit: 'd' } }), { kind: 'once' });
  assert.deepEqual(timingFromFhir({ repeat: { duration: 5, durationUnit: 'min', period: 1, periodUnit: 'wk' } }), {
    kind: 'repeat',
    frequency: 1,
    period: 1,
    periodUnit: 'wk',
  });
});

test('rejects what is not a ServiceRequest', () => {
  assert.throws(() => parseDelivery({ resourceType: 'Bundle', type: 'message', entry: [] }), InboundError);
  assert.throws(() => parseDelivery('nonsense'), InboundError);
  assert.throws(() => parseDelivery({ resourceType: 'ServiceRequest', id: 'x' }), InboundError); // no patient
});

test('stores the demo, recognises it unchanged, and keeps done stops when it changes', () => {
  const view = createDemo();
  const request = view.requests[0];
  assert.equal(request.carePlans.length, 3);
  const glucose = request.activities.find((a) => a.key === 'diabetes:glucose')!;
  assert.equal(glucose.planId, 'diabetes');
  assert.equal(glucose.stops.length, 84); // twelve weeks, every day
  const done = glucose.stops.filter((s) => s.performedAt).length;
  assert.equal(done, 8); // eight days so far, one missed, plus this morning

  const bundle = buildDemoBundle();
  assert.equal(storeDelivery(parseDelivery(bundle), { channel: 'demo', connectionId: null }), 'unchanged');

  (bundle.entry[0].resource.contained[4] as { title: string }).title = 'Diabetes, revised';
  assert.equal(storeDelivery(parseDelivery(bundle), { channel: 'demo', connectionId: null }), 'updated');
  const after = getPatientView(view.patient.guid)!.requests[0];
  assert.equal(after.carePlans[0].title, 'Diabetes, revised');
  assert.equal(after.activities.find((a) => a.key === 'diabetes:glucose')!.stops.filter((s) => s.performedAt).length, done);
});

test('the patient app view has the history, the chat and the IPS', () => {
  const view = createDemo();
  const app = getAppView(view.patient.guid)!;
  assert.ok(app.observations.length > 10);
  assert.ok(app.observations.every((o) => o.patientReported && o.sourceApp === 'MMD'));
  assert.equal(app.messages.filter((m) => m.sender === 'system').length, 1);
  assert.equal(app.ips?.synthetic, true);
  assert.deepEqual(app.ips?.problems.map((p) => p.name), ['Type 2 diabetes', 'Rheumatoid arthritis', 'ADHD']);
  assert.equal(app.ips?.results[0].name, 'HbA1c');
});

test('reporting a stop stamps the values and keeps a demo request in demo mode', async () => {
  const view = createDemo();
  const request = view.requests[0];
  const stiffness = request.activities.find((a) => a.key === 'rheumatology:stiffness')!;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const stop = stiffness.stops.find((s) => Date.parse(s.dueAt) >= today.getTime() && !s.performedAt)!;

  const result = await reportStop(view.patient.guid, {
    serviceRequestGuid: request.guid,
    activityKey: stiffness.key,
    stopIndex: stop.index,
    values: [{ name: 'Joint stiffness (0–10)', value: '3' }],
  });
  assert.equal(result.reportStatus, 'demo');
  assert.equal(result.observations[0].carePlanRef, 'rheumatology');
  assert.equal(result.observations[0].planDay, 9);
  assert.equal(result.observations[0].confirmed, true);
  const after = getPatientView(view.patient.guid)!.requests[0].activities.find((a) => a.key === stiffness.key)!;
  assert.ok(after.stops[stop.index].performedAt);

  await assert.rejects(
    reportStop(view.patient.guid, { serviceRequestGuid: request.guid, activityKey: stiffness.key, stopIndex: 40, values: [] }),
    /future/,
  );
});

test('normalises the connection URL', () => {
  assert.equal(normalizeBaseUrl('request.pdhc.se'), 'https://request.pdhc.se/api/v1');
  assert.equal(normalizeBaseUrl('https://gateway.pdhc.se/api/v1/'), 'https://gateway.pdhc.se/api/v1');
  assert.equal(normalizeBaseUrl('http://localhost:9060'), 'http://localhost:9060/api/v1');
  assert.throws(() => normalizeBaseUrl('http://request.pdhc.se'));
});
