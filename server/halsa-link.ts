import type { Express, Request, Response } from 'express';
import { HALSA_TYPES, type HalsaObservation, type HalsaPoint, type HalsaPoints, type HalsaType, pointsFromObservation } from '../shared/halsa.ts';
import { db, get, now, run } from './db.ts';

// The link between an MMD patient and the same patient's Hälsa+ account.
//
// MMD reads Hälsa+ the way a real integration would: over its HTTP API with
// the patient's own bearer token, never by opening the Hälsa+ database. The
// token stays on the server: it is never sent to the browser and never logged.
//
// Where Hälsa+ is: HALSA_PLUS_URL, or by default the copy mounted in this
// same service at /halsa-plus (http://127.0.0.1:$PORT/halsa-plus/api/v1). If
// Hälsa+ moves to a service of its own, only that variable changes.
//
// Which token: a row in halsa_links, or for Andrea Lindqvist (the demo
// patient, same GUID in PDHC and Hälsa+) HALSA_ANDREA_TOKEN when she has no
// row. The environment token is not copied into the database.

/** Andrea Lindqvist: her patient GUID in PDHC is also her id in Hälsa+. Synthetic. */
export const ANDREA_GUID = '28a29239-6424-48e7-a123-9d9e863670b8';

const TIMEOUT_MS = 8000;
const MAX_PAGES = 10;
const PAGE_SIZE = 5000;

db.exec(`
  -- One row per MMD patient with a Hälsa+ account. token is that patient's
  -- Hälsa+ bearer token; it is never sent to the browser.
  CREATE TABLE IF NOT EXISTS halsa_links (
    patient_guid TEXT PRIMARY KEY,
    token        TEXT NOT NULL,
    label        TEXT,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
  );
`);

export class HalsaError extends Error {
  readonly status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.status = status;
  }
}

export function saveHalsaLink(patientGuid: string, token: string, label: string | null = null) {
  const value = token.trim();
  if (value.length < 16 || /\s/.test(value)) throw new HalsaError('The Hälsa+ token does not look right.', 400);
  run(
    `INSERT INTO halsa_links (patient_guid, token, label, created_at, updated_at) VALUES (:patientGuid, :token, :label, :at, :at)
     ON CONFLICT (patient_guid) DO UPDATE SET token = excluded.token, label = excluded.label, updated_at = excluded.updated_at`,
    { patientGuid, token: value, label, at: now() },
  );
}

export function removeHalsaLink(patientGuid: string) {
  run('DELETE FROM halsa_links WHERE patient_guid = :patientGuid', { patientGuid });
}

/** The patient's Hälsa+ token, or undefined if the patient has no link. Server side only. */
export function halsaTokenFor(patientGuid: string): string | undefined {
  const row = get<{ token: string }>('SELECT token FROM halsa_links WHERE patient_guid = :patientGuid', { patientGuid });
  if (row) return row.token;
  const fromEnv = process.env.HALSA_ANDREA_TOKEN?.trim();
  return patientGuid === ANDREA_GUID && fromEnv ? fromEnv : undefined;
}

export function halsaBaseUrl(): string {
  const configured = process.env.HALSA_PLUS_URL?.trim();
  if (configured) return configured.replace(/\/+$/, '');
  return `http://127.0.0.1:${Number(process.env.PORT) || 3001}/halsa-plus/api/v1`;
}

type Query = Record<string, string | undefined>;

