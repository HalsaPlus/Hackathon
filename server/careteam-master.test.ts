import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';

// The care team's system as the MASTER of Andrea's chat (poll mode): every
// fetch mirrors all its Communications for her. SYNTHETIC TEST DATA ONLY.
process.env.DATABASE_PATH = ':memory:';

const channel = await import('./careteam-channel.ts');
const { ANDREA_GUID, channelEvents, chatStatus, pollOnce, saveChannelSettings, sendPending } = channel;
const { parseDelivery } = await import('./fhir.ts');
const { applyPlanTemplates } = await import('./plandefinition.ts');
const { addMessage, listMessages, storeDelivery } = await import('./store.ts');
const { all, run } = await import('./db.ts');
const { startMockCareTeam } = await import('../scripts/mock-careteam.ts');

const fixture = (name: string) => JSON.parse(readFileSync(path.join(import.meta.dirname, 'fixtures', name), 'utf8'));
const ALIAS = 'a7d3c1e2-5b4f-4c6a-9e8d-2f1b0c3d4e51';
type Mock = Awaited<ReturnType<typeof startMockCareTeam>>;
let mock: Mock;

before(async () => {
  const parsed = parseDelivery(fixture('pdhc-download-andrea.json').fhir_resource, { patientGuid: ANDREA_GUID });
  await applyPlanTemplates(parsed, async () => fixture('plandefinition-mmd-plan.json'));
  storeDelivery(parsed, { channel: 'poll', connectionId: null });
  mock = await startMockCareTeam(0, { echo: 'remote-id' });
});

after(async () => {
  await mock.stop();
});

/** The channel on, poll mode, Casper's search; and a clean care-team system. */
function freshChannel(endpointUrl = `${mock.base}/fhir`) {
  saveChannelSettings({ enabled: false });
  mock.replies.length = 0;
  return saveChannelSettings({ enabled: true, endpointUrl, token: 'mock-token', receiveMode: 'poll', pollPath: 'Communication?_since={since}' });
}

const communication = (id: string, from: 'patient' | 'care-team', text: string, sent: string, subject = ALIAS) => ({
  resourceType: 'Communication',
  id,
  status: 'completed',
  subject: { reference: `Patient/${subject}` },
  sender: from === 'patient' ? { reference: `Patient/${subject}`, display: 'Andrea Lindqvist' } : { display: 'Karin, diabetes nurse (demo)' },
  sent,
  payload: [{ contentCodeableConcept: { text } }],
});

/** Andrea's chat without the plan cards: [sender, text]. */
const chat = () =>
  listMessages(ANDREA_GUID)
    .filter((m) => m.sender !== 'system')
    .map((m) => [m.sender, m.text]);

beforeEach(() => {
  // Each test starts without the previous one's chat (system messages stay).
  for (const { id } of all<{ id: number }>("SELECT id FROM messages WHERE patient_guid = :p AND sender != 'system'", { p: ANDREA_GUID })) {
    run('DELETE FROM careteam_inbound WHERE message_id = :id', { id });
    run('DELETE FROM careteam_deliveries WHERE message_id = :id', { id });
    run('DELETE FROM messages WHERE id = :id', { id });
  }
});

test('both directions are mirrored, in the order they were sent', async () => {
  freshChannel();
  mock.replies.push(
    communication('c-3', 'care-team', 'Vi ses på tisdag.', '2026-11-19T10:05:00.000Z'),
    communication('c-1', 'patient', 'Hej, jag sover dåligt.', '2026-11-19T09:00:00.000Z'),
    communication('c-2', 'care-team', 'Tack, vi tittar på det.', '2026-11-19T09:30:00.000Z'),
    communication('c-other', 'care-team', 'Till någon annan.', '2026-11-19T09:45:00.000Z', '11111111-2222-4333-8444-555555555555'),
  );
  const result = await pollOnce();
  assert.ok(!('error' in result));
  assert.deepEqual([result.inserted, result.rejected, result.total], [3, 1, 3]);
  assert.deepEqual(chat(), [
    ['patient', 'Hej, jag sover dåligt.'],
    ['care-team', 'Tack, vi tittar på det.'],
    ['care-team', 'Vi ses på tisdag.'],
  ]);
  const times = listMessages(ANDREA_GUID).filter((m) => m.sender !== 'system').map((m) => m.createdAt);
  assert.deepEqual(times, ['2026-11-19T09:00:00.000Z', '2026-11-19T09:30:00.000Z', '2026-11-19T10:05:00.000Z']);
  // The care team member's name is shown with their replies.
  const reply = listMessages(ANDREA_GUID).find((m) => m.text === 'Tack, vi tittar på det.')!;
  assert.equal(chatStatus(ANDREA_GUID).senders[reply.id], 'Karin, diabetes nurse (demo)');
});

