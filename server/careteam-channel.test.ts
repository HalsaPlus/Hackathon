import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, before, test } from 'node:test';
import express from 'express';

// The care-team chat channel against the mock care team (scripts/mock-careteam.ts).
// SYNTHETIC TEST DATA ONLY. Use a throwaway database: set before db.ts loads.
process.env.DATABASE_PATH = ':memory:';

const channel = await import('./careteam-channel.ts');
const { ANDREA_GUID, buildOutboundBundle, chatStatus, deliver, getChannelSettings, pollOnce, receiveBundle, saveChannelSettings, sendPending, setupCareTeamChannel, setupCareTeamInbound } = channel;
const { parseDelivery } = await import('./fhir.ts');
const { applyPlanTemplates } = await import('./plandefinition.ts');
const { addMessage, listMessages, storeDelivery } = await import('./store.ts');
const { createDemo } = await import('./demo.ts');
const { all, get } = await import('./db.ts');
const { startMockCareTeam } = await import('../scripts/mock-careteam.ts');

const fixture = (name: string) => JSON.parse(readFileSync(path.join(import.meta.dirname, 'fixtures', name), 'utf8'));
const ANDREAS_PLAN = 'd6b81ca3-5149-46d5-9ba1-582716f263b2';
const PUSH_SECRET = 'push-secret-for-tests-0123456789';
const OFF = { enabled: false, endpointUrl: '', token: '', pushSecret: '', receiveMode: 'poll', payloadFormat: 'r5' };

type Mock = Awaited<ReturnType<typeof startMockCareTeam>>;
let mock: Mock;
let mmd = '';
const servers: { close: () => void }[] = [];

before(async () => {
  // Andrea's order as delivered (fixtures), so she is a patient in MMD.
  const parsed = parseDelivery(fixture('pdhc-download-andrea.json').fhir_resource, { patientGuid: ANDREA_GUID });
  await applyPlanTemplates(parsed, async () => fixture('plandefinition-mmd-plan.json'));
  storeDelivery(parsed, { channel: 'poll', connectionId: null });
  createDemo(); // Casper's demo patient, a different GUID.

  mock = await startMockCareTeam(0, { token: 'mock-token' });
  const app = express();
  setupCareTeamInbound(app);
  app.use('/api', express.json());
  setupCareTeamChannel(app, { timers: false });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  servers.push(server);
  mmd = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  for (const server of servers) server.close();
  await mock.stop();
});

const on = (extra: Record<string, unknown> = {}) =>
  saveChannelSettings({ ...OFF, enabled: true, endpointUrl: `${mock.base}/fhir`, token: 'mock-token', ...extra });
const deliveryOf = (id: number) => get<{ status: string; detail: string; remote_id: string | null; attempts: number }>('SELECT * FROM careteam_deliveries WHERE message_id = :id', { id });

test('not configured: the chat is unchanged and nothing is sent or accepted', async () => {
  saveChannelSettings(OFF);
  const message = addMessage(ANDREA_GUID, 'patient', 'A message while the channel is off.');
  assert.equal(await sendPending(), 0);
  assert.equal(deliveryOf(message.id), undefined);
  assert.deepEqual(chatStatus(ANDREA_GUID), { enabled: false, deliveries: {}, senders: {} });
  assert.equal((await fetch(`${mmd}/api/app/${ANDREA_GUID}/careteam`).then((r) => r.json())).enabled, false);
  const push = await fetch(`${mmd}/api/v1/inbound/message`, { method: 'POST', headers: { 'Content-Type': 'application/fhir+json', 'X-Push-Secret': PUSH_SECRET }, body: '{}' });
  assert.equal(push.status, 404);
});

