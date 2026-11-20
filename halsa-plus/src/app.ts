import { randomBytes } from 'node:crypto';
import express from 'express';
import type { Express, NextFunction, Request, Response } from 'express';
import { now as isoNow, type Database } from './db.ts';
import { toFhirBundle } from './fhir.ts';
import { displayPersonalIdentityNumber, ensureToken, patientForToken, type PatientRow } from './patients.ts';
import { INSERT_OBSERVATION, observationRow, seedAndrea } from './seed.ts';
import { buildOverview, OVERVIEW_WINDOW_DAYS } from './overview.ts';
import { findObservation, findObservations, lastSync, latestObservations, listDevices } from './store.ts';
import { VACCINATIONS } from './synthetic/vaccinations.ts';
import {
  ANDREA,
  dataWindow,
  isoTime,
  isRatingType,
  OBSERVATION_TYPES,
  RATING_TYPES,
  RATING_UNIT,
  todayInParis,
  type Component,
  type ObservationType,
  type StoredObservation,
} from './synthetic/dataset.ts';

// The simulated Hälsa+ API. See openapi.yaml for the contract.
// SYNTHETIC TEST DATA ONLY. Observations are returned as they are, without
// interpretation; only GET /api/v1/overview scores them, against demo ranges
// (see overview.ts), like the Hälsa+ home screen.
// A bearer token identifies one patient; every endpoint returns only her data.

export const VERSION = '0.3.0';
const ANDREA_TOKEN_LABEL = 'HALSA_ANDREA_TOKEN (bootstrap)';

