import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, before, test } from 'node:test';
import express from 'express';

// Use a throwaway database. Must be set before store.ts (and db.ts) load.
process.env.DATABASE_PATH = ':memory:';
delete process.env.HALSA_ANDREA_TOKEN;
delete process.env.HALSA_PLUS_URL;

const { halsaSeriesFor, minutesToHours, pointsFromObservation } = await import('../shared/halsa.ts');
const { ANDREA_GUID, halsaTokenFor, saveHalsaLink, removeHalsaLink, setupHalsaLink } = await import('./halsa-link.ts');
const { halsaReading, measureAsOf, prefilledValue, cameFrom } = await import('../src/app/halsa.ts');
const { simulate, simulationFor } = await import('../src/app/healthkit.ts');
const { parseDelivery } = await import('./fhir.ts');
const { applyPlanTemplates } = await import('./plandefinition.ts');
const { storeDelivery, getAppView } = await import('./store.ts');
const { createDemo } = await import('./demo.ts');
const { all } = await import('./db.ts');
const { createApp } = await import('../halsa-plus/src/app.ts');
const { openDatabase } = await import('../halsa-plus/src/db.ts');

const fixture = (name: string) => JSON.parse(readFileSync(path.join(import.meta.dirname, 'fixtures', name), 'utf8'));

// Andrea's order as request.pdhc delivered it (GET /provider/download/{sr},
// grant_token left out), and the plan template it points to as plan.pdhc
// served it on 2026-11-19.
const DOWNLOAD = fixture('pdhc-download-andrea.json');
const TEMPLATE = fixture('plandefinition-mmd-plan.json');
const TEMPLATE_URL = 'https://plan.pdhc.se/api/v1/plandefinitions/58a17c40-a89e-46fb-b095-4336e45f33fe';

async function andreasPlan() {
  const parsed = parseDelivery(DOWNLOAD.fhir_resource, { patientGuid: DOWNLOAD.patient_guid });
  const loaded: string[] = [];
  const problems = await applyPlanTemplates(parsed, async (url) => {
    loaded.push(url);
    return TEMPLATE;
  });
  assert.deepEqual(problems, []);
  assert.deepEqual(loaded, [TEMPLATE_URL]);
  return parsed;
}

// --- The mapping -------------------------------------------------------------------

test("maps the concepts in Andrea's delivered plan to Hälsa+ series", async () => {
  const parsed = await andreasPlan();
  assert.equal(parsed.guid, 'd6b81ca3-5149-46d5-9ba1-582716f263b2');
  assert.equal(parsed.patient.guid, ANDREA_GUID);
  assert.equal(parsed.patient.displayName, 'Andrea Lindqvist');
  assert.deepEqual(
    parsed.carePlans[0].activities.map((a) => [a.title, a.transactions.map((t) => [t.name, t.unit, halsaSeriesFor(t)])]),
    [
      ['CGM', [['CGM', 'mmol/L', 'glucose']]],
      ['Sleep', [['sleep-duration', 'h', 'sleep']]],
      [
        'Veckorapport',
        [
          ['systolic-blood-pressure', 'mmHg', 'systolic'],
          ['diastolic-blood-pressure', 'mmHg', 'diastolic'],
          ['anxiety', undefined, 'anxiety'],
          ['stress', undefined, 'stress'],
        ],
      ],
    ],
  );
});

test('matches on concept GUID or exact concept name, never on display text', () => {
  assert.equal(halsaSeriesFor({ conceptGuid: '22d0f6c6-2438-4637-ad4e-9d85431b8edb', name: 'Something else' }), 'glucose');
  assert.equal(halsaSeriesFor({ name: 'bp_systolic' }), 'systolic');
  assert.equal(halsaSeriesFor({ name: 'bp_diastolic' }), 'diastolic');
  assert.equal(halsaSeriesFor({ name: 'weight' }), 'weight');
  // Capillary blood glucose is not CGM, so it is not read from Hälsa+.
  assert.equal(halsaSeriesFor({ name: 'B-glucos', conceptGuid: '1c34a590-0000-0000-0000-000000000000' }), undefined);
  assert.equal(halsaSeriesFor({ name: 'Blood sugar in the morning' }), undefined);
  assert.equal(halsaSeriesFor({ name: 'asthma-peak-flow' }), undefined);
});