test("the outbound FHIR message: MessageHeader first, focus on the Communication, subject = Andrea's GUID", () => {
  const settings = on();
  const message = { id: 41, patientGuid: ANDREA_GUID, sender: 'patient' as const, text: 'Hej, sömnen är sämre.', serviceRequestGuid: null, createdAt: '2026-11-20T09:00:00.000Z' };
  const bundle = buildOutboundBundle(message, settings);
  assert.equal(bundle.resourceType, 'Bundle');
  assert.equal(bundle.type, 'message');
  const [header, communication, patient] = bundle.entry.map((e: { resource: Record<string, any> }) => e.resource);
  assert.equal(header.resourceType, 'MessageHeader');
  assert.deepEqual(header.eventCoding, { system: 'https://mmd.halsaplus.se/fhir/event', code: 'patient-message' });
  assert.equal(header.source.endpointUrl, 'https://mmd-hackathon.onrender.com');
  assert.deepEqual(header.destination, [{ name: 'Care team', endpointUrl: `${mock.base}/fhir` }]);
  assert.equal(header.focus[0].reference, bundle.entry[1].fullUrl);
  assert.equal(communication.resourceType, 'Communication');
  assert.equal(communication.subject.reference, `Patient/${ANDREA_GUID}`);
  assert.deepEqual(communication.subject.identifier, { system: 'urn:oid:1.2.752.129.2.1.3.1', value: '200207252388' });
  assert.equal(communication.sender.reference, `Patient/${ANDREA_GUID}`);
  assert.deepEqual(communication.recipient, [{ display: 'Care team' }]);
  assert.deepEqual(communication.basedOn, [{ reference: `ServiceRequest/${ANDREAS_PLAN}` }]);
  assert.deepEqual(communication.about, [{ reference: `ServiceRequest/${ANDREAS_PLAN}` }]);
  assert.equal(communication.sent, '2026-11-20T09:00:00.000Z');
  assert.equal(communication.meta.tag[0].code, 'patient-reported');
  assert.deepEqual(communication.payload, [{ contentCodeableConcept: { text: 'Hej, sömnen är sämre.' } }]);
  assert.deepEqual([patient.resourceType, patient.id, patient.birthDate], ['Patient', ANDREA_GUID, '2002-07-25']);
  // payloadFormat r4: payload.contentString instead.
  const r4 = buildOutboundBundle(message, { ...settings, payloadFormat: 'r4' });
  assert.deepEqual(r4.entry[1].resource.payload, [{ contentString: 'Hej, sömnen är sämre.' }]);
});

test('outbound: only messages written after the channel was turned on are delivered, once', async () => {
  saveChannelSettings(OFF);
  const older = addMessage(ANDREA_GUID, 'patient', 'Written before the channel was on.');
  on();
  const message = addMessage(ANDREA_GUID, 'patient', 'Hello care team, from the app.');
  const careTeam = addMessage(ANDREA_GUID, 'care-team', 'Typed by us in the admin page.');
  const other = addMessage('a7d3c1e2-5b4f-4c6a-9e8d-2f1b0c3d4e51', 'patient', 'Another patient.');
  const before = mock.received.length;
  assert.equal(await sendPending(), 1);
  assert.equal(mock.received.length, before + 1);
  const delivered = mock.received.at(-1)!.entry[1].resource;
  assert.equal(delivered.payload[0].contentCodeableConcept.text, 'Hello care team, from the app.');
  assert.equal(deliveryOf(message.id)!.status, 'delivered');
  assert.match(deliveryOf(message.id)!.remote_id!, /^mock-received-/);
  for (const m of [older, careTeam, other]) assert.equal(deliveryOf(m.id), undefined);
  assert.equal(await sendPending(), 0, 'not sent twice');
  assert.equal(chatStatus(ANDREA_GUID).deliveries[message.id].status, 'delivered');
});

test('outbound: a 4xx answer and a network error are kept as failed', async () => {
  on({ token: 'wrong-token' });
  const rejected = addMessage(ANDREA_GUID, 'patient', 'Sent with the wrong token.');
  await sendPending();
  assert.equal(deliveryOf(rejected.id)!.status, 'failed');
  assert.match(deliveryOf(rejected.id)!.detail, /^The care team answered 401/);
  assert.equal(deliveryOf(rejected.id)!.attempts, 1, 'a 4xx is not tried again at once');

  on({ endpointUrl: 'http://127.0.0.1:9/fhir' });
  const unreachable = addMessage(ANDREA_GUID, 'patient', 'Nobody is listening.');
  await deliver(unreachable.id);
  assert.equal(deliveryOf(unreachable.id)!.status, 'failed');
  assert.match(deliveryOf(unreachable.id)!.detail, /^Could not reach the care team/);
  assert.equal(deliveryOf(unreachable.id)!.attempts, 2, 'a network error is tried once more');

  // "Retry" in the admin console, once the endpoint is right again.
  on();
  const retried = await fetch(`${mmd}/api/careteam-channel/deliveries/${rejected.id}/retry`, { method: 'POST' }).then((r) => r.json());
  assert.equal(retried.status, 'delivered');
  assert.equal(deliveryOf(rejected.id)!.status, 'delivered');
  // The token never reaches the admin console.
  const admin = await fetch(`${mmd}/api/careteam-channel`).then((r) => r.text());
  assert.ok(!admin.includes('mock-token'));
  assert.match(admin, /"tokenHint":"…oken"/);
});