test("a message deleted or edited in the care team's system is deleted or edited here; nothing changes when nothing differs", async () => {
  freshChannel();
  mock.replies.push(communication('d-1', 'care-team', 'Första.', '2026-11-19T09:00:00.000Z'), communication('d-2', 'care-team', 'Andra.', '2026-11-19T09:10:00.000Z'));
  await pollOnce();
  assert.equal(chat().length, 2);

  let events = 0;
  const count = () => events++;
  channelEvents.on('changed', count);
  const same = await pollOnce();
  assert.ok(!('error' in same) && !same.changed, 'nothing differs');
  assert.equal(events, 0, 'no live update when nothing differs');

  mock.replies.splice(0, 1);
  (mock.replies[0].payload as any)[0].contentCodeableConcept.text = 'Andra, ändrad.';
  const result = await pollOnce();
  assert.ok(!('error' in result));
  assert.deepEqual([result.deleted, result.updated, result.changed], [1, 1, true]);
  assert.deepEqual(chat(), [['care-team', 'Andra, ändrad.']]);
  assert.equal(events, 1, 'one live update');
  channelEvents.off('changed', count);
});

test('plan cards (system messages) are never touched; older local messages the care team never had are removed', async () => {
  freshChannel();
  const systemBefore = listMessages(ANDREA_GUID).filter((m) => m.sender === 'system');
  assert.ok(systemBefore.length > 0, 'the delivery made a plan card');
  addMessage(ANDREA_GUID, 'care-team', 'Typed in the admin page, never in the care team system.');
  mock.replies.push(communication('s-1', 'care-team', 'Hej Andrea.', '2026-11-19T09:00:00.000Z'));
  await pollOnce();
  assert.deepEqual(listMessages(ANDREA_GUID).filter((m) => m.sender === 'system'), systemBefore);
  assert.deepEqual(chat(), [['care-team', 'Hej Andrea.']]);
});

test("a failed fetch changes nothing and the last mirror stays", async () => {
  freshChannel();
  mock.replies.push(communication('f-1', 'care-team', 'Senaste spegeln.', '2026-11-19T09:00:00.000Z'));
  await pollOnce();
  const before = listMessages(ANDREA_GUID);
  saveChannelSettings({ endpointUrl: 'http://127.0.0.1:9/fhir' }); // network error
  const failed = await pollOnce();
  assert.ok('error' in failed);
  assert.deepEqual(listMessages(ANDREA_GUID), before);
  saveChannelSettings({ endpointUrl: `${mock.base}/fhir`, token: 'wrong-token' }); // 401
  const refused = await pollOnce();
  assert.ok('error' in refused && /401/.test(refused.error));
  assert.deepEqual(listMessages(ANDREA_GUID), before);
  assert.ok(all<{ outcome: string }>("SELECT outcome FROM careteam_log WHERE direction = 'in' ORDER BY id DESC LIMIT 2").every((l) => l.outcome === 'failed'));
});

test('her messages that come from the mirror are never sent by the outbox', async () => {
  freshChannel();
  mock.replies.push(communication('o-1', 'patient', 'Skrivet i vårdteamets system.', new Date().toISOString()));
  await pollOnce();
  const imported = listMessages(ANDREA_GUID).find((m) => m.text === 'Skrivet i vårdteamets system.')!;
  const sentBefore = mock.received.length;
  assert.equal(await sendPending(), 0);
  assert.equal(mock.received.length, sentBefore);
  assert.equal(all('SELECT message_id FROM careteam_deliveries WHERE message_id = :id', { id: imported.id }).length, 0);
  assert.equal(chatStatus(ANDREA_GUID).deliveries[imported.id], undefined, 'no "Sending …" under it');
});

test('her own message: pending until it comes back, then the mirrored one replaces it, never twice', async () => {
  for (const echo of ['remote-id', 'own-id', 'new-id'] as const) {
    const echoing = await startMockCareTeam(0, { echo });
    try {
      saveChannelSettings({ enabled: false });
      saveChannelSettings({ enabled: true, endpointUrl: `${echoing.base}/fhir`, token: 'mock-token', receiveMode: 'poll', pollPath: 'Communication?_since={since}' });
      const text = `Hej, det här skrev jag själv (${echo}).`;
      const mine = addMessage(ANDREA_GUID, 'patient', text);
      assert.equal(await sendPending(), 1);
      assert.equal(echoing.received.length, 1);
      assert.equal(chatStatus(ANDREA_GUID).deliveries[mine.id].status, 'pending', `${echo}: delivered, but not back yet`);

      const result = await pollOnce();
      assert.ok(!('error' in result));
      assert.deepEqual([result.matched, result.inserted], [1, 0], `${echo}: matched, not inserted`);
      assert.equal(listMessages(ANDREA_GUID).filter((m) => m.text === text).length, 1, `${echo}: not duplicated`);
      assert.equal(listMessages(ANDREA_GUID).find((m) => m.text === text)!.id, mine.id, `${echo}: the same message`);
      assert.equal(chatStatus(ANDREA_GUID).deliveries[mine.id].status, 'delivered', `${echo}: sent`);
      // Not sent again, and stable on the next fetch.
      assert.equal(await sendPending(), 0);
      const again = await pollOnce();
      assert.ok(!('error' in again) && !again.changed);
    } finally {
      await echoing.stop();
    }
  }
});
