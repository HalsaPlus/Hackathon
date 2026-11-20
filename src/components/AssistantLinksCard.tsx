import { type FormEvent, useCallback, useEffect, useState } from 'react';
import type { AssistantLinkView, NewAssistantLink } from '../../shared/types.ts';
import { api } from '../api.ts';
import { formatDateTime } from '../format.ts';

// Secret links that let an AI assistant (ChatGPT, Claude …) reach this one
// patient's data over MCP: the plan, values, today's tasks, health summary and
// chat, and send a message to the care team when the patient asks it to.
// A link is shown once; only a hash is kept. Synthetic data only.

export function AssistantLinksCard({ patientGuid }: { patientGuid: string }) {
  const [links, setLinks] = useState<AssistantLinkView[] | null>(null);
  const [label, setLabel] = useState('ChatGPT');
  const [created, setCreated] = useState<NewAssistantLink | null>(null);
  const [copied, setCopied] = useState<'url' | 'secret' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setLinks(await api.assistantLinks(patientGuid));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the links.');
    }
  }, [patientGuid]);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setCreated(await api.createAssistantLink(patientGuid, label));
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not make a link.');
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (link: AssistantLinkView) => {
    if (!window.confirm(`Revoke the link "${link.label}"? The assistant loses access at once.`)) return;
    try {
      await api.revokeAssistantLink(link.id);
      if (created?.id === link.id) setCreated(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not revoke the link.');
    }
  };

  const copy = async (what: 'url' | 'secret', value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(what);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      // Clipboard can be blocked; the value is visible anyway.
    }
  };

  const isLocal = created && /\/\/(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(created.url);

  return (
    <article className="card">
      <h2>AI assistants (MCP)</h2>
      <p>
        Lets the patient talk to an AI assistant such as ChatGPT about their plan and values, and ask it to write to the care
        team. The assistant only reaches MMD, never PDHC, and only this patient. Synthetic data only: what the patient
        writes goes to whoever runs the assistant.
      </p>

      {created && (
        <div className="notice" role="status">
          <p>
            <strong>New link for {created.label}.</strong> Shown only now. Add it in the assistant as an MCP server (in
            ChatGPT: Settings → Apps &amp; Connectors → Advanced → Developer mode → Create).
          </p>
          <div className="copy-row">
            <code className="copy-value">{created.url}</code>
            <button type="button" className="button subtle" onClick={() => void copy('url', created.url)}>
              {copied === 'url' ? 'Copied' : 'Copy link'}
            </button>
          </div>
          <p className="small">
            Choose no authentication with this link. If the assistant asks for an API key instead, use the address up to{' '}
            <code>/mcp</code> and this key:{' '}
            <button type="button" className="button subtle" onClick={() => void copy('secret', created.secret)}>
              {copied === 'secret' ? 'Copied' : 'Copy key'}
            </button>
          </p>
          {isLocal && (
            <p className="small">
              This address is on your own computer, so ChatGPT cannot reach it. Start a tunnel and set its address as
              &quot;This app&quot; under Connection → Other services, then make a new link.
            </p>
          )}
        </div>
      )}

      <form className="form" onSubmit={(e) => void create(e)}>
        <div className="field">
          <label htmlFor={`assistant-${patientGuid}`}>Assistant</label>
          <input
            id={`assistant-${patientGuid}`}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            maxLength={40}
            aria-describedby={`assistant-${patientGuid}-help`}
          />
          <p className="help" id={`assistant-${patientGuid}-help`}>
            Its name marks the messages written through it, e.g. &quot;via ChatGPT&quot;.
          </p>
        </div>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="actions">
          <button type="submit" className="button" disabled={busy}>
            {busy ? 'Making …' : 'Make a link'}
          </button>
        </div>
      </form>

      {links && links.length > 0 && (
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Assistant</th>
                <th scope="col">Made</th>
                <th scope="col">Last used</th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {links.map((link) => (
                <tr key={link.id}>
                  <td>{link.label}</td>
                  <td>{formatDateTime(link.createdAt)}</td>
                  <td>{link.lastUsedAt ? formatDateTime(link.lastUsedAt) : 'Not yet'}</td>
                  <td>
                    {link.revokedAt ? (
                      <span className="muted small">Revoked {formatDateTime(link.revokedAt)}</span>
                    ) : (
                      <button type="button" className="button subtle danger" onClick={() => void revoke(link)}>
                        Revoke
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </article>
  );
}
