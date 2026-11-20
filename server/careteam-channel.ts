import express from 'express';
import type { Express, Request, Response } from 'express';
import { safeEqual } from './auth.ts';
import { all, db, get, now, run } from './db.ts';
import { type ChatMessage, toMessageBundle } from './messaging.ts';
import { getSettings } from './settings.ts';
import { addMessage, isClosed, type ServiceRequestRow } from './store.ts';

// The chat channel to an external care-team system, as FHIR messaging.
//
// Outbound: the patient's own chat messages (written in the app or through an
// AI assistant: both are stored with Casper's addMessage) are picked up from
// the messages table, an "outbox", and POSTed as a FHIR message Bundle
// (Casper's toMessageBundle, completed with destination, patient and plan) to
// {endpointUrl}/{sendPath}. Each delivery gets a status: pending, delivered or
// failed.
//
// Inbound: the care team's Communications are fetched every 30 s (poll) or
// pushed to POST /api/v1/inbound/message (push), and stored as chat messages
// from the care team, once per remote Communication id.
//
// For the demo the channel is for one patient, Andrea Lindqvist (synthetic),
// by her PDHC patient GUID. Everything is configured in the admin console and
// stored in the settings table; without it, the chat works as before. The
// token and the push secret never reach the browser or the log.

export const ANDREA_GUID = '28a29239-6424-48e7-a123-9d9e863670b8';
const ANDREA_IDENTIFIER = { system: 'urn:oid:1.2.752.129.2.1.3.1', value: '200207252388' };
const ANDREA_BIRTH_DATE = '2002-07-25';
const DEFAULT_PUBLIC_URL = 'https://mmd-hackathon.onrender.com';
const TIMEOUT_MS = 15_000;
const MAX_ATTEMPTS = 5;
const RETRY_AFTER_MS = 60_000;

export const DEFAULTS = {
  authHeader: 'Authorization: Bearer {token}',
  sendPath: '$process-message',
  receiveMode: 'poll' as ReceiveMode,
  pollPath: 'Communication?patient=Patient/{patientGuid}&_lastUpdated=gt{since}',
  healthPath: 'metadata',
  patientGuid: ANDREA_GUID,
  /** The care team's own id for the same patient (Casper's demo patient GUID). */
  patientAliases: 'a7d3c1e2-5b4f-4c6a-9e8d-2f1b0c3d4e51',
  payloadFormat: 'r5' as PayloadFormat,
};

export type ReceiveMode = 'poll' | 'push' | 'off';
export type PayloadFormat = 'r5' | 'r4';

export interface ChannelSettings {
  enabled: boolean;
  endpointUrl: string | null;
  token: string | null;
  authHeader: string;
  sendPath: string;
  receiveMode: ReceiveMode;
  pollPath: string;
  healthPath: string;
  pushSecret: string | null;
  patientGuid: string;
  /** Other ids the care team's system may use for the same patient; their Communications are stored for patientGuid. */
  patientAliases: string[];
  payloadFormat: PayloadFormat;
}

/** What the admin console sees: no secrets, only their last four characters. */
export interface ChannelSettingsView extends Omit<ChannelSettings, 'token' | 'pushSecret'> {
  tokenHint: string | null;
  pushSecretHint: string | null;
  inboundUrl: string;
}

export class ChannelError extends Error {}

db.exec(`
  -- One row per chat message sent to the care-team channel.
  CREATE TABLE IF NOT EXISTS careteam_deliveries (
    message_id INTEGER PRIMARY KEY,
    status     TEXT NOT NULL CHECK (status IN ('pending', 'delivered', 'failed')),
    detail     TEXT,
    remote_id  TEXT,
    attempts   INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  );
  -- Every Communication received from the care team, so each is stored once.
  CREATE TABLE IF NOT EXISTS careteam_inbound (
    remote_id   TEXT PRIMARY KEY,
    message_id  INTEGER NOT NULL,
    sender_name TEXT,
    received_at TEXT NOT NULL
  );
  -- What happened on the channel, for the admin console. Never holds secrets.
  CREATE TABLE IF NOT EXISTS careteam_log (
    id        INTEGER PRIMARY KEY,
    at        TEXT NOT NULL,
    direction TEXT NOT NULL,
    outcome   TEXT NOT NULL,
    detail    TEXT
  );
`);

// --- Settings, in Casper's settings table under keys of our own ---------------------

const KEY = (name: string) => `careteam_${name}`;

function readKey(name: string): string | null {
  return get<{ value: string }>('SELECT value FROM settings WHERE key = :key', { key: KEY(name) })?.value ?? null;
}

