import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, before, test } from 'node:test';
import express from 'express';

// The patient's reported values to the care team's system (valuesTarget
// 'careteam') or, switched back, to gateway.pdhc. Both are local stand-ins:
// the mock care team and a stub gateway. SYNTHETIC TEST DATA ONLY.
process.env.DATABASE_PATH = ':memory:';

const { ANDREA_GUID, getChannelSettings, saveChannelSettings, toChannelView, DEFAULTS } = await import('./careteam-channel.ts');
const { receiptIds, toObservation, valueReceipt } = await import('./careteam-values.ts');
const { reportStop } = await import('./report.ts');
const { parseDelivery } = await import('./fhir.ts');
const { applyPlanTemplates } = await import('./plandefinition.ts');
const { storeDelivery, getObservations } = await import('./store.ts');
const { all, now, run } = await import('./db.ts');
const { removeHalsaLink, saveHalsaLink, setupHalsaConsentGuard, setupHalsaLink } = await import('./halsa-link.ts');
const { startMockCareTeam } = await import('../scripts/mock-careteam.ts');
const { createApp } = await import('../halsa-plus/src/app.ts');
const { openDatabase } = await import('../halsa-plus/src/db.ts');

const fixture = (name: string) => JSON.parse(readFileSync(path.join(import.meta.dirname, 'fixtures', name), 'utf8'));
const SR = 'd6b81ca3-5149-46d5-9ba1-582716f263b2';
const TOKEN = `mock-token-${randomBytes(6).toString('hex')}`;
const ANDREA_TOKEN = `hp_test_${randomBytes(18).toString('base64url')}`;

type Mock = Awaited<ReturnType<typeof startMockCareTeam>>;
let mock: Mock;
let mmd = '';
const servers: { close: () => void }[] = [];
/** What the stub gateway.pdhc received at /provider/report/{sr}. */
const gatewayReports: { sr: string; body: any }[] = [];

async function listen(app: express.Express) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

before(async () => {
  mock = await startMockCareTeam(0, { token: TOKEN });

  const gateway = express();
  gateway.use(express.json());
  gateway.post('/provider/report/:sr', (req, res) => {
    gatewayReports.push({ sr: req.params.sr, body: req.body });
    res.status(202).json({ status: 'accepted', observations_stored: req.body.report_payload.observations.length, receipt_guid: 'rcpt-gw-1' });
  });
  const gatewayBase = await listen(gateway);
  const at = now();
  const connectionId = Number(
    run(
      `INSERT INTO connections (name, base_url, gateway_url, provider_token, poll_enabled, created_at, updated_at)
       VALUES ('PDHC test', :base, :base, 'test-provider-token', 0, :at, :at)`,
      { base: gatewayBase, at },
    ).lastInsertRowid,
  );
  // Andrea's real order (synthetic), as from a real connection: not demo mode.
  const parsed = parseDelivery(fixture('pdhc-download-andrea.json').fhir_resource, { patientGuid: ANDREA_GUID, grantToken: 'grant-test' });
  await applyPlanTemplates(parsed, async () => fixture('plandefinition-mmd-plan.json'));
  storeDelivery(parsed, { channel: 'poll', connectionId });

  // As in server/index.ts: the consent guard before the report route, with Hälsa+ in memory.
  const halsa = express();
  halsa.use('/halsa-plus', createApp({ database: openDatabase(':memory:'), corsOrigins: [], now: () => Date.now(), andreaToken: ANDREA_TOKEN }));
  process.env.HALSA_PLUS_URL = `${await listen(halsa)}/halsa-plus/api/v1`;
  const app = express();
  setupHalsaConsentGuard(app);
  app.use('/api', express.json());
  app.post('/api/app/:patient/report', async (req, res) => {
    res.status(201).json(await reportStop(req.params.patient, req.body));
  });
  setupHalsaLink(app);
  mmd = await listen(app);
});

