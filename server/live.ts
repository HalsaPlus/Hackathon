import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Express } from 'express';
import { channelEvents, getChannelSettings, pollOnDemand, sendPending } from './careteam-channel.ts';
import { all } from './db.ts';
import { acceptUpgrade, type LiveSocket, rejectUpgrade } from './live-socket.ts';

// Live updates for the patient app over a WebSocket at /ws, so two browsers
// showing the same patient (the stage and the audience) stay in step within
// a second, without reloading.
//
// - Sign-in: the app first gets a one-time ticket from POST /api/live/ticket,
//   a route behind Casper's own login, then connects to /ws?ticket=…; so
//   Casper's session check decides who may connect.
// - The client subscribes to one patient: { type: 'subscribe', patientGuid }.
//   The server says what changed, never the data itself:
//   { type: 'changed', patientGuid, topics: ['messages', …] }; the client
//   refetches through the usual HTTP endpoints.
// - What changed is read from the database every 250 ms (a few cheap
//   aggregates per patient), so chat messages from the app, the admin page,
//   MCP and the care team, reports, stops, and requests from PDHC are all seen
//   without touching the code that writes them. Consent decisions (stored in
//   Hälsa+) are announced by our consent route with notifyChanged().
// - { type: 'chat-visible', value } from the clients: while any subscriber
//   of the channel's patient has the Chat screen open and visible, the care
//   team is asked every second (pollOnDemand: throttled, never overlapping,
//   backs off); otherwise only the 30-second background poll runs.
// - Mirror mode: { type: 'mirror', state } from the driver is passed on to the
//   other subscribers of the same patient (the follower on stage). There is
//   at most one driver per patient: { type: 'role', role: 'drive' } makes a
//   client the driver and the previous driver a follower (it is told with
//   { type: 'role', role: 'follow' }); 'follow' hands over. Everyone on the
//   patient hears { type: 'driver', present } so followers know whether to
//   ignore their own input.

export type Topic = 'messages' | 'delivery' | 'observations' | 'consent' | 'requests' | 'stops';

export const liveEvents = new EventEmitter();

interface Client {
  socket: LiveSocket;
  patientGuid: string | null;
  chatVisible: boolean;
  alive: boolean;
  /** Mirror mode: the driver of its patient, a follower, or neither. */
  role: 'drive' | 'follow' | null;
}

const clients = new Set<Client>();
const lastMirror = new Map<string, { state: unknown; at: number }>();

// --- One-time tickets --------------------------------------------------------------

const TICKET_MS = 60_000;
const tickets = new Map<string, number>();

export function issueTicket() {
  const now = Date.now();
  for (const [ticket, expires] of tickets) if (expires < now) tickets.delete(ticket);
  const ticket = randomBytes(24).toString('base64url');
  tickets.set(ticket, now + TICKET_MS);
  return ticket;
}

function useTicket(ticket: string) {
  const expires = tickets.get(ticket);
  tickets.delete(ticket);
  return expires !== undefined && expires > Date.now();
}

// --- Change events -----------------------------------------------------------------

const pending = new Map<string, Set<Topic>>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

/** Tells the patient's subscribers that something changed. Topics within 50 ms are sent together. */
export function notifyChanged(patientGuid: string, topics: Topic[]) {
  const set = pending.get(patientGuid) ?? new Set<Topic>();
  for (const topic of topics) set.add(topic);
  pending.set(patientGuid, set);
  flushTimer ??= setTimeout(flush, 50);
}

function flush() {
  flushTimer = null;
  for (const [patientGuid, topics] of pending) {
    const event = { type: 'changed', patientGuid, topics: [...topics].sort() };
    const text = JSON.stringify(event);
    for (const client of clients) if (client.patientGuid === patientGuid) client.socket.send(text);
    liveEvents.emit('changed', event);
  }
  pending.clear();
}

// --- The change watcher -------------------------------------------------------------

