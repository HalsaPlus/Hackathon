import { createHash, timingSafeEqual } from 'node:crypto';
import express from 'express';
import type { Express, NextFunction, Request, Response } from 'express';
import {
  buildDataset,
  DEVICES,
  HEIGHT_CM,
  isoTime,
  OBSERVATION_TYPES,
  PATIENT_ID,
  todayInParis,
  type Dataset,
  type ObservationType,
  type StoredObservation,
} from './data/dataset.ts';
import { toFhirBundle } from './fhir.ts';

// The simulated Hälsa+ API. See openapi.yaml for the contract.
// SYNTHETIC TEST DATA ONLY. No interpretation, ranges or statistics anywhere.

export const VERSION = '0.1.0';

export interface AppOptions {
  /** Bearer token. Without it, every protected endpoint answers 503. */
  token: string | undefined;
  /** Allowed browser origins; "*" allows any. */
  corsOrigins: string[];
  /** Default for asOf (env DEMO_NOW). */
  demoNow?: number;
  /** The real clock; tests replace it. */
  now?: () => number;
  /** The Paris date the data window is counted from. Default: today. */
  startDate?: string;
}

class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const sha256 = (value: string) => createHash('sha256').update(value).digest();
const safeEqual = (a: string, b: string) => timingSafeEqual(sha256(a), sha256(b));