after(async () => {
  await mock.stop();
  for (const server of servers) server.close();
  delete process.env.HALSA_PLUS_URL;
});

/** The channel set up as for Casper's system, values to the mock. */
function toCareTeam() {
  mock.values.length = 0;
  mock.valuesAnswer.status = null;
  saveChannelSettings({ token: TOKEN, valuesUrl: `${mock.base}/api/mmd`, valuesTarget: 'careteam' });
}

const bloodPressure = {
  serviceRequestGuid: SR,
  activityKey: '3-systolic-blood-pressure-diastolic-blood',
  stopIndex: 0,
  note: 'Mätt efter frukost.',
  values: [
    { name: 'systolic-blood-pressure', value: '128', device: 'Omron M7 (demo)' },
    { name: 'diastolic-blood-pressure', value: '82', device: 'Omron M7 (demo)' },
    { name: 'anxiety', value: '3' },
    { name: 'stress', value: '5' },
  ],
};

test('settings: valuesUrl and valuesTarget, with defaults, and the token never in the view', () => {
  saveChannelSettings({ valuesUrl: null, valuesTarget: undefined });
  const fresh = getChannelSettings();
  assert.equal(fresh.valuesUrl, 'https://nordic-hackathon-2026.onrender.com/api/mmd');
  assert.equal(DEFAULTS.valuesTarget, 'careteam');
  saveChannelSettings({ valuesTarget: 'pdhc', valuesUrl: 'http://localhost:4010/api/mmd/', token: TOKEN });
  assert.deepEqual([getChannelSettings().valuesTarget, getChannelSettings().valuesUrl], ['pdhc', 'http://localhost:4010/api/mmd']);
  assert.throws(() => saveChannelSettings({ valuesTarget: 'gateway' }), /careteam or pdhc/);
  assert.throws(() => saveChannelSettings({ valuesUrl: 'ftp://x' }), /values URL/);
  assert.ok(!JSON.stringify(toChannelView()).includes(TOKEN));
  saveChannelSettings({ valuesTarget: 'careteam' });
});

test('a report goes to the care team as one transaction Bundle, one Observation per value, with the token', async () => {
  toCareTeam();
  const gatewayBefore = gatewayReports.length;
  const result = await reportStop(ANDREA_GUID, bloodPressure);

  assert.equal(gatewayReports.length, gatewayBefore, 'gateway.pdhc is not called');
  assert.equal(mock.values.length, 1);
  const { bundle, authorization } = mock.values[0];
  assert.equal(authorization, `Bearer ${TOKEN}`);
  assert.equal(bundle.resourceType, 'Bundle');
  assert.equal(bundle.type, 'transaction');
  assert.equal(bundle.entry.length, 4);
  for (const entry of bundle.entry) {
    assert.deepEqual(entry.request, { method: 'POST', url: 'Observation' });
    assert.match(entry.fullUrl, /^urn:uuid:[0-9a-f-]{36}$/);
  }

  const [systolic, , anxiety] = bundle.entry.map((e: any) => e.resource);
  assert.equal(systolic.resourceType, 'Observation');
  assert.equal(systolic.status, 'final');
  assert.equal(systolic.category[0].coding[0].code, 'vital-signs');
  assert.deepEqual(systolic.subject, { reference: `Patient/${ANDREA_GUID}`, identifier: { system: 'urn:oid:1.2.752.129.2.1.3.1', value: '200207252388' } });
  assert.deepEqual(systolic.basedOn, [{ reference: `ServiceRequest/${SR}` }]);
  assert.equal(systolic.code.text, 'systolic-blood-pressure');
  assert.deepEqual(
    systolic.code.coding.map((c: any) => c.system),
    ['urn:pdhc:concept', 'urn:pdhc:transaction'],
    'the PDHC concept and transaction GUIDs, so the care team can match the plan activity',
  );
  assert.ok(systolic.code.coding.every((c: any) => typeof c.code === 'string' && c.code.length > 0));
  assert.deepEqual(systolic.valueQuantity, { value: 128, unit: 'mmHg', system: 'http://unitsofmeasure.org', code: 'mm[Hg]' });
  assert.equal(systolic.effectiveDateTime, result.observations[0].recordedAt);
  assert.deepEqual(systolic.device, { display: 'Omron M7 (demo)' });
  assert.deepEqual(systolic.note, [{ text: 'Mätt efter frukost.' }]);
  assert.deepEqual(
    systolic.meta.tag.map((t: any) => t.code),
    ['MMD', 'patient-reported'],
  );
  // A 1–7 rating is a survey answer, a plain number without a unit.
  assert.equal(anxiety.category[0].coding[0].code, 'survey');
  assert.deepEqual(anxiety.valueQuantity, { value: 3 });
  assert.equal(anxiety.device, undefined);

  // Sent and confirmed, as the app shows it; the care team's ids are the receipt.
  assert.equal(result.reportStatus, 'sent');
  assert.match(result.reportMessage, /Received by the care team/);
  assert.ok(result.observations.every((o) => o.reportStatus === 'sent' && o.confirmed));
  const receipts = result.observations.map((o) => valueReceipt(o.id));
  assert.ok(receipts.every((id) => typeof id === 'string' && id.startsWith('mock-obs-')), 'the Observation ids are stored');
  assert.equal(result.sent?.[0].receiptGuid, receipts.join(','));
  // The token is not in what the app gets back, nor in the channel log.
  assert.ok(!JSON.stringify(result).includes(TOKEN));
  assert.ok(!JSON.stringify(all('SELECT * FROM careteam_log')).includes(TOKEN));
});