const WATCHES: { topic: Topic; sql: string }[] = [
  { topic: 'messages', sql: 'SELECT patient_guid AS p, MAX(id) AS v FROM messages GROUP BY patient_guid' },
  {
    topic: 'observations',
    sql: `SELECT patient_guid AS p, COUNT(*) || ':' || MAX(id) || ':' || SUM(report_status = 'pending') || ':' || COALESCE(MAX(reported_at), '') AS v
          FROM observations GROUP BY patient_guid`,
  },
  {
    topic: 'stops',
    sql: `SELECT s.patient_guid AS p, COUNT(*) || ':' || MAX(pf.id) || ':' || MAX(pf.performed_at) AS v
          FROM performances pf JOIN service_requests s ON s.guid = pf.service_request_guid GROUP BY s.patient_guid`,
  },
  {
    topic: 'requests',
    sql: `SELECT patient_guid AS p, COUNT(*) || ':' || MAX(updated_at) || ':' || COALESCE(MAX(seen_at), '') || ':' ||
            COALESCE(GROUP_CONCAT(COALESCE(pdhc_status, '') || '/' || COALESCE(is_open, '')), '') AS v
          FROM service_requests GROUP BY patient_guid`,
  },
  {
    topic: 'delivery',
    sql: `SELECT m.patient_guid AS p, COUNT(*) || ':' || MAX(d.updated_at) || ':' || GROUP_CONCAT(d.status) AS v
          FROM careteam_deliveries d JOIN messages m ON m.id = d.message_id GROUP BY m.patient_guid`,
  },
];

const seen = new Map<string, string>();
let primed = false;

/** One look at the database: announces what changed since the last look. */
export function scanForChanges() {
  const changed = new Map<string, Topic[]>();
  for (const { topic, sql } of WATCHES) {
    let rows: { p: string; v: string | number | null }[];
    try {
      rows = all(sql);
    } catch {
      continue; // e.g. a column not there yet in an older database
    }
    for (const row of rows) {
      const key = `${topic}|${row.p}`;
      const value = String(row.v);
      if (seen.get(key) !== value) {
        if (primed) changed.set(row.p, [...(changed.get(row.p) ?? []), topic]);
        seen.set(key, value);
      }
    }
  }
  primed = true;
  for (const [patientGuid, topics] of changed) {
    notifyChanged(patientGuid, topics);
    // Her message goes to the care team at once, not on the next outbox tick.
    if (topics.includes('messages')) {
      const settings = getChannelSettings();
      if (settings.enabled && settings.patientGuid === patientGuid) void sendPending(settings).catch(() => undefined);
    }
  }
  return changed;
}

/** While anyone has the channel patient's chat open and visible: ask the care team (throttled). */
export function fastPollTick() {
  const settings = getChannelSettings();
  if (!settings.enabled || settings.receiveMode !== 'poll') return false;
  const watching = [...clients].some((c) => c.chatVisible && c.patientGuid === settings.patientGuid);
  if (watching) void pollOnDemand(settings).catch(() => undefined);
  return watching;
}

// --- Sockets -------------------------------------------------------------------------

function onMessage(client: Client, text: string) {
  let message: Record<string, unknown>;
  try {
    message = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return;
  }
  if (message.type === 'subscribe' && typeof message.patientGuid === 'string' && message.patientGuid.length <= 100) {
    client.patientGuid = message.patientGuid;
    client.chatVisible = false;
    client.role = null;
    client.socket.send(JSON.stringify({ type: 'subscribed', patientGuid: client.patientGuid }));
    const driving = [...clients].some((c) => c !== client && c.patientGuid === client.patientGuid && c.role === 'drive');
    client.socket.send(JSON.stringify({ type: 'driver', patientGuid: client.patientGuid, present: driving }));
    const mirror = lastMirror.get(client.patientGuid);
    if (mirror && Date.now() - mirror.at < 10_000) client.socket.send(JSON.stringify({ type: 'mirror', patientGuid: client.patientGuid, state: mirror.state }));
    return;
  }
  if (message.type === 'chat-visible') {
    client.chatVisible = message.value === true;
    liveEvents.emit('chat-visible', { patientGuid: client.patientGuid, value: client.chatVisible });
    if (client.chatVisible) fastPollTick();
    return;
  }
  if (message.type === 'role' && client.patientGuid && (message.role === 'drive' || message.role === 'follow')) {
    setRole(client, message.role);
    return;
  }
  if (message.type === 'mirror' && client.patientGuid && client.role === 'drive' && message.state && typeof message.state === 'object') {
    lastMirror.set(client.patientGuid, { state: message.state, at: Date.now() });
    const out = JSON.stringify({ type: 'mirror', patientGuid: client.patientGuid, state: message.state });
    for (const other of clients) if (other !== client && other.patientGuid === client.patientGuid) other.socket.send(out);
  }
}

