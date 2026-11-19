import { type FormEvent, useCallback, useEffect, useState } from 'react';
import type { ConnectionView, InboundLogEntry, TestReportResult } from '../../shared/types.ts';
import { api, type ConnectionInput } from '../api.ts';
import { ServiceSettingsCard } from '../components/ServiceSettingsCard.tsx';
import { formatDateTime } from '../format.ts';

// Where the user puts in PDHC's URL and token, tests the connection and
// fetches ServiceRequests. Also shows the push address and what has arrived.

const OUTCOMES: Record<InboundLogEntry['outcome'], string> = {
  created: 'New',
  updated: 'Changed',
  unchanged: 'Unchanged',
  rejected: 'Rejected',
  error: 'Error',
};
const CHANNELS: Record<InboundLogEntry['channel'], string> = { push: 'Push', poll: 'Fetch', demo: 'Demo' };

interface FormState {
  name: string;
  baseUrl: string;
  gatewayUrl: string;
  providerToken: string;
  pushSecret: string;
  removePushSecret: boolean;
  pollEnabled: boolean;
}

const EMPTY: FormState = {
  name: 'PDHC',
  baseUrl: 'https://request.pdhc.se/api/v1',
  gatewayUrl: 'https://gateway.pdhc.se/api/v1',
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
    existing
      ? { ...EMPTY, name: existing.name, baseUrl: existing.baseUrl, gatewayUrl: existing.gatewayUrl, pollEnabled: existing.pollEnabled }
      : EMPTY,
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
      gatewayUrl: form.gatewayUrl,
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
      setError(e instanceof Error ? e.message : 'Could not save.');
    } finally {
      setBusy(false);
    }
  };

  const id = existing ? `c${existing.id}` : 'new';
  return (
    <form className="form" onSubmit={(e) => void submit(e)}>
      <div className="field">
        <label htmlFor={`${id}-name`}>Name</label>
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
          request.pdhc.se or gateway.pdhc.se. <code>/api/v1</code> is added if missing.
        </p>
      </div>
      <div className="field">
        <label htmlFor={`${id}-gateway`}>Gateway URL (for reports)</label>
        <input
          id={`${id}-gateway`}
          value={form.gatewayUrl}
          onChange={(e) => set('gatewayUrl', e.target.value)}
          inputMode="url"
          spellCheck={false}
          aria-describedby={`${id}-gateway-help`}
        />
        <p className="help" id={`${id}-gateway-help`}>
          Measurements the patient reports go to gateway.pdhc, not to request.pdhc.
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
          placeholder={existing ? `Saved (${existing.tokenHint}). Fill in to replace.` : ''}
          aria-describedby={`${id}-token-help`}
        />
        <p className="help" id={`${id}-token-help`}>
          Provider Access Token from PDHC. Sent in <code>X-Provider-Token</code> and never shown again once saved.
        </p>
      </div>
      <div className="field">
        <label htmlFor={`${id}-secret`}>Push secret (optional)</label>
        <input
          id={`${id}-secret`}
          type="password"
          value={form.pushSecret}
          onChange={(e) => set('pushSecret', e.target.value)}
          autoComplete="off"
          spellCheck={false}
          disabled={form.removePushSecret}
          placeholder={existing?.hasPushSecret ? 'Saved. Fill in to replace.' : ''}
          aria-describedby={`${id}-secret-help`}
        />
        <p className="help" id={`${id}-secret-help`}>
          Only needed for push. PDHC sends it in <code>X-Push-Secret</code>, and the app only accepts pushes with the right
          secret.
        </p>
        {existing?.hasPushSecret && (
          <label className="check">
            <input
              type="checkbox"
              checked={form.removePushSecret}
              onChange={(e) => set('removePushSecret', e.target.checked)}
            />
            Remove the push secret
          </label>
        )}
      </div>
      <label className="check">
        <input type="checkbox" checked={form.pollEnabled} onChange={(e) => set('pollEnabled', e.target.checked)} />
        Fetch new requests automatically every minute
      </label>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="actions">
        <button type="submit" className="button" disabled={busy}>
          {busy ? 'Saving …' : existing ? 'Save changes' : 'Save connection'}
        </button>
        {onCancel && (
          <button type="button" className="button subtle" onClick={onCancel}>
            Cancel
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
  const [busy, setBusy] = useState<'test' | 'sync' | 'delete' | 'report' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testReport, setTestReport] = useState<TestReportResult[] | null>(null);
  const [onePerReport, setOnePerReport] = useState(true);

  const sendTestReport = async () => {
    const ok = window.confirm(
      `Send synthetic test observations to PDHC for every open request from "${connection.name}"?\n\n` +
        'One set of values per activity goes to gateway.pdhc as if the patient had reported it, marked as test data' +
        (onePerReport ? ', each value in a report of its own. ' : ', all values of an activity in one report. ') +
        "The values are also saved in MMD and mark the stop as done in the patient's app.",
    );
    if (!ok) return;
    setBusy('report');
    setError(null);
    try {
      setTestReport(await api.sendTestReport(connection.id, onePerReport));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sending the test observations failed.');
    } finally {
      setBusy(null);
    }
  };

  const run = async (kind: 'test' | 'sync') => {
    setBusy(kind);
    setError(null);
    try {
      onChange(kind === 'test' ? await api.testConnection(connection.id) : await api.syncConnection(connection.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    if (!window.confirm(`Remove the connection "${connection.name}"? Requests already received stay.`)) return;
    setBusy('delete');
    try {
      await api.deleteConnection(connection.id);
      onDeleted();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not remove it.');
      setBusy(null);
    }
  };

  return (
    <article className="card connection">
      <header className="connection-header">
        <h2>{connection.name}</h2>
        {connection.lastTestOk !== null && (
          <span className={`pill ${connection.lastTestOk ? 'ok' : 'bad'}`}>{connection.lastTestOk ? 'Working' : 'Not working'}</span>
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
              <dt>Reports go to</dt>
              <dd className="mono">{connection.gatewayUrl}</dd>
            </div>
            <div>
              <dt>Token</dt>
              <dd className="mono">{connection.tokenHint}</dd>
            </div>
            <div>
              <dt>Push</dt>
              <dd>{connection.hasPushSecret ? 'Secret saved' : 'No secret, pushes are not accepted'}</dd>
            </div>
            <div>
              <dt>Fetching</dt>
              <dd>{connection.pollEnabled ? 'Automatically every minute' : 'When you press Fetch'}</dd>
            </div>
          </dl>

          <div className="results">
            <p>
              <strong>Last test:</strong>{' '}
              {connection.lastTestAt ? `${formatDateTime(connection.lastTestAt)}. ${connection.lastTestMessage}` : 'Not tested yet.'}
            </p>
            <p>
              <strong>Last fetch:</strong>{' '}
              {connection.lastSyncAt ? `${formatDateTime(connection.lastSyncAt)}. ${connection.lastSyncMessage}` : 'Nothing fetched yet.'}
            </p>
          </div>

          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}

          <div className="actions">
            <button type="button" className="button" onClick={() => void run('test')} disabled={busy !== null}>
              {busy === 'test' ? 'Testing …' : 'Test the connection'}
            </button>
            <button type="button" className="button secondary" onClick={() => void run('sync')} disabled={busy !== null}>
              {busy === 'sync' ? 'Fetching …' : 'Fetch requests'}
            </button>
            <button type="button" className="button secondary" onClick={() => void sendTestReport()} disabled={busy !== null}>
              {busy === 'report' ? 'Sending …' : 'Send test observations'}
            </button>
            <button type="button" className="button subtle" onClick={() => setEditing(true)} disabled={busy !== null}>
              Edit
            </button>
            <button type="button" className="button subtle danger" onClick={() => void remove()} disabled={busy !== null}>
              Remove
            </button>
          </div>
          <label className="check">
            <input type="checkbox" checked={onePerReport} onChange={(e) => setOnePerReport(e.target.checked)} />
            Test observations: one value per report, each with its own time
          </label>

          {testReport && <TestReportTable results={testReport} />}
        </>
      )}
    </article>
  );
}

const REPORT_OUTCOMES: Record<TestReportResult['status'], { label: string; tone: string }> = {
  sent: { label: 'Sent', tone: 'ok' },
  demo: { label: 'Demo', tone: '' },
  pending: { label: 'Pending', tone: '' },
  failed: { label: 'Failed', tone: 'bad' },
  skipped: { label: 'Skipped', tone: '' },
};

/** Exactly what went to gateway.pdhc, to compare with what PDHC shows (no grant token or PAT). */
function forPdhc(results: TestReportResult[]) {
  return JSON.stringify(
    results
      .filter((r) => r.sent.length)
      .map((r) => ({
        service_request_guid: r.serviceRequestGuid,
        activity: r.activity,
        reports: r.sent.map((s) => ({ receipt_guid: s.receiptGuid, observations_stored: s.stored, answer: s.message, observations: s.observations })),
      })),
    null,
    2,
  );
}

/** What the test button sent, per request and activity, and what PDHC answered. */
function TestReportTable({ results }: { results: TestReportResult[] }) {
  const [copied, setCopied] = useState(false);
  if (results.length === 0) {
    return <p className="notice">No open requests from this connection, so nothing was sent.</p>;
  }
  const sent = results.filter((r) => r.status === 'sent').length;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(forPdhc(results));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard can be blocked; the table shows the same.
    }
  };
  /** The call a value went in, found by its transaction GUID. */
  const callFor = (r: TestReportResult, transactionGuid: string | null) =>
    r.sent.find((s) => s.observations.some((o) => o.transaction_guid === transactionGuid));
  return (
    <section className="test-report" aria-label="Test observations sent">
      <header className="connection-header">
        <h3>
          Test observations: {sent} of {results.length} {results.length === 1 ? 'activity' : 'activities'} sent
        </h3>
        <button type="button" className="button subtle" onClick={() => void copy()}>
          {copied ? 'Copied' : 'Copy what was sent'}
        </button>
      </header>
      <div className="table-scroll">
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Request</th>
              <th scope="col">Activity</th>
              <th scope="col">Values</th>
              <th scope="col">PDHC</th>
            </tr>
          </thead>
          <tbody>
            {results.map((r, i) => (
              <tr key={`${r.serviceRequestGuid}-${i}`}>
                <td>
                  {r.patientName ?? 'Patient'} · {r.planTitle ?? 'Plan'}
                  <br />
                  <span className="mono small">{r.serviceRequestGuid}</span>
                </td>
                <td>
                  {r.activity}
                  {r.stopIndex !== null && r.stopDueAt && (
                    <>
                      <br />
                      <span className="small muted">
                        Stop {r.stopIndex + 1}, {formatDateTime(r.stopDueAt)}
                      </span>
                    </>
                  )}
                </td>
                <td>
                  {r.values.length === 0
                    ? '–'
                    : r.values.map((v) => {
                        const call = callFor(r, v.transactionGuid);
                        return (
                          <div key={v.name}>
                            {v.name}: <strong>{v.value}</strong> {v.unit ?? ''}
                            {v.transactionGuid && <span className="mono small muted"> tx {v.transactionGuid.slice(0, 8)}…</span>}
                            {call?.receiptGuid && <span className="mono small muted"> · receipt {call.receiptGuid.slice(0, 8)}…</span>}
                          </div>
                        );
                      })}
                </td>
                <td>
                  <span className={`pill ${REPORT_OUTCOMES[r.status].tone}`}>{REPORT_OUTCOMES[r.status].label}</span>
                  <div className="small">{r.message}</div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function InboundLog({ entries }: { entries: InboundLogEntry[] }) {
  if (entries.length === 0) return <p className="muted">Nothing has arrived yet.</p>;
  return (
    <div className="table-scroll">
      <table className="table">
        <thead>
          <tr>
            <th scope="col">Time</th>
            <th scope="col">Channel</th>
            <th scope="col">Outcome</th>
            <th scope="col">Request</th>
            <th scope="col">Message</th>
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
      setError(e instanceof Error ? e.message : 'Could not load the connections.');
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
          <h1>Connection to PDHC</h1>
          <p className="lead">
            Enter URL and token to receive requests. PDHC delivers in two ways: <strong>push</strong>, where PDHC sends the
            request here, and <strong>fetch</strong>, where the app reads PDHC's list itself and downloads new requests.
          </p>
        </div>
      </header>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {connections?.map((connection) => (
        <ConnectionCard key={connection.id} connection={connection} onChange={() => void load()} onDeleted={() => void load()} />
      ))}

      {connections !== null &&
        (adding || connections.length === 0 ? (
          <article className="card">
            <h2>New connection</h2>
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
            Add another connection
          </button>
        ))}

      <ServiceSettingsCard />

      <article className="card">
        <h2>Push address</h2>
        <p>Give this address and the push secret to PDHC, and PDHC sends new requests straight here.</p>
        <div className="copy-row">
          <code className="copy-value">{pushUrl}</code>
          <button type="button" className="button subtle" onClick={() => void copy()}>
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
        {isLocal && (
          <p className="notice">
            The app runs on your own computer, so PDHC cannot reach this address. Locally only fetching works. Push needs
            the app on a public address.
          </p>
        )}
      </article>

      <article className="card">
        <header className="connection-header">
          <h2>What has arrived</h2>
          <button type="button" className="button subtle" onClick={() => void load()}>
            Refresh
          </button>
        </header>
        <InboundLog entries={log} />
      </article>
    </>
  );
}