test('a value without a number is sent as text; a unit UCUM does not know is kept as text', () => {
  const request = { guid: SR, patient_guid: 'someone-else' };
  const base = { id: 1, name: 'walk', recordedAt: '2026-11-20T08:00:00.000Z', note: null, transactionGuid: null, conceptGuid: null, device: null };
  const done = toObservation({ ...base, value: 'done', unit: null }, request) as any;
  assert.deepEqual([done.valueString, done.valueQuantity], ['done', undefined]);
  assert.deepEqual(done.code.coding, []);
  assert.deepEqual(done.subject, { reference: 'Patient/someone-else' }, "only Andrea's personnummer is added");
  const odd = toObservation({ ...base, value: '3,5', unit: 'laps' }, request) as any;
  assert.deepEqual(odd.valueQuantity, { value: 3.5, unit: 'laps' });
});

test("the receipt: ids from a transaction-response, a resource or a list, null where their answer names none", () => {
  assert.deepEqual(receiptIds({ resourceType: 'Bundle', type: 'transaction-response', entry: [{ response: { location: 'Observation/a/_history/1' } }, { resource: { id: 'b' } }] }, 3), ['a', 'b', null]);
  assert.deepEqual(receiptIds({ ids: ['x', 7] }, 2), ['x', '7']);
  assert.deepEqual(receiptIds({ resourceType: 'Observation', id: 'one' }, 1), ['one']);
  assert.deepEqual(receiptIds(null, 2), [null, null]);
});

