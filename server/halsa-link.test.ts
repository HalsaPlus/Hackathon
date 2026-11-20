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
const { ANDREA_GUID, halsaTokenFor, saveHalsaLink, removeHalsaLink, setupHalsaLink, setupHalsaConsentGuard, NO_CONSENT_MESSAGE } = await import('./halsa-link.ts');
const { halsaReading, measureAsOf, prefilledValue, cameFrom, maySend, requestedData } = await import('../src/app/halsa.ts');
const { getServiceRequestRow } = await import('./store.ts');
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
const reportsReached: unknown[] = [];
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

  // As in server/index.ts: the consent guard, then the API (here a stand-in
  // for Casper's report route that echoes what reached it), then Hälsa+.
  const app = express();
  setupHalsaConsentGuard(app);
  app.use('/api', express.json());
  app.post('/api/app/:patient/report', (req, res) => {
    reportsReached.push(req.body);
    res.status(201).json({ reached: true });
  });
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

// --- 1–7 ratings, overview, vaccinations, consent -------------------------------------

const SR = 'd6b81ca3-5149-46d5-9ba1-582716f263b2';

async function withAndreasRequest() {
  if (!getServiceRequestRow(SR)) storeDelivery(await andreasPlan(), { channel: 'poll', connectionId: null });
}