test('converts sleep from minutes to hours and passes every other value on as it is', () => {
  assert.equal(minutesToHours(480), 8);
  assert.equal(minutesToHours(437), 7.28);
  assert.equal(minutesToHours(0), 0);

  const devices = new Map([['cgm-1', 'CGM sensor (demo)']]);
  assert.deepEqual(
    pointsFromObservation({ type: 'sleep', status: 'final', sourceType: 'device', deviceId: 'watch-1', effectivePeriod: { start: '2026-11-18T22:40:00Z', end: '2026-11-19T05:57:00Z' }, components: [{ code: 'sleep-duration', value: 437, unit: 'min' }, { code: 'awakenings', value: 2, unit: '{count}' }] }),
    [{ series: 'sleep', value: 7.28, unit: 'h', time: '2026-11-19T05:57:00Z', device: 'watch-1', status: 'final', sourceType: 'device' }],
  );
  // Far outside the plan's 4–8: reported as it is.
  assert.deepEqual(
    pointsFromObservation({ type: 'glucose', status: 'preliminary', sourceType: 'device', deviceId: 'cgm-1', effectiveDateTime: '2026-11-19T11:55:00Z', value: 10.7, unit: 'mmol/L' }, devices),
    [{ series: 'glucose', value: 10.7, unit: 'mmol/L', time: '2026-11-19T11:55:00Z', device: 'CGM sensor (demo)', status: 'preliminary', sourceType: 'device' }],
  );
  assert.deepEqual(
    pointsFromObservation({ type: 'blood-pressure', deviceId: null, effectiveDateTime: '2026-11-19T07:00:00Z', components: [{ code: 'systolic', value: 141, unit: 'mmHg' }, { code: 'diastolic', value: 52, unit: 'mmHg' }, { code: 'pulse', value: 70, unit: '/min' }] }).map((p) => [p.series, p.value, p.unit]),
    [['systolic', 141, 'mmHg'], ['diastolic', 52, 'mmHg']],
  );
  assert.deepEqual(
    pointsFromObservation({ type: 'bmi', effectiveDateTime: '2026-11-19T07:00:00Z', value: 21.4, components: [{ code: 'weight', value: 60.4, unit: 'kg' }, { code: 'height', value: 168, unit: 'cm' }] }).map((p) => [p.series, p.value, p.unit]),
    [['weight', 60.4, 'kg']],
  );
  assert.deepEqual(
    pointsFromObservation({ type: 'stress', sourceType: 'patient-reported', effectiveDateTime: '2026-11-19T07:00:00Z', value: 6, unit: '0–10' }).map((p) => [p.series, p.value, p.unit]),
    [['stress', 6, null]],
  );
  assert.deepEqual(pointsFromObservation({ type: 'crp', effectiveDateTime: '2026-11-17T08:00:00Z', value: 5 }), []);
});

test("reads a stop's values at the end of its day, never later than the demo clock", () => {
  const now = Date.parse('2026-11-19T12:00:00Z');
  const pastDue = new Date(2026, 10, 17, 9, 0).toISOString();
  const pastEnd = new Date(2026, 10, 17, 23, 59, 59, 999).toISOString();
  assert.equal(measureAsOf(pastDue, undefined, now), pastEnd);
  assert.equal(measureAsOf(new Date(now).toISOString(), undefined, now), undefined);
  assert.equal(measureAsOf(pastDue, '2026-11-16T10:00:00.000Z', now), '2026-11-16T10:00:00.000Z');
});

// --- No link: the app keeps the simulation ---------------------------------------