test("a refused or unreachable care-team system marks the values failed, with a short message", async () => {
  toCareTeam();
  mock.valuesAnswer.status = 500;
  const refused = await reportStop(ANDREA_GUID, { ...bloodPressure, values: bloodPressure.values.slice(0, 1) });
  assert.equal(refused.reportStatus, 'failed');
  assert.match(refused.reportMessage, /answered 500/);
  assert.ok(refused.reportMessage.length < 200);
  assert.ok(refused.observations.every((o) => o.reportStatus === 'failed' && !o.confirmed));
  assert.equal(valueReceipt(refused.observations[0].id), undefined, 'no receipt');

  saveChannelSettings({ token: 'wrong-token' });
  const unauthorized = await reportStop(ANDREA_GUID, { ...bloodPressure, values: bloodPressure.values.slice(0, 1) });
  assert.match(unauthorized.reportMessage, /answered 401/);
  assert.ok(!unauthorized.reportMessage.includes('wrong-token'));

  saveChannelSettings({ token: TOKEN, valuesUrl: 'http://127.0.0.1:9/api/mmd' });
  const unreachable = await reportStop(ANDREA_GUID, { ...bloodPressure, values: bloodPressure.values.slice(0, 1) });
  assert.equal(unreachable.reportStatus, 'failed');
  assert.match(unreachable.reportMessage, /Could not reach the care team's system/);

  saveChannelSettings({ token: null, valuesUrl: `${mock.base}/api/mmd` });
  const noToken = await reportStop(ANDREA_GUID, { ...bloodPressure, values: bloodPressure.values.slice(0, 1) });
  assert.equal(noToken.reportStatus, 'failed');
  assert.match(noToken.reportMessage, /no token/);
  assert.equal(mock.values.length, 0, 'nothing was stored by the care team');

  // The values are stored here all the same, as before.
  assert.equal(getObservations([refused.observations[0].id]).length, 1);
});

test("consent is still required: without it nothing reaches the care team's system", async () => {
  toCareTeam();
  saveHalsaLink(ANDREA_GUID, ANDREA_TOKEN, 'test');
  const post = async (url: string, body: unknown) => {
    const response = await fetch(mmd + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const report = { ...bloodPressure, values: bloodPressure.values.slice(0, 2) };
  try {
    const refused = await post(`/api/app/${ANDREA_GUID}/report`, report);
    assert.equal(refused.status, 403);
    assert.equal(mock.values.length, 0);

    assert.equal((await post(`/api/app/${ANDREA_GUID}/halsa/consent/${SR}`, { decision: 'accept' })).status, 201);
    const sent = await post(`/api/app/${ANDREA_GUID}/report`, report);
    assert.equal(sent.status, 201);
    assert.equal(sent.body.reportStatus, 'sent');
    assert.equal(mock.values.length, 1);
    assert.equal(mock.values[0].bundle.entry.length, 2);
  } finally {
    removeHalsaLink(ANDREA_GUID);
  }
});

test("valuesTarget 'pdhc' still sends to gateway.pdhc, as before", async () => {
  toCareTeam();
  saveChannelSettings({ valuesTarget: 'pdhc' });
  const before = gatewayReports.length;
  const result = await reportStop(ANDREA_GUID, { serviceRequestGuid: SR, activityKey: '2-sleep-duration', stopIndex: 0, values: [{ name: 'sleep-duration', value: '7' }] });
  assert.equal(mock.values.length, 0, "the care team's system is not called");
  assert.equal(gatewayReports.length, before + 1);
  const { sr, body } = gatewayReports.at(-1)!;
  assert.equal(sr, SR);
  assert.equal(body.grant_token, 'grant-test');
  assert.equal(body.report_payload.observations[0].value, 7);
  assert.equal(result.reportStatus, 'sent');
  assert.equal(result.sent?.[0].receiptGuid, 'rcpt-gw-1');
  assert.match(result.reportMessage, /PDHC/);
  saveChannelSettings({ valuesTarget: 'careteam' });
});

test('a demo request stays in demo mode, whatever the target', async () => {
  toCareTeam();
  const { createDemo } = await import('./demo.ts');
  const { getPatientView } = await import('./store.ts');
  createDemo();
  const request = all<{ guid: string; patient_guid: string }>("SELECT guid, patient_guid FROM service_requests WHERE source = 'demo'")[0];
  const activity = getPatientView(request.patient_guid)!.requests.find((r) => r.guid === request.guid)!.activities[0];
  const result = await reportStop(request.patient_guid, { serviceRequestGuid: request.guid, activityKey: activity.key, stopIndex: 0, values: [] });
  assert.equal(result.reportStatus, 'demo');
  assert.equal(mock.values.length, 0);
});
