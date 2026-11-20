// A mock care-team system for testing MMD's care-team chat channel (FHIR
// messaging) without the real endpoint. SYNTHETIC TEST DATA ONLY.
//
//   node scripts/mock-careteam.ts
//
// Environment (all optional):
//   MOCK_PORT          port, default 4010
//   MOCK_TOKEN         the token MMD must send as "Authorization: Bearer …", default mock-token
//   MOCK_PATIENT       the patient GUID replies are about, default Andrea's
//   MOCK_FORMAT        r5 (payload.contentCodeableConcept.text, default) or r4 (payload.contentString)
//   MOCK_PUSH_URL      push mode: MMD's inbound URL, e.g. http://localhost:3011/api/v1/inbound/message
//   MOCK_PUSH_SECRET   push mode: the push secret entered in MMD
//
// In MMD's admin console (Connections → Care-team chat channel):
//   Endpoint URL  http://localhost:4010/fhir     Token  mock-token
//   Receive mode  poll (or push, with MOCK_PUSH_URL and MOCK_PUSH_SECRET set)
//
// Endpoints:
//   GET  /fhir/metadata                 "Test connection"
//   POST /fhir/$process-message         what MMD sends (a FHIR message Bundle)
//   GET  /fhir/Communication?patient=Patient/<guid>&_lastUpdated=gt<time>
//                                       the care team's replies, for poll mode
//   POST /api/mmd                      the patient's reported values (a FHIR transaction
//                                       Bundle of Observations); values URL http://localhost:4010/api/mmd
//   POST /reply   { "text": "…", "sender": "Nurse Eva (demo)" }
//                                       writes a reply (and pushes it in push mode)
//   GET  /messages                      everything received and replied, to look at

import express from 'express';
import type { AddressInfo } from 'node:net';

const ANDREA_GUID = '28a29239-6424-48e7-a123-9d9e863670b8';

export interface MockOptions {
  /**
   * Whether what MMD sends shows up in GET Communication, as in a real
   * care-team system: with the id the mock answered ('remote-id'), with
   * MMD's own Communication id ('own-id'), or with an id of its own
   * ('new-id'). Default: not at all.
   */
  echo?: 'remote-id' | 'own-id' | 'new-id';
  token?: string;
  patientGuid?: string;
  format?: 'r5' | 'r4';
  pushUrl?: string;
  pushSecret?: string;
}

type Json = Record<string, any>;

