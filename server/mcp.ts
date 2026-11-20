import express from 'express';
import type { Express, Request, Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type { ActivityView, AppView, ServiceRequestView, Transaction } from '../shared/types.ts';
import { resolveAssistantSecret } from './assistant.ts';
import { sendToCdr } from './messaging.ts';
import { addMessage, getAppView, setMessageCdrOutcome } from './store.ts';

// MMD as an MCP server (issue #7): an AI assistant such as ChatGPT or Claude
// can read one patient's plan, values, today's stops, health summary and chat,
// and send a message to the care team when the patient asks it to.
//
// The assistant only talks to MMD, never to PDHC: it never sees the PDHC
// token, grant_token, transaction GUIDs or the personal identity number, only
// what the patient sees in the app. Which patient is decided by the secret
// link (see assistant.ts). Demo with synthetic data only: everything the
// patient writes to the assistant goes to whoever runs the assistant.
//
//   POST /mcp/<secret>                                (connect without a login)
//   POST /mcp   with  Authorization: Bearer <secret>  (connect with an API key)
//
// Stateless Streamable HTTP: every request gets its own server and transport.

const DAY = 24 * 60 * 60 * 1000;

const INSTRUCTIONS = [
  "These tools show one patient's care plan, measured values, today's tasks, health summary and chat with the care team, from MMD, a patient app connected to PDHC.",
  'Talk to the patient as "you". The data is synthetic (a hackathon demo).',
  'You are not a clinician: do not diagnose, do not change the plan, and do not give treatment advice. Explain what the plan and the values say.',
  'When a value is outside the target the care team set, say so plainly and offer to tell the care team with send_message_to_care_team.',
  'The chat is not for emergencies: in an emergency tell the patient to call 112, and for medical advice 1177.',
  'Before send_message_to_care_team, show the patient the exact text and ask; only call it with confirmed: true after a clear yes.',
].join(' ');

const json = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] });
const error = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true });

/** Requests the patient can act on: not closed by PDHC and not ended. */
function openRequests(view: AppView): ServiceRequestView[] {
  return view.requests.filter((r) => !r.closed && (!r.status || r.status === 'active'));
}

function whoDoesIt(activity: ActivityView) {
  return /practitioner|care team|nurse|doctor|vård|läkare|sjuksköt/i.test(activity.performerType ?? '') ? 'your care team' : 'you';
}

function target(t: Transaction) {
  if (t.rangeMin === undefined && t.rangeMax === undefined) return null;
  return { min: t.rangeMin ?? null, max: t.rangeMax ?? null };
}

const startOfToday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

function myPlan(view: AppView) {
  const today = startOfToday();
  return {
    plans: openRequests(view).map((r) => ({
      title: r.title,
      period: { start: r.periodStart.slice(0, 10), end: r.periodEnd.slice(0, 10) },
      goals: r.carePlans.flatMap((p) => p.goals.map((g) => (g.target ? g.target : g.text))),
      activities: r.activities.map((a) => ({
        title: a.title,
        description: a.description,
        done_by: whoDoesIt(a),
        schedule: a.schedule,
        measures: a.transactions.map((t) => ({ name: t.name, unit: t.unit ?? null, target: target(t) })),
        occasions: a.stops.length,
        occasions_done: a.stops.filter((s) => s.performedAt).length,
        next_due: a.stops.find((s) => !s.performedAt && Date.parse(s.dueAt) >= today)?.dueAt ?? null,
      })),
    })),
  };
}

function myValues(view: AppView, parameter: string | undefined, days: number) {
  const since = Date.now() - days * DAY;
  const transactions = openRequests(view).flatMap((r) => r.activities.flatMap((a) => a.transactions));
  const wanted = parameter?.trim().toLowerCase();
  const values = view.observations
    .filter((o) => Date.parse(o.recordedAt) >= since)
    .filter((o) => !wanted || o.name.toLowerCase().includes(wanted))
    .slice(-200)
    .map((o) => {
      const t = transactions.find((x) => x.name === o.name);
      const number = Number(o.value);
      const range = t ? target(t) : null;
      const outside =
        range && Number.isFinite(number)
          ? (range.min !== null && number < range.min) || (range.max !== null && number > range.max)
          : null;
      return {
        parameter: o.name,
        value: o.value,
        unit: o.unit,
        recorded_at: o.recordedAt,
        target: range,
        outside_target: outside,
        sent_to_care_team: o.reportStatus === 'sent' || o.reportStatus === 'demo',
      };
    });
  return { days, parameter: parameter ?? null, count: values.length, values };
}

function today(view: AppView) {
  const start = startOfToday();
  const end = start + DAY;
  return {
    // The server's own day, not UTC's: in Sweden the UTC date is yesterday's until 01:00 or 02:00.
    date: new Date(start).toLocaleDateString('sv-SE'),
    tasks: openRequests(view).flatMap((r) =>
      r.activities.flatMap((a) => {
        const stop = a.stops.find((s) => Date.parse(s.dueAt) >= start && Date.parse(s.dueAt) < end);
        if (!stop) return [];
        return [{ plan: r.title, activity: a.title, done_by: whoDoesIt(a), done: !!stop.performedAt, measures: a.transactions.map((t) => t.name) }];
      }),
    ),
  };
}

function healthSummary(view: AppView) {
  if (!view.ips) return { available: false, note: 'No health summary (IPS) has been fetched for you yet.' };
  const { synthetic, source, fetchedAt, problems, medications, allergies, results } = view.ips;
  return { synthetic, source, fetched_at: fetchedAt, conditions: problems, medications, allergies, results };
}

