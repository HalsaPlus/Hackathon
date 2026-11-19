import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { createApp } from './app.ts';
import { openDatabase } from './db.ts';

// SYNTHETIC TEST DATA ONLY. The server's real clock is fixed to 2026-11-19 12:00Z.
// TOKEN is Andrea's (HALSA_ANDREA_TOKEN); other patients are tested in patients.test.ts.

const TOKEN = 'test-token-andrea-0123456789';
const NOW = Date.parse('2026-11-19T12:00:00Z');
let base = '';
let close: () => void;

before(async () => {
  const database = openDatabase(':memory:');
  const app = createApp({ database, andreaToken: TOKEN, corsOrigins: ['http://gui.test'], now: () => NOW, startDate: '2026-11-19' });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
  close = () => {
    server.close();
    database.close();
  };
});
after(() => close());

const get = (path: string, headers: Record<string, string> = { Authorization: `Bearer ${TOKEN}` }) => fetch(base + path, { headers });
// Response bodies are checked field by field below, so they are loosely typed here.
type Body = any;
const json = async (path: string): Promise<Body> => {
  const res = await get(path);
  assert.equal(res.status, 200, `${path}: ${await res.clone().text()}`);
  return res.json();
};

test('health needs no token; everything else does', async () => {
  assert.equal((await get('/api/v1/health', {})).status, 200);
  const res = await get('/api/v1/me', {});
  assert.equal(res.status, 401);
  assert.equal(((await res.json()) as Body).error.code, 'unauthorized');
  assert.equal((await get('/api/v1/me', { Authorization: 'Bearer wrong' })).status, 401);
});

test('me: Andrea with her personal identity number, marked synthetic', async () => {
  const me = await json('/api/v1/me');
  assert.equal(me.id, '28a29239-6424-48e7-a123-9d9e863670b8', 'the same guid as her patient in PDHC');
  assert.equal(me.name.text, 'Andrea Lindqvist');
  assert.equal(me.birthDate, '2002-07-25');
  assert.deepEqual(me.identifier, [{ system: 'urn:oid:1.2.752.129.2.1.3.1', value: '200207252388', display: '20020725-2388' }]);
  assert.equal(me.synthetic, true);
});

test('asOf hides what is not available yet; status marks simulated future values', async () => {
  const today = await json('/api/v1/observations?type=glucose&from=2026-11-19T00:00:00Z');
  assert.ok(today.items.length > 0);
  assert.ok(today.items.every((o: { effectiveDateTime: string }) => Date.parse(o.effectiveDateTime) <= NOW), 'nothing after the real now by default');
  assert.ok(today.items.every((o: { status: string }) => o.status === 'final'));

  const ahead = await json('/api/v1/observations?type=glucose&from=2026-11-19T00:00:00Z&asOf=2026-11-20T12:00:00Z');
  assert.ok(ahead.items.length > today.items.length);
  const statuses = new Set(ahead.items.map((o: { status: string }) => o.status));
  assert.deepEqual([...statuses].sort(), ['final', 'preliminary']);
  for (const o of ahead.items) assert.equal(o.status, Date.parse(o.effectiveDateTime) <= NOW ? 'final' : 'preliminary');

  // CRP in December is a simulated future value: hidden by default, preliminary when fast-forwarded.
  const crpNow = await json('/api/v1/observations?type=crp');
  assert.ok(crpNow.items.every((o: { status: string; issued: string }) => o.status === 'final' && Date.parse(o.issued) <= NOW));
  const crp = await json('/api/v1/observations?type=crp&asOf=2026-12-16T12:00:00Z');
  const future = crp.items.filter((o: { issued: string }) => Date.parse(o.issued) > NOW);
  assert.ok(future.length >= 1 && future.every((o: { status: string }) => o.status === 'preliminary'));
  assert.equal(crp.items.length, crpNow.items.length + future.length);
});

test('asOf outside the window, unknown types and bad cursors are 400', async () => {
  for (const [path, code] of [
    ['/api/v1/observations?asOf=2026-01-01T00:00:00Z', 'asof_out_of_range'],
    ['/api/v1/observations?asOf=2027-02-01T00:00:00Z', 'asof_out_of_range'],
    ['/api/v1/observations?type=steps', 'invalid_type'],
    ['/api/v1/observations?cursor=nonsense', 'invalid_cursor'],
    ['/api/v1/observations?limit=0', 'invalid_parameter'],
  ]) {
    const res = await get(path);
    assert.equal(res.status, 400, path);
    assert.equal(((await res.json()) as Body).error.code, code, path);
  }
});

test('pagination: pages follow each other without gaps or duplicates, oldest first', async () => {
  const all = await json('/api/v1/observations?type=glucose&from=2026-11-10T00:00:00Z&limit=5000');
  const seen: string[] = [];
  let cursor: string | null = null;
  do {
    const page: { items: { id: string }[]; nextCursor: string | null } = await json(
      `/api/v1/observations?type=glucose&from=2026-11-10T00:00:00Z&limit=200${cursor ? `&cursor=${cursor}` : ''}`,
    );
    seen.push(...page.items.map((o) => o.id));
    cursor = page.nextCursor;
  } while (cursor);
  assert.deepEqual(seen, all.items.map((o: { id: string }) => o.id));
  const times = all.items.map((o: { effectiveDateTime: string }) => o.effectiveDateTime);
  assert.deepEqual(times, [...times].sort());
});