test('a patient without a Hälsa+ link keeps the simulation exactly as before', () => {
  const demo = createDemo();
  assert.equal(halsaTokenFor(demo.patient.guid), undefined);
  assert.equal(halsaTokenFor(ANDREA_GUID), undefined); // no row and no HALSA_ANDREA_TOKEN

  const cgm = { name: 'CGM', conceptGuid: '22d0f6c6-2438-4637-ad4e-9d85431b8edb', unit: 'mmol/L', rangeMin: 4, rangeMax: 8 };
  const stress = { name: 'stress', conceptGuid: 'd3cb5dfe-23c4-4499-ba7b-e9c5481f43a4' };
  const rating = { name: 'Morning stiffness (0–10)' };
  const typed = { name: 'Steps walked today', unit: 'steps' };
  const simulated = simulate(simulationFor('CGM')!, 42);
  for (const state of [{ status: 'unlinked' as const }, { status: 'idle' as const }]) {
    assert.equal(halsaReading(cgm, state), undefined);
    assert.equal(halsaReading(stress, state), undefined);
    assert.equal(prefilledValue(cgm, halsaReading(cgm, state), simulated), simulated);
    assert.equal(prefilledValue(rating, halsaReading(rating, state), undefined), '3');
    assert.equal(prefilledValue(stress, halsaReading(stress, state), undefined), '');
    assert.equal(prefilledValue(typed, halsaReading(typed, state), undefined), '');
  }
  assert.equal(cameFrom([{ device: 'Health (simulated)' } as never]), 'Health');
});

test('a linked patient gets Hälsa+ values and never a simulated one', () => {
  const cgm = { name: 'CGM', conceptGuid: '22d0f6c6-2438-4637-ad4e-9d85431b8edb' };
  const point = { series: 'glucose' as const, value: 10.7, unit: 'mmol/L', time: '2026-11-19T11:55:00Z', device: 'CGM sensor (demo)', status: 'final' as const, sourceType: 'device' };
  const ready = { status: 'ready' as const, data: { asOf: '2026-11-19T12:00:00Z', points: [point] } };
  const empty = { status: 'ready' as const, data: { asOf: '2026-11-19T12:00:00Z', points: [] } };
  assert.equal(prefilledValue(cgm, halsaReading(cgm, ready), '6.1'), '10.7');
  assert.equal(prefilledValue(cgm, halsaReading(cgm, empty), '6.1'), '');
  assert.equal(prefilledValue(cgm, halsaReading(cgm, { status: 'loading' }), '6.1'), '');
  assert.equal(prefilledValue(cgm, halsaReading(cgm, { status: 'error', message: 'down' }), '6.1'), '');
  assert.equal(cameFrom([{ device: 'Hälsa+ · CGM sensor (demo)' } as never]), 'Hälsa+');
});

// --- Over HTTP, against a real Hälsa+ ---------------------------------------------------

const NOW = Date.parse('2026-11-19T12:00:00Z');
const AS_OF = '2026-11-19T12:00:00.000Z';
const ANDREA_TOKEN = `hp_test_${randomBytes(18).toString('base64url')}`;
const servers: { close: () => void }[] = [];
let mmd = '';

async function listen(app: express.Express) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

before(async () => {
  const halsa = express();
  halsa.use('/halsa-plus', createApp({ database: openDatabase(':memory:'), corsOrigins: [], now: () => NOW, andreaToken: ANDREA_TOKEN }));
  process.env.HALSA_PLUS_URL = `${await listen(halsa)}/halsa-plus/api/v1`;

  const app = express();
  app.use('/api', express.json());
  setupHalsaLink(app);
  mmd = await listen(app);
});

after(() => {
  for (const server of servers) server.close();
  delete process.env.HALSA_ANDREA_TOKEN;
  delete process.env.HALSA_PLUS_URL;
});

const getJson = async (url: string, init?: RequestInit) => {
  const response = await fetch(mmd + url, init);
  const text = await response.text();
  assert.ok(!text.includes(ANDREA_TOKEN), 'the token must never reach the browser');
  return { status: response.status, body: JSON.parse(text) };
};

test('no link: the app endpoints answer 404', async () => {
  for (const url of [`/api/app/${ANDREA_GUID}/halsa`, `/api/app/${ANDREA_GUID}/halsa/latest`]) {
    const { status, body } = await getJson(url);
    assert.equal(status, 404);
    assert.equal(body.error, 'This patient has no Hälsa+ link.');
  }
});