function messages(view: AppView, limit: number) {
  return {
    messages: view.messages.slice(-limit).map((m) => ({
      from: m.sender === 'patient' ? 'you' : m.sender === 'care-team' ? 'your care team' : 'MMD',
      text: m.text,
      at: m.createdAt,
      ...(m.via ? { via: m.via } : {}),
    })),
  };
}

/** One MCP server for one patient, reached through a link with this label ("ChatGPT"). */
export function createMcpServer(patientGuid: string, via: string) {
  const server = new McpServer({ name: 'mmd', title: 'MMD – my care plan', version: '1.0.0' }, { instructions: INSTRUCTIONS });
  const view = () => getAppView(patientGuid);
  const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };

  server.registerTool(
    'get_my_plan',
    {
      title: 'My care plan',
      description:
        "The patient's current care plans from the care team: goals, and for each activity who does it, the schedule, what is measured with its target, and how many occasions are done.",
      annotations: readOnly,
    },
    async () => {
      const v = view();
      return v ? json(myPlan(v)) : error('The patient was not found.');
    },
  );

  server.registerTool(
    'get_my_values',
    {
      title: 'My measured values',
      description:
        'Values the patient has reported (glucose, sleep, blood pressure, how they feel …), oldest first, with the target from the plan and whether each is outside it. Covers at most the last 120 days.',
      inputSchema: {
        parameter: z.string().max(80).optional().describe('Only values whose name contains this, e.g. "sleep" or "systolic".'),
        days: z.number().int().min(1).max(120).optional().describe('How many days back. Default 30.'),
      },
      annotations: readOnly,
    },
    async ({ parameter, days }) => {
      const v = view();
      return v ? json(myValues(v, parameter, days ?? 30)) : error('The patient was not found.');
    },
  );

  server.registerTool(
    'get_today',
    {
      title: "Today's tasks",
      description: "What is due in the patient's plans today, who does it, what is measured, and whether it is done.",
      annotations: readOnly,
    },
    async () => {
      const v = view();
      return v ? json(today(v)) : error('The patient was not found.');
    },
  );

  server.registerTool(
    'get_health_summary',
    {
      title: 'My health summary',
      description: "The patient's health summary (IPS): conditions, medications, allergies and recent results. Marked synthetic when it is demo data.",
      annotations: readOnly,
    },
    async () => {
      const v = view();
      return v ? json(healthSummary(v)) : error('The patient was not found.');
    },
  );

  server.registerTool(
    'get_messages',
    {
      title: 'My chat with the care team',
      description: 'The latest messages between the patient and the care team, oldest first, e.g. to see whether the care team has answered.',
      inputSchema: { limit: z.number().int().min(1).max(100).optional().describe('How many of the latest messages. Default 20.') },
      annotations: readOnly,
    },
    async ({ limit }) => {
      const v = view();
      return v ? json(messages(v, limit ?? 20)) : error('The patient was not found.');
    },
  );

  server.registerTool(
    'send_message_to_care_team',
    {
      title: 'Send a message to my care team',
      description:
        'Sends a message from the patient to their care team, in the same chat as the app, marked as written through this assistant. ' +
        'Only after the patient has seen the exact text and said yes: then call with confirmed: true. Not for emergencies (112) or medical advice (1177).',
      inputSchema: {
        text: z.string().min(1).max(2000).describe('The message, as the patient approved it.'),
        confirmed: z.boolean().describe('true only when the patient has seen this exact text and said to send it.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ text, confirmed }) => {
      if (!confirmed) {
        return error('Not sent. Show the patient the exact text, ask whether to send it, and call again with confirmed: true after a clear yes.');
      }
      if (!view()) return error('The patient was not found.');
      const message = addMessage(patientGuid, 'patient', text.trim(), null, undefined, via);
      // Same as the app: the FHIR message goes to the CDR, if one is set up.
      void sendToCdr({ ...message, patientGuid }).then((outcome) => setMessageCdrOutcome(message.id, outcome));
      return json({
        sent: true,
        at: message.createdAt,
        note: 'The care team sees it in the chat with you. They answer there; it is not watched around the clock. In an emergency call 112, for medical advice 1177.',
      });
    },
  );

  return server;
}

function rpcError(res: Response, status: number, message: string) {
  res.status(status).json({ jsonrpc: '2.0', error: { code: -32001, message }, id: null });
}

/** Handles one MCP request for the patient behind the secret. */
async function handle(req: Request, res: Response, secret: string | undefined) {
  const link = resolveAssistantSecret(secret);
  if (!link) return rpcError(res, 401, 'Unknown or revoked link. Ask the care team for a new one.');
  const server = createMcpServer(link.patientGuid, link.label);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('MCP request failed', err instanceof Error ? err.message : err);
    if (!res.headersSent) rpcError(res, 500, 'Something went wrong in MMD.');
  }
}

/**
 * The MCP endpoints. Must be registered before setupAuth(), since an assistant
 * has no admin session; the secret is its credential.
 */
export function setupMcp(app: Express) {
  const body = express.json({ limit: '1mb' });
  const bearer = (req: Request) => req.get('Authorization')?.match(/^Bearer\s+(\S+)$/i)?.[1];

  app.post('/mcp/:secret', body, (req, res) => void handle(req, res, String(req.params.secret)));
  app.post('/mcp', body, (req, res) => void handle(req, res, bearer(req)));
  // Stateless: no server-sent event stream and no sessions to end.
  for (const path of ['/mcp', '/mcp/:secret']) {
    app.get(path, (_req, res) => rpcError(res, 405, 'Use POST.'));
    app.delete(path, (_req, res) => rpcError(res, 405, 'No sessions to end.'));
  }
}