const post = (url: string, body: unknown) =>
  getJson(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('ratings are 1–7 for every Hälsa+ rating type, as entered', async () => {
  saveHalsaLink(ANDREA_GUID, ANDREA_TOKEN, 'test');
  try {
    for (const [type, value] of [['energy', 1], ['mood', 7], ['stress', 4], ['depression', 2]] as const) {
      const written = await post(`/api/app/${ANDREA_GUID}/halsa/observations?asOf=${AS_OF}`, { type, value });
      assert.equal(written.status, 201, type);
      assert.deepEqual([written.body.points[0].series, written.body.points[0].value, written.body.points[0].unit], [type, value, null]);
    }
    for (const value of [0, 8]) assert.equal((await post(`/api/app/${ANDREA_GUID}/halsa/observations`, { type: 'anxiety', value })).status, 400);
  } finally {
    removeHalsaLink(ANDREA_GUID);
  }
  // In the app: Hälsa+ ratings get the 1–7 scale and the label "Anxiety".
  const anxiety = halsaReading({ name: 'anxiety', conceptGuid: '739ae368-f0df-4b14-a6bb-98affed01e3d' }, { status: 'loading' })!;
  assert.deepEqual([anxiety.label, anxiety.rating], ['Anxiety', { min: 1, max: 7, low: 'Not at all', high: 'Very much' }]);
  assert.deepEqual(halsaReading({ name: 'mood' }, { status: 'loading' })!.rating, { min: 1, max: 7, low: 'Very low', high: 'Very high' });
});

test('overview: scores, "available/total" and each latest value ready to show', async () => {
  saveHalsaLink(ANDREA_GUID, ANDREA_TOKEN, 'test');
  try {
    const { status, body } = await getJson(`/api/app/${ANDREA_GUID}/halsa/overview?asOf=${AS_OF}`);
    assert.equal(status, 200);
    assert.equal(body.demoRanges, true);
    const byId = Object.fromEntries(body.categories.map((c: { id: string }) => [c.id, c]));
    for (const id of ['lungs', 'liver', 'urinary-tract']) {
      assert.deepEqual([byId[id].score, byId[id].available, byId[id].total], [null, 0, 2], id);
      assert.ok(byId[id].measures.every((m: { latest: unknown; range: unknown }) => m.latest === null && m.range === null));
    }
    for (const id of ['hormones', 'heart', 'mental-health']) assert.equal(typeof byId[id].score, 'number', id);
    assert.deepEqual([byId['mental-health'].available, byId['mental-health'].total], [6, 6]);
    const mental = Object.fromEntries(byId['mental-health'].measures.map((m: { id: string }) => [m.id, m]));
    assert.equal(mental.sleep.latest.unit, 'h');
    assert.equal(mental.sleep.range, '6–9 h');
    assert.equal(mental.sleep.latest.device, 'Smartwatch (demo)');
    assert.equal(mental.anxiety.latest.unit, 'of 7');
    assert.equal(mental.anxiety.range, '1–4');
    assert.match(byId.heart.measures[0].latest.value, /^\d+\/\d+$/);
    assert.equal(byId.heart.measures[0].range, '90–130 / 60–85 mmHg');
    assert.equal(byId.hormones.measures[0].range, '3.9–10 mmol/L');
    const scores = body.categories.map((c: { score: number | null }) => c.score).filter((s: number | null) => s !== null);
    assert.equal(body.healthScore, Math.round(scores.reduce((a: number, b: number) => a + b, 0) / scores.length));

    const vaccinations = await getJson(`/api/app/${ANDREA_GUID}/halsa/vaccinations`);
    assert.equal(vaccinations.status, 200);
    assert.ok(vaccinations.body.items.length >= 8);
  } finally {
    removeHalsaLink(ANDREA_GUID);
  }
});

test("the consent card names the plan's data in plain words", async () => {
  const parsed = await andreasPlan();
  assert.deepEqual(requestedData(parsed.carePlans[0]), ['CGM glucose', 'sleep', 'blood pressure', 'anxiety', 'stress']);
});

test('consent: no report reaches MMD for a linked patient until she has agreed; declining stops it again', async () => {
  await withAndreasRequest();
  saveHalsaLink(ANDREA_GUID, ANDREA_TOKEN, 'test');
  const report = { serviceRequestGuid: SR, activityKey: '1-cgm', stopIndex: 0, values: [{ name: 'CGM', value: '10.7' }] };
  try {
    const consentUrl = `/api/app/${ANDREA_GUID}/halsa/consent/${SR}`;
    assert.deepEqual((await getJson(consentUrl)).body, { decision: null, decidedAt: null, history: [] });

    const refused = await post(`/api/app/${ANDREA_GUID}/report`, report);
    assert.equal(refused.status, 403);
    assert.equal(refused.body.error, NO_CONSENT_MESSAGE);
    assert.equal(reportsReached.length, 0);

    const declined = await post(consentUrl, { decision: 'decline' });
    assert.equal(declined.status, 201);
    assert.equal(declined.body.decision, 'decline');
    assert.equal((await post(`/api/app/${ANDREA_GUID}/report`, report)).status, 403);

    const agreed = await post(consentUrl, { decision: 'accept' });
    assert.deepEqual([agreed.body.decision, agreed.body.history.length], ['accept', 2]);
    const sent = await post(`/api/app/${ANDREA_GUID}/report`, report);
    assert.equal(sent.status, 201);
    assert.deepEqual(reportsReached, [report], 'the body reaches the report route unchanged');

    // She changes her mind: blocked again. Every decision is kept.
    await post(consentUrl, { decision: 'decline' });
    assert.equal((await post(`/api/app/${ANDREA_GUID}/report`, report)).status, 403);
    assert.deepEqual((await getJson(consentUrl)).body.history.map((d: { decision: string }) => d.decision), ['decline', 'accept', 'decline']);

    assert.equal((await post(consentUrl, { decision: 'maybe' })).status, 400);
    assert.equal((await getJson(`/api/app/${ANDREA_GUID}/halsa/consent/someone-elses-plan`)).status, 404);
  } finally {
    removeHalsaLink(ANDREA_GUID);
    reportsReached.length = 0;
  }
});

test('consent: patients without a Hälsa+ link report exactly as before', async () => {
  const report = { serviceRequestGuid: 'c4e2a9b1-7d3f-4e5a-8b6c-9d0e1f2a3b42', activityKey: 'diabetes:glucose', stopIndex: 0, values: [] };
  const sent = await post('/api/app/a7d3c1e2-5b4f-4c6a-9e8d-2f1b0c3d4e51/report', report);
  assert.equal(sent.status, 201);
  assert.deepEqual(reportsReached, [report]);
  reportsReached.length = 0;
  // In the app: no link (404) or nothing to check leaves Send as it was.
  assert.equal(maySend({ status: 'unlinked' }), true);
  assert.equal(maySend({ status: 'idle' }), true);
  assert.equal(maySend({ status: 'ready', data: { decision: null, decidedAt: null, history: [] } }), false);
  assert.equal(maySend({ status: 'ready', data: { decision: 'decline', decidedAt: AS_OF, history: [] } }), false);
  assert.equal(maySend({ status: 'ready', data: { decision: 'accept', decidedAt: AS_OF, history: [] } }), true);
  assert.equal(maySend({ status: 'error', message: 'down' }), false);
});

test('consent: when Hälsa+ cannot answer, nothing is sent', async () => {
  saveHalsaLink(ANDREA_GUID, ANDREA_TOKEN, 'test');
  const url = process.env.HALSA_PLUS_URL;
  process.env.HALSA_PLUS_URL = 'http://127.0.0.1:9/halsa-plus/api/v1';
  try {
    const refused = await post(`/api/app/${ANDREA_GUID}/report`, { serviceRequestGuid: SR, activityKey: '1-cgm', stopIndex: 0, values: [] });
    assert.equal(refused.status, 502);
    assert.match(refused.body.error, /nothing was sent/);
    assert.equal(reportsReached.length, 0);
  } finally {
    process.env.HALSA_PLUS_URL = url;
    removeHalsaLink(ANDREA_GUID);
  }
});

test('Measure shows readable labels for PDHC concept names; what is sent keeps the concept name', async () => {
  const { conceptLabel } = await import('../src/app/halsa.ts');
  const parsed = await andreasPlan();
  const transactions = parsed.carePlans[0].activities.flatMap((a) => a.transactions);
  assert.deepEqual(
    transactions.map((t) => [t.name, conceptLabel(t)]),
    [
      ['CGM', 'Glucose (CGM)'],
      ['sleep-duration', 'Sleep duration'],
      ['systolic-blood-pressure', 'Systolic blood pressure'],
      ['diastolic-blood-pressure', 'Diastolic blood pressure'],
      ['anxiety', 'Anxiety'],
      ['stress', 'Stress'],
    ],
  );
  assert.equal(conceptLabel({ name: 'asthma-peak-flow' }), 'Asthma peak flow');
  // Names that are already text stay as they are (Casper's demo plans).
  assert.equal(conceptLabel({ name: 'Morning stiffness (0–10)' }), 'Morning stiffness (0–10)');
  assert.equal(conceptLabel({ name: 'FEV1' }), 'FEV1');
});

test('overview: each measure names its series and its demo band in display units, for the category graphs', async () => {
  saveHalsaLink(ANDREA_GUID, ANDREA_TOKEN, 'test');
  try {
    const { body } = await getJson(`/api/app/${ANDREA_GUID}/halsa/overview?asOf=${AS_OF}`);
    const measure = (category: string, id: string) =>
      body.categories.find((c: { id: string }) => c.id === category).measures.find((m: { id: string }) => m.id === id);
    assert.deepEqual(measure('mental-health', 'sleep').series, ['sleep']);
    assert.deepEqual(measure('mental-health', 'sleep').bands, [{ series: 'sleep', low: 6, high: 9 }]);
    assert.deepEqual(measure('mental-health', 'energy').bands, [{ series: 'energy', low: 4, high: 7 }]);
    assert.deepEqual(measure('heart', 'blood-pressure').series, ['systolic', 'diastolic']);
    assert.deepEqual(measure('heart', 'blood-pressure').bands, [
      { series: 'systolic', low: 90, high: 130 },
      { series: 'diastolic', low: 60, high: 85 },
    ]);
    assert.deepEqual(measure('hormones', 'glucose').bands, [{ series: 'glucose', low: 3.9, high: 10 }]);
    assert.deepEqual([measure('lungs', 'peak-flow').series, measure('lungs', 'peak-flow').bands], [[], []]);
  } finally {
    removeHalsaLink(ANDREA_GUID);
  }
});