export function createMockCareTeam(options: MockOptions = {}) {
  const token = options.token ?? 'mock-token';
  const patientGuid = options.patientGuid ?? ANDREA_GUID;
  const received: Json[] = [];
  const replies: Json[] = [];
  const pushes: { status: number; at: string }[] = [];
  /** The transaction Bundles of reported values received at POST /api/mmd, with their auth header. */
  const values: { bundle: Json; authorization: string | undefined }[] = [];
  /** Set status to make POST /api/mmd fail, e.g. 500, for tests. */
  const valuesAnswer: { status: number | null } = { status: null };
  /** How many times the replies were fetched (GET Communication), for tests. */
  const stats = { polls: 0 };
  let next = 1;
  // Unique per mock instance, as a real system's Communication ids would be.
  const instance = Date.now().toString(36);

  const app = express();
  app.use(express.json({ type: ['application/json', 'application/fhir+json'], limit: '2mb' }));
  const authorized = (req: express.Request) => req.get('Authorization') === `Bearer ${token}`;
  const outcome = (code: string, text: string) => ({ resourceType: 'OperationOutcome', issue: [{ severity: 'error', code, diagnostics: text }] });

  app.get('/fhir/metadata', (req, res) => {
    if (!authorized(req)) return res.status(401).json(outcome('security', 'Missing or wrong token.'));
    res.json({ resourceType: 'CapabilityStatement', status: 'active', kind: 'instance', fhirVersion: '5.0.0', software: { name: 'Mock care team (demo)' } });
  });

  app.post(/^\/fhir\/\$process-message$/, (req, res) => {
    if (!authorized(req)) return res.status(401).json(outcome('security', 'Missing or wrong token.'));
    const bundle = req.body as Json;
    const header = bundle?.entry?.[0]?.resource;
    if (bundle?.resourceType !== 'Bundle' || bundle.type !== 'message' || header?.resourceType !== 'MessageHeader') {
      return res.status(400).json(outcome('invalid', 'Expected a Bundle of type message with a MessageHeader first.'));
    }
    received.push(bundle);
    const id = `mock-received-${received.length}`;
    const sent = bundle.entry.find((e: Json) => e.resource?.resourceType === 'Communication')?.resource;
    if (options.echo && sent) {
      const echoed = JSON.parse(JSON.stringify(sent));
      echoed.id = options.echo === 'remote-id' ? id : options.echo === 'new-id' ? `mock-echo-${instance}-${next++}` : sent.id;
      echoed.meta = { ...(echoed.meta ?? {}), lastUpdated: new Date().toISOString() };
      replies.push(echoed);
    }
    res.status(200).json({
      resourceType: 'Bundle',
      id,
      type: 'message',
      entry: [{ resource: { resourceType: 'MessageHeader', id, response: { identifier: header.id ?? 'unknown', code: 'ok' }, source: { endpointUrl: 'http://mock-careteam' } } }],
    });
  });

  app.post('/api/mmd', (req, res) => {
    if (!authorized(req)) return res.status(401).json(outcome('security', 'Missing or wrong token.'));
    if (valuesAnswer.status) return res.status(valuesAnswer.status).json(outcome('exception', 'The mock was told to fail.'));
    const bundle = req.body as Json;
    if (bundle?.resourceType !== 'Bundle' || bundle.type !== 'transaction' || !Array.isArray(bundle.entry)) {
      return res.status(400).json(outcome('invalid', 'Expected a Bundle of type transaction.'));
    }
    values.push({ bundle, authorization: req.get('Authorization') });
    // Like a FHIR server: a transaction-response with each new Observation's location.
    res.status(200).json({
      resourceType: 'Bundle',
      type: 'transaction-response',
      entry: bundle.entry.map(() => {
        const id = `mock-obs-${instance}-${next++}`;
        return { response: { status: '201 Created', location: `Observation/${id}/_history/1` } };
      }),
    });
  });

  app.get('/fhir/Communication', (req, res) => {
    if (!authorized(req)) return res.status(401).json(outcome('security', 'Missing or wrong token.'));
    stats.polls += 1;
    // Either ?patient=Patient/<id>&_lastUpdated=gt<time>, or (like the real one) ?_since=<time> for all.
    const patient = String(req.query.patient ?? '').replace(/^Patient\//, '');
    const since = String(req.query._since ?? req.query._lastUpdated ?? '').replace(/^gt/, '');
    const items = replies.filter((c) => (!patient || c.subject?.reference === `Patient/${patient}`) && (!since || c.sent > since));
    res.json({ resourceType: 'Bundle', type: 'searchset', total: items.length, entry: items.map((resource) => ({ resource })) });
  });

  app.post('/reply', async (req, res) => {
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    if (!text) return res.status(400).json({ error: 'Send { "text": "…" }.' });
    const at = new Date().toISOString();
    const communication = {
      resourceType: 'Communication',
      id: `mock-reply-${instance}-${next++}`,
      meta: { lastUpdated: at },
      status: 'completed',
      ...(req.body?.patient === null ? {} : { subject: { reference: `Patient/${typeof req.body?.patient === 'string' ? req.body.patient : patientGuid}` } }),
      sender: { display: typeof req.body?.sender === 'string' ? req.body.sender : 'Care team (demo)' },
      recipient: [{ reference: `Patient/${patientGuid}` }],
      sent: at,
      payload: [options.format === 'r4' ? { contentString: text } : { contentCodeableConcept: { text } }],
    };
    replies.push(communication);
    let pushed: number | null = null;
    if (options.pushUrl && options.pushSecret) {
      const bundle = {
        resourceType: 'Bundle',
        type: 'message',
        timestamp: at,
        entry: [
          {
            fullUrl: `urn:uuid:mock-header-${communication.id}`,
            resource: {
              resourceType: 'MessageHeader',
              id: `mock-header-${communication.id}`,
              eventCoding: { system: 'https://mmd.halsaplus.se/fhir/event', code: 'care-team-message' },
              source: { endpointUrl: 'http://mock-careteam' },
              focus: [{ reference: `urn:uuid:${communication.id}` }],
            },
          },
          { fullUrl: `urn:uuid:${communication.id}`, resource: communication },
        ],
      };
      try {
        const response = await fetch(options.pushUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/fhir+json', 'X-Push-Secret': options.pushSecret },
          body: JSON.stringify(bundle),
        });
        pushed = response.status;
      } catch {
        pushed = 0;
      }
      pushes.push({ status: pushed, at });
    }
    res.status(201).json({ id: communication.id, pushed });
  });

  app.get('/messages', (_req, res) => {
    res.json({
      received: received.map((b) => {
        const c = b.entry.find((e: Json) => e.resource?.resourceType === 'Communication')?.resource;
        return { subject: c?.subject?.reference, text: c?.payload?.[0]?.contentString ?? c?.payload?.[0]?.contentCodeableConcept?.text, sent: c?.sent };
      }),
      replies: replies.map((c) => ({ id: c.id, text: c.payload[0].contentString ?? c.payload[0].contentCodeableConcept.text, at: c.sent })),
      pushes,
    });
  });

  return { app, received, replies, pushes, stats, values, valuesAnswer };
}

/** Starts the mock on a port (0 = any free port); resolves to its base URL and a stop function. */
export async function startMockCareTeam(port: number, options: MockOptions = {}) {
  const mock = createMockCareTeam(options);
  const server = mock.app.listen(port, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { ...mock, base, stop: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

if (import.meta.main) {
  const port = Number(process.env.MOCK_PORT) || 4010;
  const format = process.env.MOCK_FORMAT === 'r4' ? 'r4' : 'r5';
  const mock = await startMockCareTeam(port, {
    token: process.env.MOCK_TOKEN || undefined,
    patientGuid: process.env.MOCK_PATIENT || undefined,
    format,
    pushUrl: process.env.MOCK_PUSH_URL || undefined,
    pushSecret: process.env.MOCK_PUSH_SECRET || undefined,
  });
  console.log(`Mock care team on ${mock.base} (FHIR base ${mock.base}/fhir, payload ${format}${process.env.MOCK_PUSH_URL ? ', pushes replies' : ''}).`);
  console.log(`Reply:  curl -X POST ${mock.base}/reply -H "Content-Type: application/json" -d '{"text":"Hi Andrea, thanks!"}'`);
}
