import assert from 'node:assert/strict';
import { test } from 'node:test';

// Use a throwaway database. Must be set before store.ts (and db.ts) load.
process.env.DATABASE_PATH = ':memory:';
const { parseDelivery, timingFromPdhcFields, InboundError } = await import('./fhir.ts');
const { occurrences, describeTiming } = await import('./schedule.ts');
const { buildDemoBundle, createDemo } = await import('./demo.ts');
const { storeDelivery, getPatientView, getAppView } = await import('./store.ts');
const { reportStop } = await import('./report.ts');
const { normalizeBaseUrl } = await import('./pdhc.ts');

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
