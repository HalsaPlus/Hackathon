import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { call } from '../api.ts';

// The care-team chat channel (server/careteam-channel.ts): where the patient's
// chat messages go as FHIR messages, and how the care team's replies come
// back (poll or push). Stored in the database; the token and the push secret
// are write-only and shown only as their last four characters.

interface ChannelView {
  enabled: boolean;
  endpointUrl: string | null;
  tokenHint: string | null;
  authHeader: string;
  sendPath: string;
  receiveMode: 'poll' | 'push' | 'off';
  pollPath: string;
  healthPath: string;
  pushSecretHint: string | null;
  patientGuid: string;
  patientAliases: string[];
  payloadFormat: 'r5' | 'r4';
  inboundUrl: string;
}

interface Activity {
  settings: ChannelView;
  deliveries: { message_id: number; status: string; detail: string | null; remote_id: string | null; attempts: number; updated_at: string; text: string }[];
  log: { at: string; direction: string; outcome: string; detail: string | null }[];
}

interface FormState {
  enabled: boolean;
  endpointUrl: string;
  token: string;
  removeToken: boolean;
  authHeader: string;
  sendPath: string;
  payloadFormat: 'r5' | 'r4';
  receiveMode: 'poll' | 'push' | 'off';
  pollPath: string;
  healthPath: string;
  pushSecret: string;
  removePushSecret: boolean;
  patientGuid: string;
  patientAliases: string;
}

const toForm = (v: ChannelView): FormState => ({
  enabled: v.enabled,
  endpointUrl: v.endpointUrl ?? '',
  token: '',
  removeToken: false,
  authHeader: v.authHeader,
  sendPath: v.sendPath,
  payloadFormat: v.payloadFormat,
  receiveMode: v.receiveMode,
  pollPath: v.pollPath,
  healthPath: v.healthPath,
  pushSecret: '',
  removePushSecret: false,
  patientGuid: v.patientGuid,
  patientAliases: v.patientAliases.join(', '),
});

const time = (iso: string) => new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' });