export interface AppOptions {
  database: Database;
  /** Allowed browser origins; "*" allows any. */
  corsOrigins: string[];
  /** Default for asOf (env DEMO_NOW). */
  demoNow?: number;
  /** The real clock; tests replace it. */
  now?: () => number;
  /** The Paris date the data window is counted from. Default: today. */
  startDate?: string;
  /** If set (env HALSA_ANDREA_TOKEN), a token with this value is ensured for Andrea. Stored hashed. */
  andreaToken?: string;
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

function query(req: Request, name: string): string | undefined {
  const value = req.query[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new ApiError(400, 'invalid_parameter', `Give ${name} once, as a single value.`);
  return value;
}

function parseTime(value: unknown, name: string) {
  const ms = typeof value === 'string' ? Date.parse(value) : NaN;
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

const patientOf = (res: Response) => res.locals.patient as PatientRow;

export function createApp(options: AppOptions): Express {
  const { database } = options;
  const now = options.now ?? Date.now;
  const startDate = options.startDate ?? todayInParis(now());
  const window = dataWindow(startDate);
  seedAndrea(database, startDate);
  if (options.andreaToken) ensureToken(database, ANDREA.guid, options.andreaToken, ANDREA_TOKEN_LABEL);

  const allowAny = options.corsOrigins.includes('*');
  const origins = new Set(options.corsOrigins);

  /** The demo clock: asOf from the query, else DEMO_NOW, else the real time. */
  function asOfFrom(req: Request) {
    const raw = query(req, 'asOf');
    if (raw === undefined) return Math.min(Math.max(options.demoNow ?? now(), window.start), window.end);
    const ms = parseTime(raw, 'asOf');
    if (ms < window.start || ms > window.end) {
      throw new ApiError(400, 'asof_out_of_range', `asOf must lie between ${isoTime(window.start)} and ${isoTime(window.end)}.`);
    }
    return ms;
  }

  const withStatus = ({ at, observation }: { at: number; observation: StoredObservation }) => ({
    ...observation,
    status: (at <= now() ? 'final' : 'preliminary') as 'final' | 'preliminary',
  });

  const app = express();
  app.disable('x-powered-by');
  app.set('query parser', 'simple');
  app.use(express.json({ limit: '20kb' }));

  // CORS: only for the origins in HALSA_CORS_ORIGINS.
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

  // Everything below needs a patient's bearer token, and sees only her data.
  app.use('/api', (req: Request, res: Response, next: NextFunction) => {
    const match = /^Bearer\s+(\S+)\s*$/i.exec(req.get('Authorization') ?? '');
    const patient = match ? patientForToken(database, match[1]) : undefined;
    if (!patient) return next(new ApiError(401, 'unauthorized', 'Missing or unknown bearer token.'));
    res.locals.patient = patient;
    next();
  });

  app.get('/api/v1/me', (_req, res) => {
    const p = patientOf(res);
    const space = p.name.lastIndexOf(' ');
    res.json({
      id: p.guid,
      name: { given: space > 0 ? [p.name.slice(0, space)] : [], family: space > 0 ? p.name.slice(space + 1) : p.name, text: p.name },
      ...(p.birth_date ? { birthDate: p.birth_date } : {}),
      ...(p.gender ? { gender: p.gender } : {}),
      identifier:
        p.personal_identity_number && p.identifier_system
          ? [{ system: p.identifier_system, value: p.personal_identity_number, display: displayPersonalIdentityNumber(p.personal_identity_number) }]
          : [],
      ...(p.height_cm ? { height: { value: p.height_cm, unit: 'cm' } } : {}),
      synthetic: true,
    });
  });

  app.get('/api/v1/devices', (req, res) => {
    const asOf = asOfFrom(req);
    res.json({
      asOf: isoTime(asOf),
      items: listDevices(database, patientOf(res).guid).map((d) => {
        const last = lastSync(database, d.id, asOf);
        return { id: d.id, type: d.type, name: d.name, source: d.source, types: JSON.parse(d.types_json), since: d.since, lastSyncAt: last === null ? null : isoTime(last) };
      }),
    });
  });

  app.get('/api/v1/observations', (req, res) => {
    const patient = patientOf(res);
    const asOf = asOfFrom(req);
    const types = parseTypes(query(req, 'type'));
    const fromRaw = query(req, 'from');
    const toRaw = query(req, 'to');
    const from = fromRaw === undefined ? window.start : parseTime(fromRaw, 'from');
    const to = Math.min(toRaw === undefined ? asOf : parseTime(toRaw, 'to'), asOf);
    const limitRaw = query(req, 'limit');
    const limit = limitRaw === undefined ? 1000 : Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 1 || limit > 5000) throw new ApiError(400, 'invalid_parameter', 'limit must be an integer from 1 to 5000.');
    const cursorRaw = query(req, 'cursor');
    const format = query(req, 'format') ?? 'json';
    if (format !== 'json' && format !== 'fhir') throw new ApiError(400, 'invalid_parameter', 'format must be json or fhir.');

    const page = findObservations(database, {
      patientGuid: patient.guid,
      types,
      from,
      to,
      deviceId: query(req, 'device'),
      after: cursorRaw === undefined ? undefined : decodeCursor(cursorRaw),
      limit,
    });
    const last = page.items.at(-1);
    const nextCursor = page.more && last ? encodeCursor(last.at, last.observation.id) : null;
    const items = page.items.map(withStatus);

    if (format === 'fhir') {
      const next = nextCursor ? withQuery(req, { cursor: nextCursor }) : null;
      const bundle = toFhirBundle(items, { patient, devices: listDevices(database, patient.guid) }, req.originalUrl, next);
      return res.type('application/fhir+json').send(JSON.stringify(bundle));
    }
    res.json({ asOf: isoTime(asOf), items, nextCursor });
  });

  app.get('/api/v1/observations/latest', (req, res) => {
    const asOf = asOfFrom(req);
    const types = parseTypes(query(req, 'type'));
    res.json({ asOf: isoTime(asOf), items: latestObservations(database, patientOf(res).guid, types, asOf).map(withStatus) });
  });

  // The patient enters a value herself (self-ratings and other self-reported types).
  app.post('/api/v1/observations', (req, res) => {
    const patient = patientOf(res);
    const clock = asOfFrom(req);
    const observation = selfReported(req.body, patient, clock, window.start);
    const app = listDevices(database, patient.guid).find((d) => d.type === 'app');
    observation.deviceId = app?.id ?? null;
    const at = Date.parse(observation.effectivePeriod?.end ?? observation.effectiveDateTime!);
    database.run(INSERT_OBSERVATION, observationRow(patient.guid, { at, observation }, 'patient-entered', isoNow()));
    res.status(201).json(withStatus(findObservation(database, patient.guid, observation.id)!));
  });

  // Andrea's vaccinations: a short synthetic history (SYNTHETIC TEST DATA ONLY).
  app.get('/api/v1/vaccinations', (_req, res) => {
    res.json({ synthetic: true, items: patientOf(res).guid === ANDREA.guid ? VACCINATIONS : [] });
  });

  // Six categories with a score each and a total, against DEMO reference ranges.
  app.get('/api/v1/overview', (req, res) => {
    const asOf = asOfFrom(req);
    const overview = buildOverview(database, patientOf(res).guid, asOf, withStatus);
    res.json({
      asOf: isoTime(asOf),
      window: { from: isoTime(overview.from), to: isoTime(asOf), days: OVERVIEW_WINDOW_DAYS },
      demoRanges: true,
      synthetic: true,
      healthScore: overview.healthScore,
      categories: overview.categories,
    });
  });

  // Care-plan requests arrive from MMD/PDHC in a later step; the list is empty for now.
  app.get('/api/v1/requests', (_req, res) => {
    res.json({ items: [] });
  });

  // Every decision is stored and never changed; the latest one applies.
  app.post('/api/v1/requests/:id/consent', (req, res) => {
    const requestId = String(req.params.id);
    if (!/^[A-Za-z0-9._:-]{1,200}$/.test(requestId)) throw new ApiError(400, 'invalid_parameter', 'The request id is not valid.');
    const decision = (req.body as { decision?: unknown } | undefined)?.decision;
    if (decision !== 'accept' && decision !== 'decline') {
      throw new ApiError(400, 'invalid_parameter', 'decision must be "accept" or "decline".');
    }
    const decidedAt = isoTime(now());
    database.run(
      `INSERT INTO consent_decisions (patient_guid, request_id, decision, decided_at) VALUES (:patient, :requestId, :decision, :decidedAt)`,
      { patient: patientOf(res).guid, requestId, decision, decidedAt },
    );
    res.status(201).json({ requestId, decision, decidedAt, status: decision === 'accept' ? 'accepted' : 'declined' });
  });

  app.get('/api/v1/requests/:id/consent', (req, res) => {
    const rows = database.all<{ request_id: string; decision: 'accept' | 'decline'; decided_at: string }>(
      `SELECT request_id, decision, decided_at FROM consent_decisions WHERE patient_guid = :patient AND request_id = :requestId ORDER BY id`,
      { patient: patientOf(res).guid, requestId: String(req.params.id) },
    );
    res.json({
      items: rows.map((r) => ({ requestId: r.request_id, decision: r.decision, decidedAt: r.decided_at, status: r.decision === 'accept' ? 'accepted' : 'declined' })),
    });
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

// --- What a patient may enter herself ------------------------------------------------

/** Input checks only: they reject typing errors and say nothing about the value itself. */
const INPUT_LIMITS = {
  rating: [1, 7],
  glucose: [0.5, 40],
  systolic: [40, 300],
  diastolic: [20, 200],
  pulse: [20, 250],
  weight: [20, 400],
  'sleep-duration': [0, 1440],
  awakenings: [0, 100],
} as const;

function numberIn(value: unknown, name: keyof typeof INPUT_LIMITS, integer = false) {
  const [min, max] = INPUT_LIMITS[name];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    throw new ApiError(400, 'invalid_value', `${name} must be ${integer ? 'an integer' : 'a number'} from ${min} to ${max}.`);
  }
  return value;
}

function componentValue(components: unknown, code: string) {
  if (!Array.isArray(components)) return undefined;
  return (components.find((c) => c && typeof c === 'object' && (c as { code?: unknown }).code === code) as { value?: unknown } | undefined)?.value;
}

function selfReported(body: unknown, patient: PatientRow, clock: number, earliest: number): StoredObservation {
  const input = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const type = input.type;
  const allowed = [...RATING_TYPES, 'blood-pressure', 'glucose', 'bmi', 'sleep'];
  if (typeof type !== 'string' || !allowed.includes(type)) {
    throw new ApiError(400, 'invalid_type', `type must be one of ${allowed.join(', ')}. CRP comes only from a lab.`);
  }

  const time = (raw: unknown, name: string) => {
    const ms = raw === undefined ? clock : parseTime(raw, name);
    if (ms < earliest || ms > clock) throw new ApiError(400, 'invalid_time', `${name} must lie between ${isoTime(earliest)} and ${isoTime(clock)} (the demo clock).`);
    return ms;
  };
  const suffix = randomBytes(3).toString('hex');
  const base = (ms: number) => ({
    id: `${type}-${isoTime(ms).replace(/[-:]/g, '')}-${suffix}`,
    type: type as ObservationType,
    sourceType: 'patient-reported' as const,
    deviceId: null,
  });

  if (type === 'sleep') {
    const period = (input.effectivePeriod ?? {}) as { start?: unknown; end?: unknown };
    const start = time(period.start, 'effectivePeriod.start');
    const end = time(period.end, 'effectivePeriod.end');
    if (end <= start) throw new ApiError(400, 'invalid_time', 'effectivePeriod.end must be after effectivePeriod.start.');
    const minutes = componentValue(input.components, 'sleep-duration') ?? Math.round((end - start) / 60_000);
    const awakenings = componentValue(input.components, 'awakenings');
    const components: Component[] = [{ code: 'sleep-duration', value: numberIn(minutes, 'sleep-duration', true), unit: 'min' }];
    if (awakenings !== undefined) components.push({ code: 'awakenings', value: numberIn(awakenings, 'awakenings', true), unit: 'count' });
    return { ...base(end), effectivePeriod: { start: isoTime(start), end: isoTime(end) }, components };
  }

  const ms = time(input.effectiveDateTime, 'effectiveDateTime');
  const effectiveDateTime = isoTime(ms);
  if (isRatingType(type)) return { ...base(ms), effectiveDateTime, value: numberIn(input.value, 'rating', true), unit: RATING_UNIT };
  switch (type) {
    case 'glucose':
      return { ...base(ms), effectiveDateTime, value: Math.round(numberIn(input.value, 'glucose') * 10) / 10, unit: 'mmol/L' };
    case 'blood-pressure': {
      const components: Component[] = [
        { code: 'systolic', value: numberIn(componentValue(input.components, 'systolic'), 'systolic', true), unit: 'mmHg' },
        { code: 'diastolic', value: numberIn(componentValue(input.components, 'diastolic'), 'diastolic', true), unit: 'mmHg' },
      ];
      const pulse = componentValue(input.components, 'pulse');
      if (pulse !== undefined) components.push({ code: 'pulse', value: numberIn(pulse, 'pulse', true), unit: '/min' });
      return { ...base(ms), effectiveDateTime, components };
    }
    default: {
      // bmi: she enters her weight; BMI is calculated from it and her height in the profile.
      if (!patient.height_cm) throw new ApiError(400, 'height_missing', 'BMI needs a height in the profile.');
      const kg = Math.round(numberIn(componentValue(input.components, 'weight'), 'weight') * 10) / 10;
      return {
        ...base(ms),
        effectiveDateTime,
        value: Math.round((kg / (patient.height_cm / 100) ** 2) * 10) / 10,
        unit: 'kg/m²',
        components: [
          { code: 'weight', value: kg, unit: 'kg' },
          { code: 'height', value: patient.height_cm, unit: 'cm' },
        ],
      };
    }
  }
}

function withQuery(req: Request, changes: Record<string, string>) {
  const url = new URL(req.originalUrl, 'http://local');
  for (const [key, value] of Object.entries(changes)) url.searchParams.set(key, value);
  return `${url.pathname}${url.search}`;
}
