import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, before, test } from 'node:test';
import express from 'express';

// Live updates over the WebSocket (server/live.ts) with Casper's real login.
// SYNTHETIC TEST DATA ONLY. Set before db.ts and auth.ts load.
process.env.DATABASE_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'live-test-password-0123456789';

const { setupAuth } = await import('./auth.ts');
const live = await import('./live.ts');
const { ANDREA_GUID, resetOnDemandPolling, saveChannelSettings, setupCareTeamChannel } = await import('./careteam-channel.ts');
const { parseDelivery } = await import('./fhir.ts');
const { applyPlanTemplates } = await import('./plandefinition.ts');
const { addMessage, markSeen, storeDelivery } = await import('./store.ts');
const { reportStop } = await import('./report.ts');
const { createDemo } = await import('./demo.ts');
const { startMockCareTeam } = await import('../scripts/mock-careteam.ts');
const { createLiveClient } = await import('../src/app/live.ts');

const fixture = (name: string) => JSON.parse(readFileSync(path.join(import.meta.dirname, 'fixtures', name), 'utf8'));
const OTHER = 'a7d3c1e2-5b4f-4c6a-9e8d-2f1b0c3d4e51';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let base = '';
let cookie = '';
let mock: Awaited<ReturnType<typeof startMockCareTeam>>;
const httpServer = createServer();

before(async () => {
  const parsed = parseDelivery(fixture('pdhc-download-andrea.json').fhir_resource, { patientGuid: ANDREA_GUID });
  await applyPlanTemplates(parsed, async () => fixture('plandefinition-mmd-plan.json'));
  storeDelivery(parsed, { channel: 'poll', connectionId: null });
  createDemo(); // Casper's demo patient: another GUID

  const app = express();
  setupAuth(app);
  app.use('/api', express.json());
  setupCareTeamChannel(app, { timers: false });
  live.setupLive(httpServer, app, { watchMs: 50, fastPollMs: 100 });
  httpServer.on('request', app);
  httpServer.listen(0, '127.0.0.1');
  await new Promise((resolve) => httpServer.once('listening', resolve));
  base = `127.0.0.1:${(httpServer.address() as AddressInfo).port}`;

  const login = await fetch(`http://${base}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'admin', password: process.env.ADMIN_PASSWORD!, next: '/' }),
    redirect: 'manual',
  });
  cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
  assert.ok(cookie, 'signed in');
  mock = await startMockCareTeam(0);
});

after(async () => {
  live.dropAllLiveClients();
  httpServer.close();
  await mock.stop();
});

const ticket = async (withCookie = true) => {
  const res = await fetch(`http://${base}/api/live/ticket`, { method: 'POST', headers: withCookie ? { Cookie: cookie } : {} });
  return { status: res.status, ticket: res.ok ? ((await res.json()) as { ticket: string }).ticket : null };
};

/** A connected, subscribed socket that collects what it receives. */
async function connect(patientGuid: string) {
  const { ticket: t } = await ticket();
  const socket = new WebSocket(`ws://${base}/ws?ticket=${t}`);
  const received: any[] = [];
  socket.onmessage = (event) => received.push(JSON.parse(String(event.data)));
  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve();
    socket.onerror = () => reject(new Error('could not connect'));
  });
  socket.send(JSON.stringify({ type: 'subscribe', patientGuid }));
  await waitFor(() => received.some((m) => m.type === 'subscribed'));
  return { socket, received, topics: () => received.filter((m) => m.type === 'changed').flatMap((m) => m.topics as string[]) };
}

async function waitFor(check: () => boolean, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await sleep(20);
  }
  return check();
}

const opens = (url: string) =>
  new Promise<boolean>((resolve) => {
    const socket = new WebSocket(url);
    socket.onopen = () => {
      socket.close();
      resolve(true);
    };
    socket.onerror = () => resolve(false);
  });

test("sign-in: a ticket needs Casper's login, and /ws needs a fresh ticket, once", async () => {
  assert.equal((await ticket(false)).status, 401, 'no session cookie, no ticket');
  assert.equal(await opens(`ws://${base}/ws`), false, 'no ticket');
  assert.equal(await opens(`ws://${base}/ws?ticket=made-up`), false, 'wrong ticket');
  const { ticket: t } = await ticket();
  assert.equal(await opens(`ws://${base}/ws?ticket=${t}`), true, 'a fresh ticket');
  assert.equal(await opens(`ws://${base}/ws?ticket=${t}`), false, 'the same ticket again');
});

test('events go to the subscribers of that patient only', async () => {
  const andrea = await connect(ANDREA_GUID);
  const other = await connect(OTHER);
  addMessage(ANDREA_GUID, 'patient', 'Hej från Andrea (test).');
  assert.ok(await waitFor(() => andrea.topics().includes('messages')));
  await sleep(200);
  assert.deepEqual(other.topics(), []);
  addMessage(OTHER, 'care-team', 'Till den andra patienten.');
  assert.ok(await waitFor(() => other.topics().includes('messages')));
  andrea.socket.close();
  other.socket.close();
});