export function CareTeamChannelCard() {
  const [data, setData] = useState<Activity | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((f) => (f ? { ...f, [key]: value } : f));

  const load = useCallback(async (resetForm = false) => {
    try {
      const next = await call<Activity>('GET', '/api/careteam-channel');
      setData(next);
      if (resetForm) setForm(toForm(next.settings));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the channel.');
    }
  }, []);

  useEffect(() => {
    void load(true);
  }, [load]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!form) return;
    setBusy('save');
    setError(null);
    setResult(null);
    try {
      const next = await call<Activity>('PUT', '/api/careteam-channel', {
        enabled: form.enabled,
        endpointUrl: form.endpointUrl,
        token: form.removeToken ? null : form.token || undefined,
        authHeader: form.authHeader,
        sendPath: form.sendPath,
        payloadFormat: form.payloadFormat,
        receiveMode: form.receiveMode,
        pollPath: form.pollPath,
        healthPath: form.healthPath,
        pushSecret: form.removePushSecret ? null : form.pushSecret || undefined,
        patientGuid: form.patientGuid,
        patientAliases: form.patientAliases,
      });
      setData(next);
      setForm(toForm(next.settings));
      setResult('Saved.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.');
    } finally {
      setBusy(null);
    }
  };

  const action = async (name: string, url: string) => {
    setBusy(name);
    setError(null);
    setResult(null);
    try {
      const answer = await call<Record<string, unknown>>('POST', url);
      setResult(
        typeof answer.message === 'string'
          ? `${answer.ok ? 'OK' : 'Failed'}: ${answer.message}`
          : typeof answer.error === 'string'
            ? `Failed: ${answer.error}`
            : 'deleted' in answer
              ? `Mirrored ${answer.total} message(s): ${answer.inserted} new, ${answer.updated} changed, ${answer.deleted} removed, ${answer.matched} of hers came back.`
              : 'stored' in answer
              ? `Fetched: ${answer.stored} new, ${answer.duplicates} already here, ${answer.rejected} rejected.`
              : 'detail' in answer
                ? `${String(answer.status)}: ${String(answer.detail)}`
                : 'Done.',
      );
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'It failed.');
    } finally {
      setBusy(null);
    }
  };

  if (!data || !form) {
    return (
      <article className="card connection">
        <h2>Care-team chat channel</h2>
        {error ? <p className="error">{error}</p> : <p className="muted">Loading …</p>}
      </article>
    );
  }
  const v = data.settings;

  return (
    <article className="card connection">
      <header className="connection-header">
        <h2>Care-team chat channel</h2>
        <span className={v.enabled ? 'pill' : 'pill muted'}>{v.enabled ? `On · ${v.receiveMode}` : 'Off'}</span>
      </header>
      <p className="muted">
        The patient's chat messages go to the care team's system as FHIR messages (a Bundle of type message), and the care team's replies come back into
        the chat. For one patient (the demo: Andrea Lindqvist). Synthetic data only.
      </p>

      <form className="form" onSubmit={(e) => void save(e)}>
        <label className="check">
          <input type="checkbox" checked={form.enabled} onChange={(e) => set('enabled', e.target.checked)} />
          Channel on (only messages written from now on are sent)
        </label>
        <div className="field">
          <label htmlFor="ct-url">Endpoint URL (FHIR base)</label>
          <input id="ct-url" className="mono" value={form.endpointUrl} onChange={(e) => set('endpointUrl', e.target.value)} inputMode="url" spellCheck={false} placeholder="https://…/fhir" />
        </div>
        <div className="field">
          <label htmlFor="ct-token">Token</label>
          <input
            id="ct-token"
            type="password"
            value={form.token}
            onChange={(e) => set('token', e.target.value)}
            autoComplete="off"
            spellCheck={false}
            disabled={form.removeToken}
            placeholder={v.tokenHint ? `Saved (${v.tokenHint}). Fill in to replace.` : ''}
          />
          {v.tokenHint && (
            <label className="check">
              <input type="checkbox" checked={form.removeToken} onChange={(e) => set('removeToken', e.target.checked)} />
              Remove the token
            </label>
          )}
        </div>
        <div className="field">
          <label htmlFor="ct-auth">Auth header</label>
          <input id="ct-auth" className="mono" value={form.authHeader} onChange={(e) => set('authHeader', e.target.value)} spellCheck={false} />
          <p className="help">
            <code>Authorization: Bearer {'{token}'}</code> (default), or e.g. <code>X-Api-Key</code> for the token as is.
          </p>
        </div>
        <div className="field">
          <label htmlFor="ct-send">Send path</label>
          <input id="ct-send" className="mono" value={form.sendPath} onChange={(e) => set('sendPath', e.target.value)} spellCheck={false} />
          <p className="help">Relative to the endpoint URL, or a full URL. Default <code>$process-message</code>.</p>
        </div>
        <div className="field">
          <label htmlFor="ct-format">Message text in</label>
          <select id="ct-format" value={form.payloadFormat} onChange={(e) => set('payloadFormat', e.target.value as FormState['payloadFormat'])}>
            <option value="r5">FHIR R5: payload.contentCodeableConcept.text</option>
            <option value="r4">FHIR R4: payload.contentString</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="ct-mode">Replies from the care team</label>
          <select id="ct-mode" value={form.receiveMode} onChange={(e) => set('receiveMode', e.target.value as FormState['receiveMode'])}>
            <option value="poll">Poll: MMD fetches every 30 seconds</option>
            <option value="push">Push: the care team sends to MMD</option>
            <option value="off">Off: send only</option>
          </select>
        </div>
        {form.receiveMode === 'poll' && (
          <div className="field">
            <label htmlFor="ct-poll">Poll path</label>
            <input id="ct-poll" className="mono" value={form.pollPath} onChange={(e) => set('pollPath', e.target.value)} spellCheck={false} />
            <p className="help">
              <code>{'{patientGuid}'}</code> and <code>{'{since}'}</code> (the last reply seen) are filled in.
            </p>
          </div>
        )}
        {form.receiveMode === 'push' && (
          <div className="field">
            <label htmlFor="ct-push">Push secret</label>
            <input
              id="ct-push"
              type="password"
              value={form.pushSecret}
              onChange={(e) => set('pushSecret', e.target.value)}
              autoComplete="off"
              spellCheck={false}
              disabled={form.removePushSecret}
              placeholder={v.pushSecretHint ? `Saved (${v.pushSecretHint}). Fill in to replace.` : 'At least 16 characters'}
            />
            <p className="help">
              The care team sends a FHIR message Bundle to <code>{v.inboundUrl}</code> with this secret in <code>X-Push-Secret</code>.
            </p>
            {v.pushSecretHint && (
              <label className="check">
                <input type="checkbox" checked={form.removePushSecret} onChange={(e) => set('removePushSecret', e.target.checked)} />
                Remove the push secret
              </label>
            )}
          </div>
        )}
        <div className="field">
          <label htmlFor="ct-health">Test path</label>
          <input id="ct-health" className="mono" value={form.healthPath} onChange={(e) => set('healthPath', e.target.value)} spellCheck={false} />
        </div>
        <div className="field">
          <label htmlFor="ct-patient">Patient GUID</label>
          <input id="ct-patient" className="mono" value={form.patientGuid} onChange={(e) => set('patientGuid', e.target.value)} spellCheck={false} />
        </div>
        <div className="field">
          <label htmlFor="ct-aliases">Care team patient aliases</label>
          <input id="ct-aliases" className="mono" value={form.patientAliases} onChange={(e) => set('patientAliases', e.target.value)} spellCheck={false} />
          <p className="help">
            Comma-separated ids the care team's system uses for the same patient. A reply about one of these, or with no patient, is stored for the
            patient above; any other patient is rejected.
          </p>
        </div>
        <div className="actions">
          <button type="submit" className="button" disabled={!!busy}>
            {busy === 'save' ? 'Saving …' : 'Save'}
          </button>
          <button type="button" className="button subtle" disabled={!!busy || !v.endpointUrl} onClick={() => void action('test', '/api/careteam-channel/test')}>
            {busy === 'test' ? 'Testing …' : 'Test connection'}
          </button>
          <button type="button" className="button subtle" disabled={!!busy || !v.endpointUrl} onClick={() => void action('message', '/api/careteam-channel/test-message')}>
            {busy === 'message' ? 'Sending …' : 'Send test message'}
          </button>
          {v.enabled && v.receiveMode === 'poll' && (
            <button type="button" className="button subtle" disabled={!!busy} onClick={() => void action('poll', '/api/careteam-channel/poll')}>
              {busy === 'poll' ? 'Fetching …' : 'Fetch now'}
            </button>
          )}
        </div>
        {result && <p role="status">{result}</p>}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </form>

      {data.deliveries.length > 0 && (
        <>
          <h3>Sent to the care team</h3>
          <ol className="chat-log">
            {data.deliveries.map((d) => (
              <li key={d.message_id} className="chat-entry">
                <div className="small muted">
                  {time(d.updated_at)} · {d.status}
                  {d.remote_id ? ` · ${d.remote_id}` : ''}
                  {d.attempts > 1 ? ` · ${d.attempts} attempts` : ''}
                </div>
                <div>{d.text}</div>
                {d.status === 'failed' && (
                  <div className="small">
                    <span className="error">{d.detail}</span>{' '}
                    <button type="button" className="button subtle" disabled={!!busy} onClick={() => void action(`retry-${d.message_id}`, `/api/careteam-channel/deliveries/${d.message_id}/retry`)}>
                      Retry
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ol>
        </>
      )}
      {data.log.length > 0 && (
        <details>
          <summary>Log</summary>
          <ol className="chat-log">
            {data.log.map((l, i) => (
              <li key={i} className="small">
                <span className="muted">
                  {time(l.at)} · {l.direction} · {l.outcome}
                </span>{' '}
                {l.detail}
              </li>
            ))}
          </ol>
        </details>
      )}
    </article>
  );
}
