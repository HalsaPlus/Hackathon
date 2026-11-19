import { type FormEvent, useCallback, useEffect, useState } from 'react';
import type { MessageView } from '../../shared/types.ts';
import { api } from '../api.ts';
import { formatDateTime } from '../format.ts';

// The care team's side of the patient's chat: read what the patient wrote, in
// the app or through an AI assistant, and answer. Every message is also a FHIR
// Communication, sent to the CDR when one is set up.

const SENDERS: Record<MessageView['sender'], string> = { patient: 'Patient', 'care-team': 'Care team', system: 'MMD' };

export function PatientChatCard({ patientGuid }: { patientGuid: string }) {
  const [messages, setMessages] = useState<MessageView[] | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setMessages(await api.messages(patientGuid));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the chat.');
    }
  }, [patientGuid]);

  useEffect(() => {
    void load();
  }, [load]);

  const send = async (event: FormEvent) => {
    event.preventDefault();
    if (!text.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.replyToPatient(patientGuid, text.trim());
      setText('');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not send.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="card">
      <header className="connection-header">
        <h2>Chat with the patient</h2>
        <button type="button" className="button subtle" onClick={() => void load()}>
          Refresh
        </button>
      </header>
      {messages && messages.length === 0 && <p className="muted">No messages yet.</p>}
      {messages && messages.length > 0 && (
        <ol className="chat-log">
          {messages.slice(-30).map((m) => (
            <li key={m.id} className={`chat-entry from-${m.sender}`}>
              <div className="small muted">
                {SENDERS[m.sender]}
                {m.via && <span className="pill"> via {m.via}</span>} · {formatDateTime(m.createdAt)}
                {m.cdrStatus === 'stored' && ' · in the CDR'}
              </div>
              <div>{m.text}</div>
            </li>
          ))}
        </ol>
      )}
      <form className="form" onSubmit={(e) => void send(e)}>
        <div className="field">
          <label htmlFor={`reply-${patientGuid}`}>Answer as the care team</label>
          <textarea id={`reply-${patientGuid}`} rows={3} maxLength={2000} value={text} onChange={(e) => setText(e.target.value)} />
        </div>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="actions">
          <button type="submit" className="button" disabled={busy || !text.trim()}>
            {busy ? 'Sending …' : 'Send'}
          </button>
        </div>
      </form>
    </article>
  );
}