test("reads Andrea's values from Hälsa+ with her token from HALSA_ANDREA_TOKEN", async () => {
  process.env.HALSA_ANDREA_TOKEN = ANDREA_TOKEN;
  try {
    const latest = await getJson(`/api/app/${ANDREA_GUID}/halsa/latest?type=glucose,sleep,blood-pressure&asOf=${AS_OF}`);
    assert.equal(latest.status, 200);
    assert.equal(Date.parse(latest.body.asOf), NOW);
    const glucose = latest.body.points.find((p: { series: string }) => p.series === 'glucose');
    assert.equal(glucose.device, 'CGM sensor (demo)');
    assert.equal(glucose.unit, 'mmol/L');
    assert.ok(Date.parse(glucose.time) <= NOW);
    const sleep = latest.body.points.find((p: { series: string }) => p.series === 'sleep');
    assert.equal(sleep.unit, 'h');
    assert.ok(sleep.value > 0 && sleep.value < 24, `sleep in hours, got ${sleep.value}`);
    assert.deepEqual(latest.body.points.map((p: { series: string }) => p.series).sort(), ['diastolic', 'glucose', 'sleep', 'systolic']);

    const from = new Date(NOW - 14 * 24 * 60 * 60 * 1000).toISOString();
    const series = await getJson(`/api/app/${ANDREA_GUID}/halsa?type=glucose&from=${from}&asOf=${AS_OF}`);
    assert.equal(series.status, 200);
    // A CGM reading about every 15 minutes for 14 days.
    assert.ok(series.body.points.length > 1000, `got ${series.body.points.length}`);
    const times = series.body.points.map((p: { time: string }) => Date.parse(p.time));
    assert.deepEqual(times, [...times].sort((a, b) => a - b));

    const bad = await getJson(`/api/app/${ANDREA_GUID}/halsa?type=crp`);
    assert.equal(bad.status, 400);

    // The environment token is used, not copied into MMD's database.
    assert.deepEqual(all('SELECT patient_guid FROM halsa_links'), []);
  } finally {
    delete process.env.HALSA_ANDREA_TOKEN;
  }
});

test('writes a rating to Hälsa+ and reads it back', async () => {
  saveHalsaLink(ANDREA_GUID, ANDREA_TOKEN, 'test');
  try {
    const written = await getJson(`/api/app/${ANDREA_GUID}/halsa/observations?asOf=${AS_OF}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'anxiety', value: 7 }),
    });
    assert.equal(written.status, 201);
    assert.deepEqual(
      written.body.points.map((p: { series: string; value: number; device: string; sourceType: string }) => [p.series, p.value, p.device, p.sourceType]),
      [['anxiety', 7, 'Hälsa+ app', 'patient-reported']],
    );
    const latest = await getJson(`/api/app/${ANDREA_GUID}/halsa/latest?type=anxiety&asOf=${AS_OF}`);
    assert.equal(latest.body.points[0].value, 7);

    for (const body of [{ type: 'glucose', value: 6 }, { type: 'stress', value: 11 }, { type: 'stress', value: 2.5 }]) {
      const refused = await getJson(`/api/app/${ANDREA_GUID}/halsa/observations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      assert.equal(refused.status, 400, JSON.stringify(body));
    }
  } finally {
    removeHalsaLink(ANDREA_GUID);
  }
});

test('a wrong token gives an error from Hälsa+, never a fallback', async () => {
  saveHalsaLink(ANDREA_GUID, 'hp_wrong_token_0123456789', 'test');
  try {
    const { status, body } = await getJson(`/api/app/${ANDREA_GUID}/halsa/latest`);
    assert.equal(status, 502);
    assert.match(body.error, /^Hälsa\+ answered 401/);
  } finally {
    removeHalsaLink(ANDREA_GUID);
  }
});

test("Andrea's delivered order is stored and shown in the app like any other", async () => {
  const parsed = await andreasPlan();
  assert.equal(storeDelivery(parsed, { channel: 'poll', connectionId: null }), 'created');
  const view = getAppView(ANDREA_GUID)!;
  assert.equal(view.patient.displayName, 'Andrea Lindqvist');
  assert.deepEqual(
    view.requests[0].activities.map((a) => a.title),
    ['CGM', 'Sleep', 'Veckorapport'],
  );
});
