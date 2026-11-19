import assert from 'node:assert/strict';
import { test } from 'node:test';

// Use a throwaway database. Must be set before store.ts (and db.ts) load.
process.env.DATABASE_PATH = ':memory:';
const { parseDelivery, timingFromPdhcFields, InboundError } = await import('./fhir.ts');
const { occurrences, describeTiming } = await import('./schedule.ts');
const { buildDemoBundle, createDemo } = await import('./demo.ts');
const { storeDelivery, getPatientView } = await import('./store.ts');
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
  assert.deepEqual(parsed.carePlan?.goals, [{ text: 'Assess range of motion', target: 'Shoulder flexion: degrees' }]);
  assert.equal(parsed.carePlan?.activities.length, 1);
  assert.equal(parsed.carePlan?.activities[0].title, 'Measure shoulder flexion bilaterally');
  assert.equal(parsed.carePlan?.activities[0].status, 'not-started');
  assert.equal(parsed.carePlan?.activities[0].timing.kind, 'unscheduled');
});

test('reads receipt and grant tokens from a push Bundle (section 4.1)', () => {
  const parsed = parseDelivery(buildDemoBundle());
  assert.equal(parsed.receiptToken, 'demo-receipt');
  assert.equal(parsed.grantToken, 'demo-grant');
  assert.equal(parsed.carePlan?.activities.length, 5);
  assert.deepEqual(
    parsed.carePlan?.activities.map((a) => a.key),
    ['inhalationsteknik', 'dagbok', 'spirometri', 'act', 'uppfoljning'],
  );
  assert.deepEqual(parsed.carePlan?.goals.map((g) => g.text), ['Välkontrollerad astma', 'Stabil lungfunktion']);
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
  assert.equal(describeTiming(timing!), 'En gång per dag i 3 veckor');

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
  assert.equal(parsed.carePlan?.activities[0].title, 'Weekly home spirometry');
  assert.equal(describeTiming(parsed.carePlan!.activities[0].timing), 'En gång per vecka');
});

test('rejects what is not a ServiceRequest', () => {
  assert.throws(() => parseDelivery({ resourceType: 'Bundle', type: 'message', entry: [] }), InboundError);
  assert.throws(() => parseDelivery('nonsense'), InboundError);
  assert.throws(() => parseDelivery({ resourceType: 'ServiceRequest', id: 'x' }), InboundError); // no patient
});

test('stores a delivery, recognises it unchanged, and keeps done stops when it changes', () => {
  const view = createDemo();
  const request = view.requests[0];
  const diary = request.activities.find((a) => a.key === 'dagbok')!;
  assert.equal(diary.stops.length, 84); // twelve weeks, every day
  const done = diary.stops.filter((s) => s.performedAt).length;
  assert.ok(done > 20 && done < 35, `expected some done stops, got ${done}`);

  const bundle = buildDemoBundle();
  assert.equal(storeDelivery(parseDelivery(bundle), { channel: 'demo', connectionId: null }), 'unchanged');

  (bundle.entry[0].resource.contained[3] as { title: string }).title = 'Astma – ny version';
  assert.equal(storeDelivery(parseDelivery(bundle), { channel: 'demo', connectionId: null }), 'updated');
  const after = getPatientView(view.patient.guid)!.requests[0];
  assert.equal(after.carePlan?.title, 'Astma – ny version');
  assert.equal(after.activities.find((a) => a.key === 'dagbok')!.stops.filter((s) => s.performedAt).length, done);
});

test('normalises the connection URL', () => {
  assert.equal(normalizeBaseUrl('request.pdhc.se'), 'https://request.pdhc.se/api/v1');
  assert.equal(normalizeBaseUrl('https://gateway.pdhc.se/api/v1/'), 'https://gateway.pdhc.se/api/v1');
  assert.equal(normalizeBaseUrl('http://localhost:9060'), 'http://localhost:9060/api/v1');
  assert.throws(() => normalizeBaseUrl('http://request.pdhc.se'));
});
