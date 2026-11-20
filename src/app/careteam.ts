import { useCallback, useEffect, useState } from 'react';
import type { MessageView } from '../../shared/types.ts';

// The care-team channel in the patient's chat (server/careteam-channel.ts).
// When the channel is on for this patient: a subtle delivery status under her
// own messages, the care team member's name on their replies, and, only while
// the Chat screen is open and the page is visible, a fetch from the care team
// every second followed by a reload of the chat (the server throttles the
// fetches). The hook is used only by the Chat screen, so leaving it stops the
// fetching; hiding the page pauses it until the page is visible again. When
// the channel is off, nothing here shows and nothing is fetched.

export const CHAT_POLL_MS = 1000;

export interface ChatPollerDeps {
  /** One round: fetch from the care team, then reload the chat. */
  tick: () => Promise<void>;
  isVisible: () => boolean;
  /** Calls back when visibility changes; returns the unsubscribe. */
  onVisibilityChange: (callback: () => void) => () => void;
  intervalMs?: number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/**
 * Runs `tick` right away and then a second after each round ends, only while
 * started and visible; never two rounds at once. Hidden: paused at once.
 * Visible again: a round right away. stop(): no more rounds.
 */
export function createChatPoller(deps: ChatPollerDeps) {
  const interval = deps.intervalMs ?? CHAT_POLL_MS;
  const setTimer = deps.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
  const clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  let running = false;
  let busy = false;
  let timer: unknown = null;
  let unsubscribe: (() => void) | null = null;

  const cancel = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  };
  const round = async () => {
    timer = null;
    if (!running || busy || !deps.isVisible()) return;
    busy = true;
    try {
      await deps.tick();
    } catch {
      // The next round tries again.
    } finally {
      busy = false;
    }
    if (running && deps.isVisible() && timer === null) timer = setTimer(() => void round(), interval);
  };

  return {
    start() {
      if (running) return;
      running = true;
      unsubscribe = deps.onVisibilityChange(() => {
        if (!deps.isVisible()) cancel();
        else if (timer === null && !busy) void round();
      });
      void round();
    },
    stop() {
      running = false;
      cancel();
      unsubscribe?.();
      unsubscribe = null;
    },
  };
}

interface ChannelState {
  enabled: boolean;
  deliveries: Record<number, { status: 'pending' | 'delivered' | 'failed'; final: boolean }>;
  senders: Record<number, string>;
}

const OFF: ChannelState = { enabled: false, deliveries: {}, senders: {} };

export function deliveryNote(state: ChannelState, message: Pick<MessageView, 'id' | 'sender'>): string {
  if (!state.enabled || message.sender !== 'patient') return '';
  const delivery = state.deliveries[message.id];
  if (!delivery) return '';
  if (delivery.status === 'delivered') return ' · Sent to care team';
  if (delivery.status === 'pending') return ' · Sending …';
  return delivery.final ? ' · Not delivered' : ' · Not delivered – will retry';
}

export function useCareTeamChannel(patientGuid: string, refresh: () => Promise<void>, messageCount: number) {
  const [state, setState] = useState<ChannelState>(OFF);
  const base = `/api/app/${encodeURIComponent(patientGuid)}/careteam`;

  const load = useCallback(async () => {
    try {
      const response = await fetch(base, { credentials: 'same-origin' });
      if (!response.ok) return false;
      const next = (await response.json()) as ChannelState;
      setState(next);
      return next.enabled;
    } catch {
      return false;
    }
  }, [base]);

  // While the Chat screen is open and visible: fetch from the care team every
  // second, then reload the chat. Unmounting (leaving the screen) stops it.
  useEffect(() => {
    let live = true;
    let poller: ReturnType<typeof createChatPoller> | null = null;
    void (async () => {
      if (!(await load()) || !live) return;
      poller = createChatPoller({
        tick: async () => {
          await fetch(`${base}/poll`, { method: 'POST', credentials: 'same-origin' });
          if (!live) return;
          await refresh();
          await load();
        },
        isVisible: () => document.visibilityState === 'visible',
        onVisibilityChange: (callback) => {
          document.addEventListener('visibilitychange', callback);
          return () => document.removeEventListener('visibilitychange', callback);
        },
      });
      poller.start();
    })();
    return () => {
      live = false;
      poller?.stop();
    };
  }, [base, load, refresh]);

  // After she sends a message, its status follows within a few seconds.
  useEffect(() => {
    if (!state.enabled) return;
    const timers = [2500, 6000].map((ms) => setTimeout(() => void load(), ms));
    return () => timers.forEach(clearTimeout);
  }, [messageCount, state.enabled, load]);

  return {
    /** " · Sent to care team" etc. under her own message; empty when the channel is off. */
    note: (message: Pick<MessageView, 'id' | 'sender'>) => deliveryNote(state, message),
    /** "Nurse Eva · " before a care team member's reply, when their system names them. */
    sender: (message: Pick<MessageView, 'id' | 'sender'>) => (message.sender === 'care-team' && state.senders[message.id] ? `${state.senders[message.id]} · ` : ''),
  };
}
