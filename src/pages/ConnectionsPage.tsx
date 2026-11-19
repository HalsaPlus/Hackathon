import { type FormEvent, useCallback, useEffect, useState } from 'react';
import type { ConnectionView, InboundLogEntry } from '../../shared/types.ts';
import { api, type ConnectionInput } from '../api.ts';
import { formatDateTime } from '../format.ts';

// Where the user puts in PDHC's URL and token, tests the connection and
// fetches ServiceRequests. Also shows the push address and what has arrived.

const OUTCOMES: Record<InboundLogEntry['outcome'], string> = {
  created: 'Ny',
  updated: 'Ändrad',
  unchanged: 'Oförändrad',
  rejected: 'Avvisad',
  error: 'Fel',
};
const CHANNELS: Record<InboundLogEntry['channel'], string> = { push: 'Push', poll: 'Hämtning', demo: 'Exempel' };

interface FormState {
  name: string;
  baseUrl: string;
  providerToken: string;
  pushSecret: string;
  removePushSecret: boolean;
  pollEnabled: boolean;
}

const EMPTY: FormState = {
  name: 'PDHC',
  baseUrl: 'https://request.pdhc.se/api/v1',
  providerToken: '',
  pushSecret: '',
  removePushSecret: false,
  pollEnabled: false,
};

function ConnectionForm({
  existing,
  onSaved,
  onCancel,
}: {
  existing: ConnectionView | null;
  onSaved: (connection: ConnectionView) => void;
  onCancel?: () => void;
}) {
  const [form, setForm] = useState<FormState>(
    existing ? { ...EMPTY, name: existing.name, baseUrl: existing.baseUrl, pollEnabled: existing.pollEnabled } : EMPTY,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((f) => ({ ...f, [key]: value }));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const input: ConnectionInput = {
      name: form.name,
      baseUrl: form.baseUrl,
      pollEnabled: form.pollEnabled,
      providerToken: form.providerToken || undefined,
      // Leave the secret alone unless the user typed a new one or removed it.
      pushSecret: form.removePushSecret ? null : form.pushSecret || undefined,
    };
    try {
      const saved = existing ? await api.updateConnection(existing.id, input) : await api.createConnection(input);
      setForm((f) => ({ ...f, providerToken: '', pushSecret: '', removePushSecret: false }));
      onSaved(saved);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Det gick inte att spara.');
    } finally {
      setBusy(false);
    }
  };

  const id = existing ? `c${existing.id}` : 'new';
  return (
    <form className="form" onSubmit={(e) => void submit(e)}>
      <div className="field">
        <label htmlFor={`${id}-name`}>Namn</label>
        <input id={`${id}-name`} value={form.name} onChange={(e) => set('name', e.target.value)} required maxLength={80} />
      </div>
      <div className="field">
        <label htmlFor={`${id}-url`}>URL</label>
        <input
          id={`${id}-url`}
          value={form.baseUrl}
          onChange={(e) => set('baseUrl', e.target.value)}
          required
          inputMode="url"
          spellCheck={false}
          aria-describedby={`${id}-url-help`}
        />
        <p className="help" id={`${id}-url-help`}>
          request.pdhc.se eller gateway.pdhc.se. <code>/api/v1</code> läggs till om det saknas.
        </p>
      </div>
      <div className="field">
        <label htmlFor={`${id}-token`}>Token (PAT)</label>
        <input
          id={`${id}-token`}
          type="password"
          value={form.providerToken}
          onChange={(e) => set('providerToken', e.target.value)}
          required={!existing}
          autoComplete="off"
          spellCheck={false}
          placeholder={existing ? `Sparad (${existing.tokenHint}). Fyll i för att byta.` : ''}
          aria-describedby={`${id}-token-help`}
        />
        <p className="help" id={`${id}-token-help`}>
          Provider Access Token från PDHC. Skickas i <code>X-Provider-Token</code> och visas aldrig igen efter att den sparats.
        </p>
      </div>
      <div className="field">
        <label htmlFor={`${id}-secret`}>Push-hemlighet (valfri)</label>
        <input
          id={`${id}-secret`}
          type="password"
          value={form.pushSecret}
          onChange={(e) => set('pushSecret', e.target.value)}
          autoComplete="off"
          spellCheck={false}
          disabled={form.removePushSecret}
          placeholder={existing?.hasPushSecret ? 'Sparad. Fyll i för att byta.' : ''}
          aria-describedby={`${id}-secret-help`}
        />
        <p className="help" id={`${id}-secret-help`}>
          Behövs bara för push. PDHC skickar den i <code>X-Push-Secret</code>, och appen tar bara emot pushar som har rätt
          hemlighet.
        </p>
        {existing?.hasPushSecret && (
          <label className="check">
            <input
              type="checkbox"
              checked={form.removePushSecret}
              onChange={(e) => set('removePushSecret', e.target.checked)}
            />
            Ta bort push-hemligheten
          </label>
        )}
      </div>
      <label className="check">
        <input type="checkbox" checked={form.pollEnabled} onChange={(e) => set('pollEnabled', e.target.checked)} />
        Hämta nya beställningar automatiskt varje minut
      </label>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="actions">
        <button type="submit" className="button" disabled={busy}>
          {busy ? 'Sparar …' : existing ? 'Spara ändringar' : 'Spara anslutning'}
        </button>
        {onCancel && (
          <button type="button" className="button subtle" onClick={onCancel}>
            Avbryt
          </button>
        )}
      </div>
    </form>
  );
}

