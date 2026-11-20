import { useEffect } from 'react';
import { startMirror } from './mirror.ts';

// Live updates in the patient app (server/live.ts): one WebSocket per page,
// subscribed to the patient on screen. When the server says something
// changed, the app refetches through its usual HTTP calls: Casper's refresh()
// for the plan, chat and values, and our own loaders (care-team status,
// consent, Hälsa+) through onLiveChange(). Reconnects with backoff; when
// WebSockets do not work, the app simply behaves as before.

export type LiveMessage =
  | { type: 'changed'; patientGuid: string; topics: string[] }
  | { type: 'mirror'; patientGuid: string; state: Record<string, unknown> }
  | { type: 'subscribed'; patientGuid: string };

export interface LiveSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
}

export interface LiveClientDeps {
  getTicket: () => Promise<string | null>;
  openSocket: (ticket: string) => LiveSocketLike;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/** 0.5 s, 1 s, 2 s, … up to 30 s between attempts. */
export const backoffMs = (attempt: number) => Math.min(30_000, 500 * 2 ** attempt);

/** The connection: subscribe, report chat visibility, pass messages on, reconnect. */
export function createLiveClient(deps: LiveClientDeps) {
  const setTimer = deps.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
  const clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const listeners = new Set<(message: LiveMessage) => void>();
  let socket: LiveSocketLike | null = null;
  let patientGuid: string | null = null;
  let chatVisible = false;
  let attempt = 0;
  let retry: unknown = null;
  let stopped = true;
  let connected = false;

  const send = (message: unknown) => {
    if (socket && connected) socket.send(JSON.stringify(message));
  };

  const schedule = () => {
    if (stopped || retry !== null) return;
    retry = setTimer(() => {
      retry = null;
      void connect();
    }, backoffMs(attempt++));
  };

  async function connect() {
    if (stopped) return;
    let ticket: string | null = null;
    try {
      ticket = await deps.getTicket();
    } catch {
      ticket = null;
    }
    if (stopped) return;
    if (!ticket) return schedule();
    let next: LiveSocketLike;
    try {
      next = deps.openSocket(ticket);
    } catch {
      return schedule();
    }
    socket = next;
    next.onopen = () => {
      connected = true;
      attempt = 0;
      if (patientGuid) next.send(JSON.stringify({ type: 'subscribe', patientGuid }));
      if (chatVisible) next.send(JSON.stringify({ type: 'chat-visible', value: true }));
    };
    next.onmessage = (event) => {
      let message: LiveMessage;
      try {
        message = JSON.parse(String(event.data)) as LiveMessage;
      } catch {
        return;
      }
      if ('patientGuid' in message && message.patientGuid !== patientGuid) return;
      for (const listener of listeners) listener(message);
    };
    next.onclose = () => {
      const wasCurrent = socket === next;
      connected = false;
      if (wasCurrent) socket = null;
      if (wasCurrent) schedule();
    };
  }

  return {
    start(patient: string) {
      if (!stopped && patient === patientGuid) return;
      patientGuid = patient;
      if (!stopped && connected) return send({ type: 'subscribe', patientGuid });
      stopped = false;
      void connect();
    },
    stop() {
      stopped = true;
      if (retry !== null) clearTimer(retry);
      retry = null;
      connected = false;
      socket?.close();
      socket = null;
    },
    setChatVisible(value: boolean) {
      if (chatVisible === value) return;
      chatVisible = value;
      send({ type: 'chat-visible', value });
    },
    sendMirror(state: Record<string, unknown>) {
      send({ type: 'mirror', state });
    },
    onMessage(listener: (message: LiveMessage) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    isConnected: () => connected,
  };
}

// --- One connection per page ---------------------------------------------------------

let client: ReturnType<typeof createLiveClient> | null = null;

function liveClient() {
  client ??= createLiveClient({
    getTicket: async () => {
      const response = await fetch('/api/live/ticket', { method: 'POST', credentials: 'same-origin' });
      if (!response.ok) return null;
      return ((await response.json()) as { ticket?: string }).ticket ?? null;
    },
    openSocket: (ticket) =>
      new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?ticket=${encodeURIComponent(ticket)}`) as unknown as LiveSocketLike,
  });
  return client;
}

/** Whether live updates are on right now (then the server, not the page, polls the care team). */
export const liveConnected = () => client?.isConnected() ?? false;

/** The Chat screen is open and visible (or not); remembered and sent once connected. */
export const setLiveChatVisible = (value: boolean) => {
  if (typeof WebSocket !== 'undefined') liveClient().setChatVisible(value);
};

/** Calls back with the topics when something changed for the patient on screen. */
export function onLiveChange(callback: (topics: string[]) => void) {
  return liveClient().onMessage((message) => {
    if (message.type === 'changed') callback(message.topics);
  });
}

/** The patient app: live updates for the patient on screen, and mirror mode when asked for. */
export function useLiveSync(patientGuid: string | null, refresh: () => Promise<void>) {
  useEffect(() => {
    if (!patientGuid || typeof WebSocket === 'undefined') return;
    const live = liveClient();
    const offChange = live.onMessage((message) => {
      if (message.type === 'changed' && message.topics.some((t) => t !== 'consent' && t !== 'delivery')) void refresh();
    });
    const stopMirror = startMirror({
      sendState: (state) => live.sendMirror(state),
      onState: (callback) => live.onMessage((message) => message.type === 'mirror' && callback(message.state)),
    });
    live.start(patientGuid);
    return () => {
      offChange();
      stopMirror();
    };
  }, [patientGuid, refresh]);
}