test('events for a report (observations, stops), a new request, a plan opened and consent', async () => {
  const andrea = await connect(ANDREA_GUID);
  await reportStop(ANDREA_GUID, { serviceRequestGuid: 'd6b81ca3-5149-46d5-9ba1-582716f263b2', activityKey: '2-sleep-duration', stopIndex: 0, values: [{ name: 'sleep-duration', value: '7' }] });
  assert.ok(await waitFor(() => andrea.topics().includes('observations') && andrea.topics().includes('stops')));

  const second = parseDelivery({ ...fixture('pdhc-download-andrea.json').fhir_resource, id: 'live-test-new-request' }, { patientGuid: ANDREA_GUID });
  storeDelivery(second, { channel: 'poll', connectionId: null });
  andrea.received.length = 0;
  assert.ok(await waitFor(() => andrea.topics().includes('requests')), 'a new request from PDHC');
  andrea.received.length = 0;
  markSeen('live-test-new-request');
  assert.ok(await waitFor(() => andrea.topics().includes('requests')), 'the plan opened');

  andrea.received.length = 0;
  live.notifyChanged(ANDREA_GUID, ['consent']); // what our consent route does after storing a decision
  assert.ok(await waitFor(() => andrea.topics().includes('consent')));
  andrea.socket.close();
});

test('mirror: what the driver sends reaches the other subscribers of the patient, not the driver', async () => {
  const driver = await connect(ANDREA_GUID);
  const follower = await connect(ANDREA_GUID);
  driver.socket.send(JSON.stringify({ type: 'role', role: 'drive' }));
  follower.socket.send(JSON.stringify({ type: 'role', role: 'follow' }));
  assert.ok(await waitFor(() => follower.received.some((m) => m.type === 'driver' && m.present === true)));
  const state = { hash: '#/chat', draft: 'Hej, jag har ont', scroll: 0.5, sliders: {}, press: null };
  driver.socket.send(JSON.stringify({ type: 'mirror', state }));
  assert.ok(await waitFor(() => follower.received.some((m) => m.type === 'mirror' && m.state.draft === 'Hej, jag har ont')));
  assert.equal(driver.received.some((m) => m.type === 'mirror'), false);
  driver.socket.close();
  follower.socket.close();
});

test('chat-visible: the care team is asked every second while the chat is visible, and not after', async () => {
  saveChannelSettings({ enabled: true, endpointUrl: `${mock.base}/fhir`, token: 'mock-token', receiveMode: 'poll', pollPath: 'Communication?_since={since}' });
  resetOnDemandPolling();
  const andrea = await connect(ANDREA_GUID);
  const before = mock.stats.polls;
  andrea.socket.send(JSON.stringify({ type: 'chat-visible', value: true }));
  await sleep(2300);
  const during = mock.stats.polls - before;
  assert.ok(during >= 2 && during <= 4, `about one a second while visible, got ${during}`);
  andrea.socket.send(JSON.stringify({ type: 'chat-visible', value: false }));
  await sleep(200);
  const stopped = mock.stats.polls;
  await sleep(1500);
  assert.equal(mock.stats.polls, stopped, 'no fast polls once the chat is not visible');
  andrea.socket.close();
  saveChannelSettings({ enabled: false });
});

test("the app's live client subscribes, reconnects after the connection drops, and keeps getting events", async () => {
  const messages: any[] = [];
  const client = createLiveClient({
    getTicket: async () => (await ticket()).ticket,
    openSocket: (t) => new WebSocket(`ws://${base}/ws?ticket=${t}`) as never,
  });
  client.onMessage((m) => messages.push(m));
  client.start(ANDREA_GUID);
  assert.ok(await waitFor(() => client.isConnected() && messages.some((m) => m.type === 'subscribed')));

  live.dropAllLiveClients(); // the server restarts or the network drops
  assert.ok(await waitFor(() => !client.isConnected(), 1000));
  assert.ok(await waitFor(() => client.isConnected(), 3000), 'reconnected');
  messages.length = 0;
  addMessage(ANDREA_GUID, 'care-team', 'Efter återanslutning.');
  assert.ok(await waitFor(() => messages.some((m) => m.type === 'changed' && m.topics.includes('messages'))));
  client.stop();
});

test('take control: one driver per patient; the previous driver becomes a follower, and only the driver is mirrored', async () => {
  const a = await connect(ANDREA_GUID);
  const b = await connect(ANDREA_GUID);
  const roleOf = (c: { received: any[] }) => c.received.filter((m) => m.type === 'role').at(-1)?.role;
  const mirror = (c: { socket: WebSocket }, draft: string) =>
    c.socket.send(JSON.stringify({ type: 'mirror', state: { hash: '#/chat', draft, scroll: 0, sliders: {}, press: null } }));
  const sawDraft = (c: { received: any[] }, draft: string) => c.received.some((m) => m.type === 'mirror' && m.state.draft === draft);

  a.socket.send(JSON.stringify({ type: 'role', role: 'drive' }));
  b.socket.send(JSON.stringify({ type: 'role', role: 'follow' }));
  assert.ok(await waitFor(() => roleOf(a) === 'drive' && roleOf(b) === 'follow'));

  // B takes control: A is told it now follows.
  b.socket.send(JSON.stringify({ type: 'role', role: 'drive' }));
  assert.ok(await waitFor(() => roleOf(b) === 'drive' && roleOf(a) === 'follow'));
  mirror(a, 'from A, no longer the driver');
  mirror(b, 'from B, the driver');
  assert.ok(await waitFor(() => sawDraft(a, 'from B, the driver')));
  await sleep(150);
  assert.equal(sawDraft(b, 'from A, no longer the driver'), false, "a follower's state is not passed on");

  // A takes control back.
  a.socket.send(JSON.stringify({ type: 'role', role: 'drive' }));
  assert.ok(await waitFor(() => roleOf(a) === 'drive' && roleOf(b) === 'follow'));

  // A hands over: nobody drives, and everyone hears it.
  a.socket.send(JSON.stringify({ type: 'role', role: 'follow' }));
  assert.ok(await waitFor(() => b.received.filter((m) => m.type === 'driver').at(-1)?.present === false));
  a.socket.close();
  b.socket.close();
});