function query(req: Request, name: string): string | undefined {
  const value = req.query[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new ApiError(400, 'invalid_parameter', `Give ${name} once, as a single value.`);
  return value;
}

function parseTime(value: string, name: string) {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new ApiError(400, 'invalid_parameter', `${name} is not an ISO 8601 date-time.`);
  return ms;
}

function parseTypes(value: string | undefined): ObservationType[] {
  if (!value) return [...OBSERVATION_TYPES];
  const types = value.split(',').map((t) => t.trim()).filter(Boolean);
  const unknown = types.filter((t) => !(OBSERVATION_TYPES as readonly string[]).includes(t));
  if (unknown.length || !types.length) {
    throw new ApiError(400, 'invalid_type', `Unknown type: ${unknown.join(', ') || '(empty)'}. Use ${OBSERVATION_TYPES.join(', ')}.`);
  }
  return types as ObservationType[];
}

// The cursor is the last item's (time, id), so pages stay right even if asOf changes.
const encodeCursor = (at: number, id: string) => Buffer.from(JSON.stringify([at, id])).toString('base64url');
function decodeCursor(value: string): [number, string] {
  try {
    const [at, id] = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (typeof at === 'number' && typeof id === 'string') return [at, id];
  } catch {
    // fall through
  }
  throw new ApiError(400, 'invalid_cursor', 'The cursor is not valid. Use nextCursor from the previous page.');
}

export function createApp(options: AppOptions): Express {
  const now = options.now ?? Date.now;
  const data: Dataset = buildDataset(options.startDate ?? todayInParis(now()));
  const allowAny = options.corsOrigins.includes('*');
  const origins = new Set(options.corsOrigins);

  /** Which devices have data, sorted by time, for lastSyncAt. */
  const deviceTimes = new Map<string, number[]>();
  for (const { at, observation } of data.entries) {
    if (!observation.deviceId) continue;
    let times = deviceTimes.get(observation.deviceId);
    if (!times) deviceTimes.set(observation.deviceId, (times = []));
    times.push(at);
  }

  function asOfFrom(req: Request) {
    const raw = query(req, 'asOf');
    if (raw === undefined) {
      const fallback = options.demoNow ?? now();
      return Math.min(Math.max(fallback, data.start), data.end);
    }
    const ms = parseTime(raw, 'asOf');
    if (ms < data.start || ms > data.end) {
      throw new ApiError(400, 'asof_out_of_range', `asOf must lie between ${isoTime(data.start)} and ${isoTime(data.end)}.`);
    }
    return ms;
  }

  const withStatus = (o: StoredObservation) => ({ ...o, status: (Date.parse(availableAt(o)) <= now() ? 'final' : 'preliminary') as 'final' | 'preliminary' });

  const app = express();
  app.disable('x-powered-by');
  app.set('query parser', 'simple');
  app.use(express.json({ limit: '10kb' }));

  // CORS: only for the origins in CORS_ORIGINS.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const origin = req.get('Origin');
    if (origin && (allowAny || origins.has(origin))) {
      res.set('Access-Control-Allow-Origin', allowAny ? '*' : origin);
      res.set('Vary', 'Origin');
      res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.set('Access-Control-Max-Age', '600');
    }
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
  });

  app.get('/api/v1/health', (_req, res) => {
    res.json({ status: 'ok', service: 'halsa-plus', version: VERSION });
  });

  // Everything below needs the bearer token.
  app.use('/api', (req: Request, _res: Response, next: NextFunction) => {
    if (!options.token) return next(new ApiError(503, 'token_not_configured', 'HALSA_API_TOKEN is not set on the server.'));
    const header = req.get('Authorization') ?? '';
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (!match || !safeEqual(match[1].trim(), options.token)) {
      return next(new ApiError(401, 'unauthorized', 'Missing or wrong bearer token.'));
    }
    next();
  });

  app.get('/api/v1/me', (_req, res) => {
    res.json({
      id: PATIENT_ID,
      name: { given: ['Andrea'], family: 'Lindqvist', text: 'Andrea Lindqvist' },
      birthDate: '2002-07-25',
      gender: 'female',
      identifier: [{ system: 'urn:oid:1.2.752.129.2.1.3.1', value: '200207252388' }],
      height: { value: HEIGHT_CM, unit: 'cm' },
      synthetic: true,
    });
  });

  app.get('/api/v1/devices', (req, res) => {
    const asOf = asOfFrom(req);
    res.json({
      asOf: isoTime(asOf),
      items: DEVICES.map((device) => {
        const times = deviceTimes.get(device.id) ?? [];
        const last = lastAtOrBefore(times, asOf);
        return { ...device, lastSyncAt: last === undefined ? null : isoTime(last) };
      }),
    });
  });

  app.get('/api/v1/observations', (req, res) => {
    const asOf = asOfFrom(req);
    const types = new Set(parseTypes(query(req, 'type')));
    const fromRaw = query(req, 'from');
    const toRaw = query(req, 'to');
    const from = fromRaw === undefined ? data.start : parseTime(fromRaw, 'from');
    const to = Math.min(toRaw === undefined ? asOf : parseTime(toRaw, 'to'), asOf);
    const device = query(req, 'device');
    const limitRaw = query(req, 'limit');
    const limit = limitRaw === undefined ? 1000 : Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 1 || limit > 5000) throw new ApiError(400, 'invalid_parameter', 'limit must be an integer from 1 to 5000.');
    const cursorRaw = query(req, 'cursor');
    const cursor = cursorRaw === undefined ? undefined : decodeCursor(cursorRaw);
    const format = query(req, 'format') ?? 'json';
    if (format !== 'json' && format !== 'fhir') throw new ApiError(400, 'invalid_parameter', 'format must be json or fhir.');

    const page: StoredObservation[] = [];
    let last: { at: number; id: string } | undefined;
    let more = false;
    for (const { at, observation: o } of data.entries) {
      if (at > to) break;
      if (at < from || !types.has(o.type) || (device && o.deviceId !== device)) continue;
      if (cursor && (at < cursor[0] || (at === cursor[0] && o.id <= cursor[1]))) continue;
      if (page.length === limit) {
        more = true;
        break;
      }
      page.push(o);
      last = { at, id: o.id };
    }
    const nextCursor = more && last ? encodeCursor(last.at, last.id) : null;
    const items = page.map(withStatus);

    if (format === 'fhir') {
      const self = req.originalUrl;
      const next = nextCursor ? withQuery(req, { cursor: nextCursor }) : null;
      return res.type('application/fhir+json').send(JSON.stringify(toFhirBundle(items, self, next)));
    }
    res.json({ asOf: isoTime(asOf), items, nextCursor });
  });

  app.get('/api/v1/observations/latest', (req, res) => {
    const asOf = asOfFrom(req);
    const types = parseTypes(query(req, 'type'));
    const latest = new Map<ObservationType, StoredObservation>();
    for (const { at, observation } of data.entries) {
      if (at > asOf) break;
      latest.set(observation.type, observation);
    }
    res.json({ asOf: isoTime(asOf), items: types.flatMap((t) => (latest.has(t) ? [withStatus(latest.get(t)!)] : [])) });
  });

  // Placeholders for the next step: care-plan requests and the patient's consent.
  app.get('/api/v1/requests', (_req, res) => {
    res.json({ items: [] });
  });

  app.post('/api/v1/requests/:id/consent', (req, _res) => {
    const decision = (req.body as { decision?: unknown } | undefined)?.decision;
    if (decision !== 'accept' && decision !== 'decline') {
      throw new ApiError(400, 'invalid_parameter', 'decision must be "accept" or "decline".');
    }
    throw new ApiError(404, 'not_found', `There is no request ${req.params.id}.`);
  });

  app.use('/api', (_req, _res, next) => next(new ApiError(404, 'not_found', 'Not found.')));

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof ApiError) return res.status(error.status).json({ error: { code: error.code, message: error.message } });
    if (error instanceof SyntaxError) return res.status(400).json({ error: { code: 'invalid_body', message: 'The body is not valid JSON.' } });
    console.error(error);
    res.status(500).json({ error: { code: 'internal', message: 'Something went wrong on the server.' } });
  });

  return app;
}

/** When an observation becomes available: wake time for sleep, issued for lab results, else the effective time. */
function availableAt(o: StoredObservation) {
  return o.issued ?? o.effectivePeriod?.end ?? o.effectiveDateTime ?? '';
}

function lastAtOrBefore(sorted: number[], limit: number) {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] <= limit) lo = mid + 1;
    else hi = mid;
  }
  return lo === 0 ? undefined : sorted[lo - 1];
}

function withQuery(req: Request, changes: Record<string, string>) {
  const url = new URL(req.originalUrl, 'http://local');
  for (const [key, value] of Object.entries(changes)) url.searchParams.set(key, value);
  return `${url.pathname}${url.search}`;
}