test('inbound, poll: a reply from the care team appears in the chat once, with the sender name', async () => {
  on({ receiveMode: 'poll' });
  await fetch(`${mock.base}/reply`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Hej Andrea! Vi ringer dig i morgon.', sender: 'Nurse Eva (demo)' }) });
  const first = await pollOnce();
  assert.deepEqual('stored' in first && first.stored, 1);
  const chat = listMessages(ANDREA_GUID);
  const reply = chat.at(-1)!;
  assert.deepEqual([reply.sender, reply.text], ['care-team', 'Hej Andrea! Vi ringer dig i morgon.']);
  assert.equal(chatStatus(ANDREA_GUID).senders[reply.id], 'Nurse Eva (demo)');
  // The next poll asks only for what is newer, and stores nothing twice.
  const second = await pollOnce();
  assert.deepEqual('stored' in second && second.stored, 0);
  assert.equal(listMessages(ANDREA_GUID).length, chat.length);
});

test('inbound is idempotent, ignores our own messages and rejects other patients', () => {
  const settings = on();
  const communication = (id: string, subject: string, text: string, extra: Record<string, unknown> = {}) => ({
    resourceType: 'Communication',
    id,
    subject: { reference: `Patient/${subject}` },
    sender: { display: 'Dr. Berg (demo)' },
    sent: new Date().toISOString(),
    payload: [{ contentString: text }],
    ...extra,
  });
  const bundle = {
    resourceType: 'Bundle',
    type: 'searchset',
    entry: [
      { resource: communication('ct-1', ANDREA_GUID, 'R4-style text.') },
      { resource: communication('mmd-message-7', ANDREA_GUID, 'Our own, echoed back.', { meta: { source: 'MMD' } }) },
      { resource: communication('ct-2', ANDREA_GUID, 'Written by Andrea.', { sender: { reference: `Patient/${ANDREA_GUID}` } }) },
      { resource: communication('ct-3', 'a7d3c1e2-5b4f-4c6a-9e8d-2f1b0c3d4e51', 'For someone else.') },
    ],
  };
  const count = listMessages(ANDREA_GUID).length;
  assert.deepEqual(receiveBundle(bundle, settings), { stored: 1, duplicates: 0, ignored: 2, rejected: 1, latest: bundle.entry[0].resource.sent });
  assert.deepEqual(receiveBundle(bundle, settings).duplicates, 1);
  assert.equal(listMessages(ANDREA_GUID).length, count + 1);
  assert.equal(listMessages('a7d3c1e2-5b4f-4c6a-9e8d-2f1b0c3d4e51').some((m) => m.text === 'For someone else.'), false);
  assert.ok(all<{ detail: string }>("SELECT detail FROM careteam_log WHERE outcome = 'rejected'").some((l) => /another patient/.test(l.detail)));
});

test('inbound, push: X-Push-Secret is required; the mock pushes a reply that is stored at once', async () => {
  on({ receiveMode: 'push', pushSecret: PUSH_SECRET });
  const post = (secret: string | null, body: unknown) =>
    fetch(`${mmd}/api/v1/inbound/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/fhir+json', ...(secret === null ? {} : { 'X-Push-Secret': secret }) },
      body: JSON.stringify(body),
    });
  assert.equal((await post(null, {})).status, 401);
  assert.equal((await post('wrong-secret-0123456789', {})).status, 401);

  const pusher = await startMockCareTeam(0, { pushUrl: `${mmd}/api/v1/inbound/message`, pushSecret: PUSH_SECRET, format: 'r5' });
  try {
    const reply = await fetch(`${pusher.base}/reply`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Pushed reply.' }) }).then((r) => r.json());
    assert.equal(reply.pushed, 200);
    assert.equal(listMessages(ANDREA_GUID).at(-1)!.text, 'Pushed reply.');
  } finally {
    await pusher.stop();
  }
  // The answer is a FHIR response message.
  const answer = await post(PUSH_SECRET, { resourceType: 'Bundle', type: 'message', entry: [{ resource: { resourceType: 'MessageHeader', id: 'h-1' } }] }).then((r) => r.json());
  assert.deepEqual(answer.entry[0].resource.response, { identifier: 'h-1', code: 'ok' });
});

test('settings: secrets are write-only, URLs are checked, and the patient defaults to Andrea', () => {
  on({ token: 'abcd-efgh-1234', pushSecret: PUSH_SECRET });
  const view = channel.toChannelView();
  assert.equal(view.tokenHint, '…1234');
  assert.equal(view.pushSecretHint, '…6789');
  assert.ok(!JSON.stringify(view).includes('abcd-efgh-1234'));
  assert.equal(view.patientGuid, ANDREA_GUID);
  assert.throws(() => saveChannelSettings({ endpointUrl: 'ftp://example.org' }), /must start with https/);
  assert.throws(() => saveChannelSettings({ pushSecret: 'short' }), /at least 16/);
  assert.throws(() => saveChannelSettings({ receiveMode: 'email' }), /poll, push or off/);
  assert.equal(getChannelSettings().authHeader, 'Authorization: Bearer {token}');
  assert.deepEqual(channel.authHeaders({ ...getChannelSettings(), authHeader: 'X-Api-Key' }), { 'X-Api-Key': 'abcd-efgh-1234' });
  saveChannelSettings(OFF);
});