function writeKey(name: string, value: string | null) {
  if (value === null) run('DELETE FROM settings WHERE key = :key', { key: KEY(name) });
  else
    run(
      `INSERT INTO settings (key, value, updated_at) VALUES (:key, :value, :at)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      { key: KEY(name), value, at: now() },
    );
}

export function getChannelSettings(): ChannelSettings {
  const mode = readKey('receive_mode');
  const format = readKey('payload_format');
  return {
    enabled: readKey('enabled') === 'true',
    endpointUrl: readKey('endpoint_url'),
    token: readKey('token'),
    authHeader: readKey('auth_header') ?? DEFAULTS.authHeader,
    sendPath: readKey('send_path') ?? DEFAULTS.sendPath,
    receiveMode: mode === 'push' || mode === 'off' || mode === 'poll' ? mode : DEFAULTS.receiveMode,
    pollPath: readKey('poll_path') ?? DEFAULTS.pollPath,
    healthPath: readKey('health_path') ?? DEFAULTS.healthPath,
    pushSecret: readKey('push_secret'),
    patientGuid: readKey('patient_guid') ?? DEFAULTS.patientGuid,
    patientAliases: (readKey('patient_aliases') ?? DEFAULTS.patientAliases)
      .split(',')
      .map((alias) => alias.trim())
      .filter(Boolean),
    payloadFormat: format === 'r4' ? 'r4' : 'r5',
  };
}

const hint = (secret: string | null) => (secret ? `…${secret.slice(-4)}` : null);

export function toChannelView(settings = getChannelSettings()): ChannelSettingsView {
  const { token, pushSecret, ...rest } = settings;
  const base = getSettings().publicUrl ?? DEFAULT_PUBLIC_URL;
  return { ...rest, tokenHint: hint(token), pushSecretHint: hint(pushSecret), inboundUrl: `${base.replace(/\/+$/, '')}/api/v1/inbound/message` };
}

function cleanUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ChannelError('The endpoint URL is not a valid address.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new ChannelError('The endpoint URL must start with https:// (or http:// for a local test).');
  if (url.username || url.password) throw new ChannelError('The endpoint URL must not contain a user name or password.');
  url.hash = '';
  return url.toString().replace(/\/+$/, '');
}

/**
 * Saves what the admin console sends. Per field: undefined keeps it, '' or
 * null resets it (to the default, or removes a secret), a value replaces it.
 * Turning the channel on starts from now: older chat messages are not sent.
 */
export function saveChannelSettings(body: unknown): ChannelSettings {
  const input = (body ?? {}) as Record<string, unknown>;
  const text = (name: string, max = 500) => {
    const raw = input[name];
    if (raw === undefined) return undefined;
    if (raw !== null && typeof raw !== 'string') throw new ChannelError(`${name} must be text.`);
    const value = (raw ?? '').trim();
    if (value.length > max) throw new ChannelError(`${name} is too long.`);
    return value || null;
  };
  const before = getChannelSettings();
  const changes: [string, string | null][] = [];

  const endpointUrl = text('endpointUrl', 2048);
  if (endpointUrl !== undefined) changes.push(['endpoint_url', endpointUrl ? cleanUrl(endpointUrl) : null]);
  for (const [field, key] of [
    ['token', 'token'],
    ['pushSecret', 'push_secret'],
  ] as const) {
    const value = text(field, 4096);
    if (value !== undefined) {
      if (value && /\s/.test(value)) throw new ChannelError(`${field} must not contain spaces.`);
      if (field === 'pushSecret' && value && value.length < 16) throw new ChannelError('The push secret must be at least 16 characters.');
      changes.push([key, value]);
    }
  }
  for (const [field, key] of [
    ['authHeader', 'auth_header'],
    ['sendPath', 'send_path'],
    ['pollPath', 'poll_path'],
    ['healthPath', 'health_path'],
    ['patientGuid', 'patient_guid'],
  ] as const) {
    const value = text(field);
    if (value !== undefined) changes.push([key, value]);
  }
  if (input.patientAliases !== undefined) {
    const raw = Array.isArray(input.patientAliases) ? input.patientAliases.join(',') : input.patientAliases;
    if (raw !== null && typeof raw !== 'string') throw new ChannelError('patientAliases must be text.');
    // An empty field is kept as empty (no aliases), not reset to the default.
    changes.push(['patient_aliases', (raw ?? '').split(',').map((a) => a.trim()).filter(Boolean).join(',')]);
  }
  if (input.receiveMode !== undefined) {
    if (!['poll', 'push', 'off'].includes(String(input.receiveMode))) throw new ChannelError('receiveMode is poll, push or off.');
    changes.push(['receive_mode', String(input.receiveMode)]);
  }
  if (input.payloadFormat !== undefined) {
    if (!['r5', 'r4'].includes(String(input.payloadFormat))) throw new ChannelError('payloadFormat is r5 or r4.');
    changes.push(['payload_format', String(input.payloadFormat)]);
  }
  if (input.enabled !== undefined) changes.push(['enabled', input.enabled === true ? 'true' : 'false']);

  db.exec('BEGIN');
  try {
    for (const [key, value] of changes) writeKey(key, value);
    const after = getChannelSettings();
    if (after.enabled && !before.enabled) {
      const last = get<{ id: number | null }>('SELECT MAX(id) AS id FROM messages')?.id ?? 0;
      const at = new Date().toISOString();
      writeKey('first_message_id', String(last));
      writeKey('poll_since', at);
      writeKey('enabled_at', at);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return getChannelSettings();
}

function log(direction: 'out' | 'in' | 'test', outcome: string, detail: string | null) {
  run('INSERT INTO careteam_log (at, direction, outcome, detail) VALUES (:at, :direction, :outcome, :detail)', {
    at: now(),
    direction,
    outcome,
    detail: detail?.slice(0, 500) ?? null,
  });
}

// --- Talking to the care-team endpoint ----------------------------------------------

/** "{endpointUrl}/{path}", or the path itself when it is a full URL. Placeholders filled in. */
export function channelUrl(settings: ChannelSettings, path: string, values: Record<string, string> = {}) {
  if (!settings.endpointUrl) throw new ChannelError('The channel has no endpoint URL.');
  const filled = path.replace(/\{(\w+)\}/g, (all, name: string) => (name in values ? encodeURIComponent(values[name]).replace(/%2F/gi, '/') : all));
  if (/^https?:\/\//i.test(filled)) return filled;
  return `${settings.endpointUrl}/${filled.replace(/^\/+/, '')}`;
}

/** The auth header: "Name: value with {token}", or just "Name" (the token as the value). */
export function authHeaders(settings: ChannelSettings): Record<string, string> {
  if (!settings.token) return {};
  const spec = settings.authHeader.trim() || DEFAULTS.authHeader;
  const colon = spec.indexOf(':');
  if (colon === -1) return { [spec]: spec.toLowerCase() === 'authorization' ? `Bearer ${settings.token}` : settings.token };
  const name = spec.slice(0, colon).trim();
  const template = spec.slice(colon + 1).trim();
  return { [name]: template.includes('{token}') ? template.replace('{token}', settings.token) : `${template} ${settings.token}`.trim() };
}

async function request(settings: ChannelSettings, method: 'GET' | 'POST', url: string, body?: unknown) {
  return fetch(url, {
    method,
    headers: {
      Accept: 'application/fhir+json, application/json',
      ...(body === undefined ? {} : { 'Content-Type': 'application/fhir+json' }),
      ...authHeaders(settings),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'error',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

/** Their answer, short and without anything that could be a secret we sent. */
async function shortAnswer(response: globalThis.Response, settings: ChannelSettings) {
  let text = (await response.text().catch(() => '')).slice(0, 300);
  for (const secret of [settings.token, settings.pushSecret]) if (secret) text = text.split(secret).join('[secret]');
  return text.replace(/\s+/g, ' ').trim();
}

export async function testConnection(settings = getChannelSettings()) {
  try {
    const response = await request(settings, 'GET', channelUrl(settings, settings.healthPath));
    const detail = await shortAnswer(response, settings);
    return { ok: response.ok, status: response.status, message: `${response.status} ${response.statusText}${detail ? ` · ${detail.slice(0, 160)}` : ''}` };
  } catch (error) {
    return { ok: false, status: 0, message: error instanceof Error ? `Could not reach the endpoint: ${error.message}` : 'Could not reach the endpoint.' };
  }
}

// --- Outbound -----------------------------------------------------------------------

/** The patient's latest open PDHC request, for Communication.basedOn / about. */
export function currentRequest(patientGuid: string): string | null {
  const rows = all<ServiceRequestRow>('SELECT * FROM service_requests WHERE patient_guid = :p ORDER BY received_at DESC', { p: patientGuid });
  return rows.find((row) => !isClosed(row))?.guid ?? null;
}

type Json = Record<string, any>;

/** Casper's FHIR message Bundle, completed for the care-team endpoint. */
export function buildOutboundBundle(message: ChatMessage, settings: ChannelSettings) {
  const bundle = toMessageBundle(message) as Json;
  const [headerEntry, communicationEntry] = bundle.entry as Json[];
  const header = headerEntry.resource as Json;
  const communication = communicationEntry.resource as Json;
  const patientGuid = message.patientGuid;
  const andrea = patientGuid === ANDREA_GUID;

  header.id = `mmd-header-${message.id}`;
  header.source = { ...header.source, endpointUrl: getSettings().publicUrl ?? DEFAULT_PUBLIC_URL };
  if (settings.endpointUrl) header.destination = [{ name: 'Care team', endpointUrl: settings.endpointUrl }];

  communication.subject = { reference: `Patient/${patientGuid}`, ...(andrea ? { identifier: ANDREA_IDENTIFIER } : {}) };
  if (message.sender === 'patient') communication.sender = communication.subject;
  const plan = message.serviceRequestGuid ?? currentRequest(patientGuid);
  if (plan) {
    communication.basedOn = [{ reference: `ServiceRequest/${plan}` }];
    communication.about = [{ reference: `ServiceRequest/${plan}` }];
  }
  if (settings.payloadFormat === 'r4') communication.payload = [{ contentString: message.text }];

  bundle.id = `mmd-message-bundle-${message.id}`;
  bundle.entry.push({
    fullUrl: `urn:uuid:${patientGuid}`,
    resource: {
      resourceType: 'Patient',
      id: patientGuid,
      ...(andrea ? { identifier: [ANDREA_IDENTIFIER], birthDate: ANDREA_BIRTH_DATE } : {}),
    },
  });
  return bundle;
}

/** The id the care team gave the message, if their answer says. */
function remoteIdOf(body: unknown, location: string | null): string | null {
  const json = body as Json | null;
  if (json?.resourceType === 'Bundle' && Array.isArray(json.entry)) {
    for (const entry of json.entry as Json[]) {
      const resource = entry?.resource as Json | undefined;
      if (resource?.resourceType === 'Communication' && resource.id) return String(resource.id);
      if (resource?.resourceType === 'MessageHeader' && resource.id) return String(resource.id);
    }
    if (json.id) return String(json.id);
  }
  if (json?.id) return String(json.id);
  return location;
}

type Delivery = { status: 'delivered' | 'failed'; detail: string; remoteId: string | null; network: boolean };

async function sendOnce(message: ChatMessage, settings: ChannelSettings): Promise<Delivery> {
  try {
    const response = await request(settings, 'POST', channelUrl(settings, settings.sendPath), buildOutboundBundle(message, settings));
    if (response.ok) {
      const text = await response.text().catch(() => '');
      let body: unknown = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = null;
      }
      return { status: 'delivered', detail: `Delivered (${response.status}).`, remoteId: remoteIdOf(body, response.headers.get('location')), network: false };
    }
    const detail = await shortAnswer(response, settings);
    return { status: 'failed', detail: `The care team answered ${response.status}.${detail ? ` ${detail.slice(0, 200)}` : ''}`, remoteId: null, network: false };
  } catch (error) {
    return { status: 'failed', detail: error instanceof Error ? `Could not reach the care team: ${error.message}` : 'Could not reach the care team.', remoteId: null, network: true };
  }
}

interface MessageRow {
  id: number;
  patient_guid: string;
  sender: ChatMessage['sender'];
  text: string;
  service_request_guid: string | null;
  created_at: string;
  via: string | null;
}

const toChatMessage = (row: MessageRow): ChatMessage => ({
  id: row.id,
  patientGuid: row.patient_guid,
  sender: row.sender,
  text: row.text,
  serviceRequestGuid: row.service_request_guid,
  createdAt: row.created_at,
  via: row.via,
});

/** Sends one stored chat message; a network error is tried once more right away. */
export async function deliver(messageId: number, settings = getChannelSettings()) {
  const row = get<MessageRow>('SELECT * FROM messages WHERE id = :id', { id: messageId });
  if (!row) return undefined;
  const previous = get<{ attempts: number }>('SELECT attempts FROM careteam_deliveries WHERE message_id = :id', { id: messageId });
  run(
    `INSERT INTO careteam_deliveries (message_id, status, attempts, updated_at) VALUES (:id, 'pending', :attempts, :at)
     ON CONFLICT (message_id) DO UPDATE SET status = 'pending', updated_at = excluded.updated_at`,
    { id: messageId, attempts: previous?.attempts ?? 0, at: now() },
  );
  const message = toChatMessage(row);
  let outcome = await sendOnce(message, settings);
  let attempts = 1;
  if (outcome.network) {
    outcome = await sendOnce(message, settings);
    attempts = 2;
  }
  run(
    `UPDATE careteam_deliveries SET status = :status, detail = :detail, remote_id = :remoteId, attempts = attempts + :attempts, updated_at = :at
     WHERE message_id = :id`,
    { id: messageId, status: outcome.status, detail: outcome.detail, remoteId: outcome.remoteId, attempts, at: now() },
  );
  log('out', outcome.status, `Message ${messageId}: ${outcome.detail}`);
  return outcome;
}

let sending = false;

/**
 * The outbox: the configured patient's own messages written since the
 * channel was turned on, not yet delivered. Failed ones are tried again after
 * a minute, at most MAX_ATTEMPTS times in all.
 */
export async function sendPending(settings = getChannelSettings()) {
  if (!settings.enabled || !settings.endpointUrl || sending) return 0;
  sending = true;
  try {
    const first = Number(readKey('first_message_id') ?? '0');
    const retryBefore = new Date(Date.now() - RETRY_AFTER_MS).toISOString();
    const due = all<{ id: number }>(
      `SELECT m.id FROM messages m LEFT JOIN careteam_deliveries d ON d.message_id = m.id
       WHERE m.patient_guid = :patient AND m.sender = 'patient' AND m.id > :first
         AND (d.message_id IS NULL OR (d.status = 'failed' AND d.attempts < :max AND d.updated_at < :retryBefore))
       ORDER BY m.id LIMIT 20`,
      { patient: settings.patientGuid, first, max: MAX_ATTEMPTS, retryBefore },
    );
    for (const { id } of due) await deliver(id, settings);
    return due.length;
  } finally {
    sending = false;
  }
}

// --- Inbound ------------------------------------------------------------------------

function textOf(communication: Json): string {
  const parts = (Array.isArray(communication.payload) ? communication.payload : []).map((p: Json) =>
    typeof p?.contentString === 'string'
      ? p.contentString
      : typeof p?.contentCodeableConcept?.text === 'string'
        ? p.contentCodeableConcept.text
        : typeof p?.contentAttachment?.title === 'string'
          ? p.contentAttachment.title
          : '',
  );
  return parts.filter(Boolean).join('\n').trim();
}

function patientOf(communication: Json): string | null {
  const subject = communication.subject as Json | undefined;
  const reference = typeof subject?.reference === 'string' ? subject.reference : '';
  const id = reference.replace(/^.*Patient\//, '').replace(/^urn:uuid:/, '');
  if (id) return id;
  if (subject?.identifier?.value === ANDREA_IDENTIFIER.value) return ANDREA_GUID;
  return null;
}

/** Ours (sent by MMD, or written by the patient), as opposed to the care team's. */
function isOurs(communication: Json) {
  if (communication.meta?.source === 'MMD' || String(communication.id ?? '').startsWith('mmd-message-')) return true;
  const sender = typeof communication.sender?.reference === 'string' ? communication.sender.reference : '';
  return /(^|\/)Patient\//.test(sender) || sender.startsWith('urn:uuid:') && sender.includes(String(patientOf(communication)));
}

export interface InboundResult {
  stored: number;
  duplicates: number;
  ignored: number;
  rejected: number;
  latest: string | null;
}

/** Stores the care team's Communications in a Bundle (searchset or message) as chat messages. */
export function receiveBundle(body: unknown, settings = getChannelSettings(), via = 'poll'): InboundResult {
  const result: InboundResult = { stored: 0, duplicates: 0, ignored: 0, rejected: 0, latest: null };
  // Only what the care team wrote after the channel was turned on.
  const enabledAt = readKey('enabled_at');
  const json = body as Json | null;
  const resources: Json[] =
    json?.resourceType === 'Bundle'
      ? (Array.isArray(json.entry) ? json.entry : []).map((e: Json) => e?.resource).filter((r: Json) => r?.resourceType === 'Communication')
      : json?.resourceType === 'Communication'
        ? [json]
        : [];

  for (const c of resources) {
    const seenAt = (typeof c.meta?.lastUpdated === 'string' && c.meta.lastUpdated) || (typeof c.sent === 'string' && c.sent) || null;
    if (seenAt && (!result.latest || seenAt > result.latest)) result.latest = seenAt;
    if (isOurs(c)) {
      result.ignored += 1;
      continue;
    }
    // Ours, one of the care team's ids for her, or no subject: stored for our patient.
    const subject = patientOf(c);
    if (subject !== null && subject !== settings.patientGuid && !settings.patientAliases.includes(subject)) {
      result.rejected += 1;
      log('in', 'rejected', `${via}: a Communication for another patient (${subject}) was ignored.`);
      continue;
    }
    const patient = settings.patientGuid;
    if (enabledAt && typeof c.sent === 'string' && c.sent < enabledAt) {
      result.ignored += 1;
      continue;
    }
    const text = textOf(c);
    const remoteId = String(c.id ?? c.identifier?.[0]?.value ?? `${seenAt}:${text.slice(0, 40)}`);
    if (!text) {
      result.ignored += 1;
      continue;
    }
    if (get('SELECT remote_id FROM careteam_inbound WHERE remote_id = :id', { id: remoteId })) {
      result.duplicates += 1;
      continue;
    }
    if (!get('SELECT guid FROM patients WHERE guid = :guid', { guid: patient })) {
      result.rejected += 1;
      log('in', 'rejected', `${via}: the patient is not in MMD yet.`);
      continue;
    }
    const plan = typeof c.basedOn?.[0]?.reference === 'string' ? c.basedOn[0].reference.replace(/^.*ServiceRequest\//, '') : null;
    const ownPlan = plan && get<{ guid: string }>('SELECT guid FROM service_requests WHERE guid = :g AND patient_guid = :p', { g: plan, p: patient }) ? plan : null;
    const sent = typeof c.sent === 'string' && !Number.isNaN(Date.parse(c.sent)) && Date.parse(c.sent) <= Date.now() + 60_000 ? new Date(c.sent).toISOString() : now();
    const message = addMessage(patient, 'care-team', text, ownPlan, sent);
    const senderName = typeof c.sender?.display === 'string' ? c.sender.display.slice(0, 80) : null;
    run('INSERT INTO careteam_inbound (remote_id, message_id, sender_name, received_at) VALUES (:id, :m, :name, :at)', {
      id: remoteId,
      m: message.id,
      name: senderName,
      at: now(),
    });
    result.stored += 1;
  }
  if (result.stored) log('in', 'stored', `${via}: ${result.stored} message(s) from the care team.`);
  return result;
}

let polling = false;

/** Poll mode: fetches the care team's Communications since the last one seen. */
export async function pollOnce(settings = getChannelSettings()): Promise<InboundResult | { error: string }> {
  if (!settings.enabled || settings.receiveMode !== 'poll' || !settings.endpointUrl) return { error: 'Poll mode is not on.' };
  if (polling) return { error: 'Already fetching.' };
  polling = true;
  try {
    const since = readKey('poll_since') ?? new Date(Date.now() - 24 * 3600_000).toISOString();
    const response = await request(settings, 'GET', channelUrl(settings, settings.pollPath, { patientGuid: settings.patientGuid, since }));
    if (!response.ok) {
      const detail = `Fetching answered ${response.status}. ${await shortAnswer(response, settings)}`.trim();
      log('in', 'failed', detail);
      return { error: detail };
    }
    const result = receiveBundle(await response.json(), settings, 'poll');
    if (result.latest && result.latest > since) writeKey('poll_since', result.latest);
    return result;
  } catch (error) {
    const detail = error instanceof Error ? `Could not fetch from the care team: ${error.message}` : 'Could not fetch from the care team.';
    log('in', 'failed', detail);
    return { error: detail };
  } finally {
    polling = false;
  }
}

// --- On-demand polls from the open chat --------------------------------------------------
//
// While the patient has the Chat screen open, the app asks for a fetch every
// second. Across all clients, at most one fetch starts per second; while one
// is running (also the 30-second background one) nothing new starts and the
// last result is returned. After three failed fetches in a row, on-demand
// fetches wait 10 seconds until one succeeds.

export const ON_DEMAND_INTERVAL_MS = 1000;
export const ON_DEMAND_BACKOFF_MS = 10_000;
export const ON_DEMAND_FAILURES_BEFORE_BACKOFF = 3;

type PollResult = InboundResult | { error: string };
export type OnDemandResult = PollResult & { fresh: boolean };

const onDemand = { lastStartedAt: -Infinity, lastResult: null as PollResult | null, failures: 0, running: false };

/** For tests: forget the on-demand state. */
export function resetOnDemandPolling() {
  Object.assign(onDemand, { lastStartedAt: -Infinity, lastResult: null, failures: 0, running: false });
}

export function onDemandWaitMs() {
  return onDemand.failures >= ON_DEMAND_FAILURES_BEFORE_BACKOFF ? ON_DEMAND_BACKOFF_MS : ON_DEMAND_INTERVAL_MS;
}

/** A fetch for the open chat, throttled and never overlapping. `fresh` says whether this call fetched. */
export async function pollOnDemand(settings = getChannelSettings(), now = Date.now()): Promise<OnDemandResult> {
  const last = (): OnDemandResult => ({ ...(onDemand.lastResult ?? { stored: 0, duplicates: 0, ignored: 0, rejected: 0, latest: null }), fresh: false });
  if (onDemand.running || polling) return last();
  if (now - onDemand.lastStartedAt < onDemandWaitMs()) return last();
  onDemand.running = true;
  onDemand.lastStartedAt = now;
  try {
    const result = await pollOnce(settings);
    onDemand.failures = 'error' in result ? onDemand.failures + 1 : 0;
    onDemand.lastResult = result;
    return { ...result, fresh: true };
  } finally {
    onDemand.running = false;
  }
}

// --- Views for the app and the admin console -------------------------------------------

/** Per message: delivery status (the patient's) and sender name (the care team's). */
export function chatStatus(patientGuid: string) {
  const settings = getChannelSettings();
  const enabled = settings.enabled && !!settings.endpointUrl && settings.patientGuid === patientGuid;
  if (!enabled) return { enabled: false, deliveries: {}, senders: {} };
  const deliveries: Record<number, { status: string; final: boolean }> = {};
  for (const d of all<{ message_id: number; status: string; attempts: number }>(
    `SELECT d.message_id, d.status, d.attempts FROM careteam_deliveries d JOIN messages m ON m.id = d.message_id WHERE m.patient_guid = :p`,
    { p: patientGuid },
  )) {
    deliveries[d.message_id] = { status: d.status, final: d.attempts >= MAX_ATTEMPTS };
  }
  const first = Number(readKey('first_message_id') ?? '0');
  for (const { id } of all<{ id: number }>(
    `SELECT id FROM messages WHERE patient_guid = :p AND sender = 'patient' AND id > :first`,
    { p: patientGuid, first },
  )) {
    deliveries[id] ??= { status: 'pending', final: false };
  }
  const senders: Record<number, string> = {};
  for (const s of all<{ message_id: number; sender_name: string | null }>(
    `SELECT i.message_id, i.sender_name FROM careteam_inbound i JOIN messages m ON m.id = i.message_id WHERE m.patient_guid = :p`,
    { p: patientGuid },
  )) {
    if (s.sender_name) senders[s.message_id] = s.sender_name;
  }
  return { enabled: true, deliveries, senders };
}

export function recentActivity() {
  return {
    deliveries: all<{ message_id: number; status: string; detail: string | null; remote_id: string | null; attempts: number; updated_at: string; text: string }>(
      `SELECT d.message_id, d.status, d.detail, d.remote_id, d.attempts, d.updated_at, substr(m.text, 1, 80) AS text
       FROM careteam_deliveries d JOIN messages m ON m.id = d.message_id ORDER BY d.updated_at DESC LIMIT 20`,
    ),
    log: all<{ at: string; direction: string; outcome: string; detail: string | null }>('SELECT at, direction, outcome, detail FROM careteam_log ORDER BY id DESC LIMIT 20'),
  };
}

// --- Routes ---------------------------------------------------------------------------

const fhirJson = express.json({ type: ['application/json', 'application/fhir+json'], limit: '2mb' });

function responseBundle(incoming: unknown, code: 'ok' | 'fatal-error', text: string) {
  const header = (incoming as Json | null)?.entry?.[0]?.resource as Json | undefined;
  return {
    resourceType: 'Bundle',
    type: 'message',
    timestamp: now(),
    entry: [
      {
        fullUrl: 'urn:uuid:mmd-response-header',
        resource: {
          resourceType: 'MessageHeader',
          eventCoding: header?.eventCoding ?? { system: 'https://mmd.halsaplus.se/fhir/event', code: 'care-team-message' },
          source: { name: 'MMD', endpointUrl: getSettings().publicUrl ?? DEFAULT_PUBLIC_URL },
          response: { identifier: String(header?.id ?? 'unknown'), code },
          focus: [{ reference: 'urn:uuid:mmd-response-outcome' }],
        },
      },
      {
        fullUrl: 'urn:uuid:mmd-response-outcome',
        resource: { resourceType: 'OperationOutcome', issue: [{ severity: code === 'ok' ? 'information' : 'error', code: code === 'ok' ? 'informational' : 'processing', diagnostics: text }] },
      },
    ],
  };
}

/**
 * Push mode: the care team POSTs a FHIR message Bundle with X-Push-Secret.
 * Public (no admin login), so it must be registered before setupAuth().
 */
export function setupCareTeamInbound(app: Express) {
  app.post('/api/v1/inbound/message', fhirJson, (req: Request, res: Response) => {
    const settings = getChannelSettings();
    const secret = req.get('X-Push-Secret') ?? '';
    if (!settings.enabled || settings.receiveMode !== 'push' || !settings.pushSecret) {
      log('in', 'rejected', 'push: the channel is not in push mode.');
      return res.status(404).json({ resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'not-found', diagnostics: 'Push is not on.' }] });
    }
    if (!secret || !safeEqual(secret, settings.pushSecret)) {
      log('in', 'rejected', `push: ${secret ? 'wrong' : 'missing'} X-Push-Secret.`);
      return res.status(401).json({ resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'security', diagnostics: 'Missing or wrong X-Push-Secret.' }] });
    }
    const result = receiveBundle(req.body, settings, 'push');
    const text = `Stored ${result.stored}, already had ${result.duplicates}, ignored ${result.ignored}, rejected ${result.rejected}.`;
    res.status(200).type('application/fhir+json').send(JSON.stringify(responseBundle(req.body, result.rejected && !result.stored ? 'fatal-error' : 'ok', text)));
  });
}

let timers: ReturnType<typeof setInterval>[] = [];

/** The admin console's and the app's routes (behind the login), and the outbox and poll timers. */
export function setupCareTeamChannel(app: Express, options: { timers?: boolean } = {}) {
  app.get('/api/careteam-channel', (_req, res) => {
    res.json({ settings: toChannelView(), ...recentActivity() });
  });

  app.put('/api/careteam-channel', fhirJson, (req, res) => {
    try {
      saveChannelSettings(req.body);
      res.json({ settings: toChannelView(), ...recentActivity() });
    } catch (error) {
      if (error instanceof ChannelError) return res.status(400).json({ error: error.message });
      console.error(error);
      res.status(500).json({ error: 'Something went wrong on the server.' });
    }
  });

  app.post('/api/careteam-channel/test', async (_req, res) => {
    const settings = getChannelSettings();
    if (!settings.endpointUrl) return res.status(400).json({ error: 'Enter the endpoint URL first.' });
    const result = await testConnection(settings);
    log('test', result.ok ? 'ok' : 'failed', `Test connection: ${result.message}`);
    res.json(result);
  });

  app.post('/api/careteam-channel/test-message', async (_req, res) => {
    const settings = getChannelSettings();
    if (!settings.endpointUrl) return res.status(400).json({ error: 'Enter the endpoint URL first.' });
    const message: ChatMessage = {
      id: 0,
      patientGuid: settings.patientGuid,
      sender: 'patient',
      text: 'Testmeddelande från MMD, syntetisk data',
      serviceRequestGuid: null,
      createdAt: now(),
    };
    const outcome = await sendOnce(message, settings);
    log('test', outcome.status, `Test message: ${outcome.detail}`);
    res.json({ ok: outcome.status === 'delivered', message: outcome.detail, remoteId: outcome.remoteId });
  });

  app.post('/api/careteam-channel/poll', async (_req, res) => {
    res.json(await pollOnce());
  });

  app.post('/api/careteam-channel/deliveries/:id/retry', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || !get('SELECT message_id FROM careteam_deliveries WHERE message_id = :id', { id })) {
      return res.status(404).json({ error: 'No delivery with that id.' });
    }
    run('UPDATE careteam_deliveries SET attempts = 0 WHERE message_id = :id', { id });
    res.json(await deliver(id));
  });

  // The patient app: statuses and sender names, and "fetch now" when the chat opens.
  app.get('/api/app/:patient/careteam', (req, res) => {
    res.json(chatStatus(String(req.params.patient)));
  });

  app.post('/api/app/:patient/careteam/poll', async (req, res) => {
    const settings = getChannelSettings();
    if (!settings.enabled || settings.patientGuid !== String(req.params.patient)) return res.json({ skipped: true });
    // The outbox has its own guard; a fetch from the care team is throttled (pollOnDemand).
    await sendPending(settings);
    res.json(settings.receiveMode === 'poll' ? await pollOnDemand(settings) : { skipped: true });
  });

  if (options.timers !== false) {
    for (const timer of timers) clearInterval(timer);
    timers = [
      setInterval(() => void sendPending().catch((e) => console.error('Care-team channel:', e instanceof Error ? e.message : e)), 2000),
      setInterval(() => void pollOnce().catch((e) => console.error('Care-team channel:', e instanceof Error ? e.message : e)), 30_000),
    ];
    for (const timer of timers) timer.unref?.();
  }
}
