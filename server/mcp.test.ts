import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// MMD as an MCP server, driven by the official MCP client over HTTP, as an
// assistant like ChatGPT would. Must be set before db.ts loads.
process.env.DATABASE_PATH = ':memory:';
const { createDemo } = await import('./demo.ts');
const { createAssistantLink, revokeAssistantLink } = await import('./assistant.ts');
const { setupMcp } = await import('./mcp.ts');
const { listMessages } = await import('./store.ts');

let base = '';
let close: () => void = () => {};
const demo = createDemo();
const patientGuid = demo.patient.guid;

before(async () => {
  const app = express();
  setupMcp(app);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});
after(() => close());

async function connect(url: string, headers?: Record<string, string>) {
  const client = new Client({ name: 'mmd-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: headers ? { headers } : undefined }));
  return client;
}

const text = (result: unknown) => ((result as { content: { type: string; text: string }[] }).content)[0].text;
const data = (result: unknown) => JSON.parse(text(result));

test('lists the six tools, and only sending a message is not read-only', async () => {
  const link = createAssistantLink(patientGuid, 'ChatGPT', base);
  const client = await connect(link.url);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), [
    'get_health_summary',
    'get_messages',
    'get_my_plan',
    'get_my_values',
    'get_today',
    'send_message_to_care_team',
  ]);
  assert.deepEqual(
    tools.filter((t) => !t.annotations?.readOnlyHint).map((t) => t.name),
    ['send_message_to_care_team'],
  );
  assert.match(client.getInstructions() ?? '', /not a clinician/);
  await client.close();
});

test("reads the plan, values, today's tasks and the health summary, without identifiers", async () => {
  const link = createAssistantLink(patientGuid, 'ChatGPT', base);
  const client = await connect(link.url);

  const plan = await client.callTool({ name: 'get_my_plan', arguments: {} });
  const [first] = data(plan).plans;
  assert.ok(first.activities.length >= 3);
  const glucose = first.activities.find((a: { title: string }) => /glucose/i.test(a.title));
  assert.ok(glucose.measures.length > 0);
  assert.ok(['you', 'your care team'].includes(glucose.done_by));
  // What the assistant must never see.
  for (const result of [plan]) {
    assert.ok(!text(result).includes(patientGuid), 'no patient id');
    assert.ok(!/grant|transaction_guid|transactionGuid|identifier/i.test(text(result)));
  }

  const values = data(await client.callTool({ name: 'get_my_values', arguments: { parameter: 'stiff', days: 30 } }));
  assert.ok(values.count > 0);
  assert.ok(values.values.every((v: { parameter: string }) => /stiff/i.test(v.parameter)));
  assert.ok(values.values.every((v: { outside_target: unknown }) => v.outside_target === null || typeof v.outside_target === 'boolean'));

  const today = data(await client.callTool({ name: 'get_today', arguments: {} }));
  assert.equal(today.date, new Date().toLocaleDateString('sv-SE')); // the local day, not UTC's
  assert.ok(Array.isArray(today.tasks));

  const summary = data(await client.callTool({ name: 'get_health_summary', arguments: {} }));
  assert.equal(summary.synthetic, true);
  assert.ok(summary.conditions.length > 0);
  await client.close();
});

test('sends a message to the care team only when confirmed, marked with the assistant', async () => {
  const link = createAssistantLink(patientGuid, 'ChatGPT', base);
  const client = await connect(link.url);
  const before = listMessages(patientGuid).length;

  const refused = await client.callTool({
    name: 'send_message_to_care_team',
    arguments: { text: 'Jag sover dåligt och är stressad.', confirmed: false },
  });
  assert.equal(refused.isError, true);
  assert.equal(listMessages(patientGuid).length, before);

  const sent = data(await client.callTool({
    name: 'send_message_to_care_team',
    arguments: { text: 'Jag sover dåligt och är stressad.', confirmed: true },
  }));
  assert.equal(sent.sent, true);
  assert.match(sent.note, /112/);
  const last = listMessages(patientGuid).at(-1)!;
  assert.deepEqual([last.sender, last.text, last.via], ['patient', 'Jag sover dåligt och är stressad.', 'ChatGPT']);

  const chat = data(await client.callTool({ name: 'get_messages', arguments: { limit: 1 } }));
  assert.deepEqual(chat.messages, [{ from: 'you', text: 'Jag sover dåligt och är stressad.', at: last.createdAt, via: 'ChatGPT' }]);
  await client.close();
});

test('the secret also works as an API key, and a wrong or revoked one gets nothing', async () => {
  const link = createAssistantLink(patientGuid, 'Claude', base);
  const client = await connect(`${base}/mcp`, { Authorization: `Bearer ${link.secret}` });
  assert.equal((await client.listTools()).tools.length, 6);
  await client.close();

  const wrong = await fetch(`${base}/mcp/not-a-real-secret-at-all-000000`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  assert.equal(wrong.status, 401);

  assert.equal(revokeAssistantLink(link.id), true);
  await assert.rejects(connect(link.url));
});