function ConnectionCard({
  connection,
  onChange,
  onDeleted,
}: {
  connection: ConnectionView;
  onChange: (connection: ConnectionView) => void;
  onDeleted: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<'test' | 'sync' | 'delete' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (kind: 'test' | 'sync') => {
    setBusy(kind);
    setError(null);
    try {
      onChange(kind === 'test' ? await api.testConnection(connection.id) : await api.syncConnection(connection.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Något gick fel.');
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    if (!window.confirm(`Ta bort anslutningen "${connection.name}"? Beställningar som redan tagits emot ligger kvar.`)) return;
    setBusy('delete');
    try {
      await api.deleteConnection(connection.id);
      onDeleted();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Det gick inte att ta bort.');
      setBusy(null);
    }
  };

  return (
    <article className="card connection">
      <header className="connection-header">
        <h2>{connection.name}</h2>
        {connection.lastTestOk !== null && (
          <span className={`pill ${connection.lastTestOk ? 'ok' : 'bad'}`}>
            {connection.lastTestOk ? 'Fungerar' : 'Fungerar inte'}
          </span>
        )}
      </header>

      {editing ? (
        <ConnectionForm
          existing={connection}
          onSaved={(saved) => {
            onChange(saved);
            setEditing(false);
          }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <>
          <dl className="facts">
            <div>
              <dt>URL</dt>
              <dd className="mono">{connection.baseUrl}</dd>
            </div>
            <div>
              <dt>Token</dt>
              <dd className="mono">{connection.tokenHint}</dd>
            </div>
            <div>
              <dt>Push</dt>
              <dd>{connection.hasPushSecret ? 'Hemlighet sparad' : 'Ingen hemlighet, push tas inte emot'}</dd>
            </div>
            <div>
              <dt>Hämtning</dt>
              <dd>{connection.pollEnabled ? 'Automatiskt varje minut' : 'När du trycker på Hämta'}</dd>
            </div>
          </dl>

          <div className="results">
            <p>
              <strong>Senaste test:</strong>{' '}
              {connection.lastTestAt ? `${formatDateTime(connection.lastTestAt)}. ${connection.lastTestMessage}` : 'Inte testad ännu.'}
            </p>
            <p>
              <strong>Senaste hämtning:</strong>{' '}
              {connection.lastSyncAt ? `${formatDateTime(connection.lastSyncAt)}. ${connection.lastSyncMessage}` : 'Inte hämtat ännu.'}
            </p>
          </div>

          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}

          <div className="actions">
            <button type="button" className="button" onClick={() => void run('test')} disabled={busy !== null}>
              {busy === 'test' ? 'Testar …' : 'Testa anslutningen'}
            </button>
            <button type="button" className="button secondary" onClick={() => void run('sync')} disabled={busy !== null}>
              {busy === 'sync' ? 'Hämtar …' : 'Hämta beställningar'}
            </button>
            <button type="button" className="button subtle" onClick={() => setEditing(true)} disabled={busy !== null}>
              Ändra
            </button>
            <button type="button" className="button subtle danger" onClick={() => void remove()} disabled={busy !== null}>
              Ta bort
            </button>
          </div>
        </>
      )}
    </article>
  );
}

function InboundLog({ entries }: { entries: InboundLogEntry[] }) {
  if (entries.length === 0) return <p className="muted">Inget har kommit in ännu.</p>;
  return (
    <div className="table-scroll">
      <table className="table">
        <thead>
          <tr>
            <th scope="col">Tid</th>
            <th scope="col">Väg</th>
            <th scope="col">Utfall</th>
            <th scope="col">Beställning</th>
            <th scope="col">Meddelande</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <tr key={entry.id}>
              <td>{formatDateTime(entry.receivedAt)}</td>
              <td>
                {CHANNELS[entry.channel]}
                {entry.connectionName ? `, ${entry.connectionName}` : ''}
              </td>
              <td>
                <span className={`pill outcome-${entry.outcome}`}>{OUTCOMES[entry.outcome]}</span>
              </td>
              <td className="mono small">{entry.serviceRequestGuid ?? '–'}</td>
              <td>{entry.message ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ConnectionsPage() {
  const [connections, setConnections] = useState<ConnectionView[] | null>(null);
  const [log, setLog] = useState<InboundLogEntry[]>([]);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const pushUrl = `${window.location.origin}/api/v1/inbound/push`;
  const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname);

  const load = useCallback(async () => {
    try {
      const [list, entries] = await Promise.all([api.connections(), api.inboundLog()]);
      setConnections(list);
      setLog(entries);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Det gick inte att hämta anslutningarna.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(pushUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard can be blocked; the address is visible anyway.
    }
  };

  return (
    <>
      <header className="page-header">
        <div>
          <h1>Anslutning till PDHC</h1>
          <p className="lead">
            Ange URL och token för att ta emot beställningar. PDHC levererar på två sätt: <strong>push</strong>, där PDHC
            skickar beställningen hit, och <strong>hämtning</strong>, där appen själv läser PDHC:s lista och laddar ner nya
            beställningar.
          </p>
        </div>
      </header>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {connections?.map((connection) => (
        <ConnectionCard
          key={connection.id}
          connection={connection}
          onChange={() => void load()}
          onDeleted={() => void load()}
        />
      ))}

      {connections !== null &&
        (adding || connections.length === 0 ? (
          <article className="card">
            <h2>Ny anslutning</h2>
            <ConnectionForm
              existing={null}
              onSaved={() => {
                setAdding(false);
                void load();
              }}
              onCancel={connections.length ? () => setAdding(false) : undefined}
            />
          </article>
        ) : (
          <button type="button" className="button subtle" onClick={() => setAdding(true)}>
            Lägg till en anslutning till
          </button>
        ))}

      <article className="card">
        <h2>Adress för push</h2>
        <p>Ge den här adressen och push-hemligheten till PDHC, så skickar PDHC nya beställningar direkt hit.</p>
        <div className="copy-row">
          <code className="copy-value">{pushUrl}</code>
          <button type="button" className="button subtle" onClick={() => void copy()}>
            {copied ? 'Kopierad' : 'Kopiera'}
          </button>
        </div>
        {isLocal && (
          <p className="notice">
            Appen körs på din egen dator, så PDHC kan inte nå adressen. Lokalt fungerar bara hämtning. Push kräver att appen
            ligger på en publik adress.
          </p>
        )}
      </article>

      <article className="card">
        <header className="connection-header">
          <h2>Det som kommit in</h2>
          <button type="button" className="button subtle" onClick={() => void load()}>
            Uppdatera
          </button>
        </header>
        <InboundLog entries={log} />
      </article>
    </>
  );
}