async function halsaFetch<T>(token: string, path: string, query: Query = {}, body?: unknown): Promise<T> {
  const url = new URL(halsaBaseUrl() + path);
  for (const [key, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(key, value);
  let response: globalThis.Response;
  try {
    response = await fetch(url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new HalsaError('Hälsa+ could not be reached.');
  }
  const data = (await response.json().catch(() => ({}))) as { error?: { message?: unknown } };
  if (!response.ok) {
    // Hälsa+'s own message, never the request (which holds the token).
    const message = data.error?.message;
    const reason = typeof message === 'string' ? `: ${message.slice(0, 300)}` : '.';
    throw new HalsaError(`Hälsa+ answered ${response.status}${reason}`, response.status === 400 ? 400 : 502);
  }
  return data as T;
}

async function deviceNames(token: string, asOf: string | undefined) {
  const devices = await halsaFetch<{ items?: { id: string; name: string }[] }>(token, '/devices', { asOf });
  return new Map((devices.items ?? []).map((d) => [d.id, d.name]));
}

function cleanTypes(raw: unknown): HalsaType[] {
  if (raw === undefined || raw === '') return [...HALSA_TYPES];
  const types = String(raw)
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  const unknown = types.filter((t) => !HALSA_TYPES.includes(t as HalsaType));
  if (unknown.length) throw new HalsaError(`Unknown Hälsa+ type: ${unknown.join(', ')}.`, 400);
  return types as HalsaType[];
}

function cleanTime(raw: unknown, name: string): string | undefined {
  if (raw === undefined || raw === '') return undefined;
  const ms = Date.parse(String(raw));
  if (typeof raw !== 'string' || Number.isNaN(ms)) throw new HalsaError(`${name} is not a date and time.`, 400);
  return new Date(ms).toISOString();
}

interface Page {
  asOf: string;
  items: HalsaObservation[];
  nextCursor: string | null;
}

/** The patient's Hälsa+ series between from and to, oldest first. */
export async function readHalsaSeries(token: string, input: { types?: unknown; from?: unknown; to?: unknown; asOf?: unknown }): Promise<HalsaPoints> {
  const types = cleanTypes(input.types);
  const asOf = cleanTime(input.asOf, 'asOf');
  const query: Query = { type: types.join(','), from: cleanTime(input.from, 'from'), to: cleanTime(input.to, 'to'), asOf, limit: String(PAGE_SIZE) };
  const names = await deviceNames(token, asOf);
  const points: HalsaPoint[] = [];
  let page = await halsaFetch<Page>(token, '/observations', query);
  for (let pages = 1; ; pages++) {
    for (const item of page.items) points.push(...pointsFromObservation(item, names));
    if (!page.nextCursor || pages >= MAX_PAGES) break;
    page = await halsaFetch<Page>(token, '/observations', { ...query, cursor: page.nextCursor });
  }
  return { asOf: page.asOf, points };
}

/** The latest value of each series at asOf. */
export async function readLatestHalsa(token: string, input: { types?: unknown; asOf?: unknown }): Promise<HalsaPoints> {
  const types = cleanTypes(input.types);
  const asOf = cleanTime(input.asOf, 'asOf');
  const names = await deviceNames(token, asOf);
  const latest = await halsaFetch<{ asOf: string; items: HalsaObservation[] }>(token, '/observations/latest', { type: types.join(','), asOf });
  return { asOf: latest.asOf, points: latest.items.flatMap((item) => pointsFromObservation(item, names)) };
}

/** A 0–10 self-rating the patient gave in the app, written to Hälsa+ as well. */
export async function writeHalsaRating(token: string, input: { type?: unknown; value?: unknown; asOf?: unknown }): Promise<HalsaPoint[]> {
  const type = input.type;
  if (type !== 'anxiety' && type !== 'stress') throw new HalsaError('Only anxiety and stress ratings are written to Hälsa+.', 400);
  const value = Number(input.value);
  if (!Number.isInteger(value) || value < 0 || value > 10) throw new HalsaError('A rating is a whole number from 0 to 10.', 400);
  const asOf = cleanTime(input.asOf, 'asOf');
  const created = await halsaFetch<HalsaObservation>(token, '/observations', { asOf }, { type, value });
  return pointsFromObservation(created, await deviceNames(token, asOf));
}

function linkedToken(req: Request, res: Response): string | undefined {
  const token = halsaTokenFor(String(req.params.patient));
  if (!token) res.status(404).json({ error: 'This patient has no Hälsa+ link.' });
  return token;
}

function sendHalsaError(res: Response, error: unknown) {
  if (error instanceof HalsaError) return res.status(error.status).json({ error: error.message });
  console.error(error);
  res.status(500).json({ error: 'Something went wrong on the server.' });
}

/**
 * The patient app's Hälsa+ endpoints. Register after setupApi() (so JSON
 * bodies are parsed and the login applies) and before the /api 404.
 */
export function setupHalsaLink(app: Express) {
  /** Series: ?type=glucose,sleep&from=&to=&asOf= */
  app.get('/api/app/:patient/halsa', async (req, res) => {
    const token = linkedToken(req, res);
    if (!token) return;
    try {
      res.json(await readHalsaSeries(token, { types: req.query.type, from: req.query.from, to: req.query.to, asOf: req.query.asOf }));
    } catch (error) {
      sendHalsaError(res, error);
    }
  });

  /** The latest value of each series at asOf: ?type=&asOf= */
  app.get('/api/app/:patient/halsa/latest', async (req, res) => {
    const token = linkedToken(req, res);
    if (!token) return;
    try {
      res.json(await readLatestHalsa(token, { types: req.query.type, asOf: req.query.asOf }));
    } catch (error) {
      sendHalsaError(res, error);
    }
  });

  /** Body { type: 'anxiety' | 'stress', value: 0–10 }; ?asOf= for the demo clock. */
  app.post('/api/app/:patient/halsa/observations', async (req, res) => {
    const token = linkedToken(req, res);
    if (!token) return;
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      res.status(201).json({ points: await writeHalsaRating(token, { type: body.type, value: body.value, asOf: req.query.asOf }) });
    } catch (error) {
      sendHalsaError(res, error);
    }
  });
}