test('devices: last sync never after asOf', async () => {
  const asOf = '2026-11-15T22:59:00Z';
  const { items } = await json(`/api/v1/devices?asOf=${asOf}`);
  assert.equal(items.length, 5);
  for (const d of items) assert.ok(d.lastSyncAt && d.lastSyncAt <= asOf, d.name);
  assert.equal(items.find((d: { type: string }) => d.type === 'cgm-sensor').lastSyncAt, '2026-11-15T22:52:00Z');
});

test('latest: one item per type', async () => {
  const { items } = await json('/api/v1/observations/latest?asOf=2026-11-15T22:59:00Z');
  assert.deepEqual(items.map((o: { type: string }) => o.type), ['blood-pressure', 'glucose', 'sleep', 'anxiety', 'stress', 'bmi', 'crp']);
  assert.equal(items[1].value, 11);
});

test('no interpretation or statistics anywhere in the responses', async () => {
  const bodies = [
    await json('/api/v1/observations?limit=5000&from=2026-08-01T00:00:00Z'),
    await json('/api/v1/observations/latest'),
    await json('/api/v1/devices'),
    await json('/api/v1/me'),
    await json('/api/v1/observations?format=fhir&type=crp,blood-pressure,bmi&limit=50'),
  ];
  const text = JSON.stringify(bodies);
  // Keys that would carry statistics, flags or ranges ("min" as a unit, minutes, is fine).
  for (const key of ['interpretation', 'referenceRange', 'mean', 'min', 'max', 'average', 'score', 'flag', 'color', 'colour', 'category']) {
    assert.ok(!text.includes(`"${key}":`) || (key === 'category' && !/"category":"(normal|high|low)/.test(text)), `found key ${key}`);
  }
  for (const word of ['normal', 'abnormal', '"high"', '"low"']) assert.ok(!text.includes(word), `found ${word}`);
});

test('FHIR: a searchset Bundle with LOINC/UCUM, device and performer references', async () => {
  const res = await get('/api/v1/observations?format=fhir&asOf=2026-12-16T12:00:00Z&type=crp,blood-pressure,anxiety&from=2026-11-15T00:00:00Z&limit=3');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /application\/fhir\+json/);
  const bundle: Body = await res.json();
  assert.equal(bundle.resourceType, 'Bundle');
  assert.equal(bundle.type, 'searchset');
  assert.ok(bundle.link.some((l: { relation: string }) => l.relation === 'next'));
  const bp = bundle.entry.map((e: { resource: unknown }) => e.resource).find((r: { code: { coding: { code: string }[] } }) => r.code.coding[0].code === '85354-9');
  assert.equal(bp.component[0].valueQuantity.code, 'mm[Hg]');
  assert.match(bp.device.reference, /^Device\//);
  assert.equal(bp.subject.identifier.value, '200207252388');

  const crp: Body = await (await get('/api/v1/observations?format=fhir&asOf=2026-12-16T12:00:00Z&type=crp')).json();
  const resources = crp.entry.map((e: { resource: unknown }) => e.resource);
  const below = resources.find((r: { status: string; valueQuantity: { comparator?: string } }) => r.status === 'preliminary' && r.valueQuantity.comparator);
  assert.deepEqual(below.valueQuantity, { comparator: '<', value: 5, unit: 'mg/L', system: 'http://unitsofmeasure.org', code: 'mg/L' });
  assert.ok(resources.every((r: { performer: { display: string }[] }) => r.performer[0].display === 'Laboratoire Belvasse'));
});

test('requests are an empty placeholder; consent validates the decision', async () => {
  assert.deepEqual(await json('/api/v1/requests'), { items: [] });
  const post = (body: unknown) =>
    fetch(`${base}/api/v1/requests/x/consent`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post({ decision: 'maybe' })).status, 400);
  const accepted = await post({ decision: 'accept' });
  assert.equal(accepted.status, 201);
  assert.equal(((await accepted.json()) as Body).status, 'accepted');
});

test('CORS only for the configured origins, and preflight works without a token', async () => {
  const ok = await fetch(`${base}/api/v1/me`, { method: 'OPTIONS', headers: { Origin: 'http://gui.test', 'Access-Control-Request-Method': 'GET' } });
  assert.equal(ok.status, 204);
  assert.equal(ok.headers.get('access-control-allow-origin'), 'http://gui.test');
  assert.match(ok.headers.get('access-control-allow-headers') ?? '', /Authorization/);
  const other = await get('/api/v1/health', { Origin: 'http://evil.test' });
  assert.equal(other.headers.get('access-control-allow-origin'), null);
});