/** One driver per patient: taking control makes the previous driver a follower. */
function setRole(client: Client, role: 'drive' | 'follow') {
  const patientGuid = client.patientGuid!;
  if (role === 'drive') {
    for (const other of clients) {
      if (other !== client && other.patientGuid === patientGuid && other.role === 'drive') {
        other.role = 'follow';
        other.socket.send(JSON.stringify({ type: 'role', patientGuid, role: 'follow' }));
      }
    }
  }
  client.role = role;
  client.socket.send(JSON.stringify({ type: 'role', patientGuid, role }));
  announceDriver(patientGuid);
}

function announceDriver(patientGuid: string) {
  const present = [...clients].some((c) => c.patientGuid === patientGuid && c.role === 'drive');
  const text = JSON.stringify({ type: 'driver', patientGuid, present });
  for (const c of clients) if (c.patientGuid === patientGuid) c.socket.send(text);
  liveEvents.emit('driver', { patientGuid, present });
}

export interface LiveOptions {
  /** Tests: decide sign-in without a ticket. */
  authenticate?: (req: IncomingMessage) => boolean;
  watchMs?: number;
  fastPollMs?: number;
  timers?: boolean;
}

let timers: ReturnType<typeof setInterval>[] = [];

/**
 * Registers POST /api/live/ticket (call after setupAuth: Casper's login
 * guards it) and the WebSocket endpoint /ws on the HTTP server.
 */
// A mirror of the care team's system that changed the chat (also deletions and edits).
channelEvents.on('changed', (patientGuid: string) => notifyChanged(patientGuid, ['messages', 'delivery']));

export function setupLive(server: Server, app: Express, options: LiveOptions = {}) {
  app.post('/api/live/ticket', (_req, res) => {
    res.set('Cache-Control', 'no-store').json({ ticket: issueTicket() });
  });

  server.on('upgrade', (req: IncomingMessage, socket: Duplex) => {
    const url = new URL(req.url ?? '/', 'http://local');
    if (url.pathname !== '/ws') return; // other upgrades (Vite's hot reload) are not ours
    const allowed = options.authenticate ? options.authenticate(req) : useTicket(url.searchParams.get('ticket') ?? '');
    if (!allowed) return rejectUpgrade(socket, 401, 'Unauthorized');
    const live = acceptUpgrade(req, socket);
    if (!live) return;
    const client: Client = { socket: live, patientGuid: null, chatVisible: false, alive: true, role: null };
    clients.add(client);
    live.on('message', (text: string) => onMessage(client, text));
    live.on('pong', () => (client.alive = true));
    live.on('close', () => {
      clients.delete(client);
      if (client.role === 'drive' && client.patientGuid) announceDriver(client.patientGuid);
    });
  });

  if (options.timers !== false) {
    for (const timer of timers) clearInterval(timer);
    scanForChanges();
    timers = [
      setInterval(() => {
        try {
          scanForChanges();
        } catch (error) {
          console.error('Live updates:', error instanceof Error ? error.message : error);
        }
      }, options.watchMs ?? 250),
      setInterval(fastPollTick, options.fastPollMs ?? 1000),
      // Keep connections alive through proxies, and drop dead ones.
      setInterval(() => {
        for (const client of clients) {
          if (!client.alive) {
            client.socket.close(1001);
            clients.delete(client);
            continue;
          }
          client.alive = false;
          client.socket.ping();
        }
      }, 25_000),
    ];
    for (const timer of timers) timer.unref?.();
  }
}

/** For tests. */
export function liveClientCount() {
  return clients.size;
}

/** For tests: drops every connection, as a restart or a network glitch would. */
export function dropAllLiveClients() {
  for (const client of clients) client.socket.close(1012);
  clients.clear();
}
