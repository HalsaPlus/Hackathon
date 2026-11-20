import { useCallback, useEffect, useState } from 'react';
import type { MessageView } from '../../shared/types.ts';

// The care-team channel in the patient's chat (server/careteam-channel.ts).
// When the channel is on for this patient: a subtle delivery status under her
// own messages, the care team member's name on their replies, a fetch from the
// care team when the chat opens, and a refresh every 5 seconds while it is
// open. When it is off, nothing here shows and nothing is fetched again.

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

  // On opening the chat: fetch from the care team, then keep the chat fresh.
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setInterval> | undefined;
    void (async () => {
      if (!(await load()) || !live) return;
      await fetch(`${base}/poll`, { method: 'POST', credentials: 'same-origin' }).catch(() => undefined);
      if (!live) return;
      await refresh();
      await load();
      timer = setInterval(() => {
        void refresh().then(load);
      }, 5_000);
    })();
    return () => {
      live = false;
      if (timer) clearInterval(timer);
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
