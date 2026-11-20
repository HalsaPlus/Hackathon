import { useEffect, useRef, useState } from 'react';
import { call } from '../../api.ts';
import type { ScreenProps } from '../App.tsx';
import { useCareTeamChannel } from '../careteam.ts';
import { PlanIcon, SendIcon } from '../icons.tsx';
import { activeRequests, formatClock, formatShort, startOfDay } from '../model.ts';

// The chat with the care team. Every message is kept as a FHIR Communication
// and sent as a FHIR message, so the care team's control tower can use it.

export function ChatScreen({ view, patientGuid, refresh, today }: ScreenProps) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const plans = activeRequests(view).flatMap((r) => r.carePlans.map((p) => p.title)).filter(Boolean);
  const careTeam = useCareTeamChannel(patientGuid, refresh, view.messages.length);

  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [view.messages.length]);

  const send = async () => {
    const message = text.trim();
    if (!message) return;
    setSending(true);
    setError(null);
    try {
      await call('POST', `/api/app/${encodeURIComponent(patientGuid)}/messages`, { text: message });
      setText('');
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sending failed.');
    } finally {
      setSending(false);
    }
  };

  let lastDay = 0;
  return (
    <>
      <main className="screen" style={{ paddingBottom: 8 }}>
        <header style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span className="mark" style={{ width: 44, height: 44, background: 'var(--lavender)', color: 'var(--bg)' }} aria-hidden="true">
            <svg width="24" height="24" viewBox="0 0 24 24" className="icon">
              <circle cx="9" cy="8" r="3.2" />
              <path d="M3 19c.6-3.4 3-5.2 6-5.2s5.4 1.8 6 5.2" />
              <circle cx="17" cy="9" r="2.4" />
              <path d="M16.2 13.9c2.4.2 4.2 1.8 4.8 4.6" />
            </svg>
          </span>
          <div>
            <h1 style={{ fontSize: 21, lineHeight: '26px' }}>Care team</h1>
            <span className="muted small">{plans.length ? plans.join(', ') : 'Your care team'}</span>
          </div>
        </header>

        <div className="messages" aria-live="polite">
          {view.messages.map((m) => {
            const day = startOfDay(Date.parse(m.createdAt));
            const divider = day !== lastDay;
            lastDay = day;
            return (
              <div key={m.id} style={{ display: 'contents' }}>
                {divider && (
                  <div className="muted small" style={{ alignSelf: 'center', margin: '6px 0' }}>
                    {day === today ? 'Today' : formatShort(day)}
                  </div>
                )}
                {m.sender === 'system' ? (
                  <a
                    className="row"
                    href={m.serviceRequestGuid ? `#/new-plan/${encodeURIComponent(m.serviceRequestGuid)}` : '#/plan'}
                    style={{ color: 'inherit', borderColor: 'rgba(3,212,209,.55)' }}
                  >
                    <span className="mark" style={{ width: 40, height: 40, borderRadius: 12, background: 'rgba(3,212,209,.16)', color: 'var(--cyan)' }}>
                      <PlanIcon />
                    </span>
                    <span className="row-body">
                      <span className="row-title">{m.text}</span>
                      <span className="muted small">{formatClock(m.createdAt)}</span>
                    </span>
                    <span className="btn">Open</span>
                  </a>
                ) : (
                  <div className={`bubble ${m.sender === 'patient' ? 'me' : 'them'}`}>
                    {m.text}
                    <span className="bubble-time">
                      {careTeam.sender(m)}
                      {m.via ? `via ${m.via} · ` : ''}
                      {formatClock(m.createdAt)}
                      {careTeam.note(m)}
                    </span>
                  </div>
                )}
              </div>
            );
          })}
          <div ref={end} />
        </div>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </main>
      <div className="composer">
        <label htmlFor="chat-message" className="visually-hidden">
          Message to the care team
        </label>
        <input
          id="chat-message"
          className="field"
          placeholder="Write a message"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <button type="button" className="send" aria-label="Send" onClick={() => void send()} disabled={sending || !text.trim()}>
          <SendIcon />
        </button>
      </div>
    </>
  );
}
