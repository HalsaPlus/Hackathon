import { type FormEvent, useEffect, useState } from 'react';
import type { ServiceSettingsView } from '../../shared/types.ts';
import { api, type ServiceSettingsInput } from '../api.ts';

// Health Connect, the CDR and this app's own address. Stored in the database
// like the PDHC connection; secrets are write-only and shown as a hint.

interface FormState {
  healthConnectUrl: string;
  healthConnectToken: string;
  removeHealthConnectToken: boolean;
  cdrUrl: string;
  cdrSourceService: string;
  cdrServiceKey: string;
  removeCdrServiceKey: boolean;
  publicUrl: string;
}

function toForm(view: ServiceSettingsView): FormState {
  return {
    healthConnectUrl: view.healthConnectUrl ?? '',
    healthConnectToken: '',
    removeHealthConnectToken: false,
    cdrUrl: view.cdrUrl ?? '',
    cdrSourceService: view.cdrSourceService ?? '',
    cdrServiceKey: '',
    removeCdrServiceKey: false,
    publicUrl: view.publicUrl ?? '',
  };
}

/** A secret is only sent when the user typed a new one or asked to remove it. */
const secret = (typed: string, remove: boolean) => (remove ? null : typed || undefined);

function SettingsForm({
  view,
  onSaved,
  onCancel,
}: {
  view: ServiceSettingsView;
  onSaved: (view: ServiceSettingsView) => void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState<FormState>(() => toForm(view));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((f) => ({ ...f, [key]: value }));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const input: ServiceSettingsInput = {
      healthConnectUrl: form.healthConnectUrl,
      healthConnectToken: secret(form.healthConnectToken, form.removeHealthConnectToken),
      cdrUrl: form.cdrUrl,
      cdrSourceService: form.cdrSourceService,
      cdrServiceKey: secret(form.cdrServiceKey, form.removeCdrServiceKey),
      publicUrl: form.publicUrl,
    };
    try {
      onSaved(await api.saveSettings(input));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="form" onSubmit={(e) => void submit(e)}>
      <h3>Health Connect</h3>
      <div className="field">
        <label htmlFor="hc-url">URL</label>
        <input
          id="hc-url"
          value={form.healthConnectUrl}
          onChange={(e) => set('healthConnectUrl', e.target.value)}
          inputMode="url"
          spellCheck={false}
          aria-describedby="hc-url-help"
        />
        <p className="help" id="hc-url-help">
          FHIR base. The patient's IPS is fetched with <code>GET {'{url}'}/Patient/{'{id}'}/$summary</code>. Leave empty to show
          the synthetic IPS.
        </p>
      </div>
      <div className="field">
        <label htmlFor="hc-token">Token (optional)</label>
        <input
          id="hc-token"
          type="password"
          value={form.healthConnectToken}
          onChange={(e) => set('healthConnectToken', e.target.value)}
          autoComplete="off"
          spellCheck={false}
          disabled={form.removeHealthConnectToken}
          placeholder={view.healthConnectTokenHint ? `Saved (${view.healthConnectTokenHint}). Fill in to replace.` : ''}
          aria-describedby="hc-token-help"
        />
        <p className="help" id="hc-token-help">
          Sent as <code>Authorization: Bearer</code>.
        </p>
        {view.healthConnectTokenHint && (
          <label className="check">
            <input
              type="checkbox"
              checked={form.removeHealthConnectToken}
              onChange={(e) => set('removeHealthConnectToken', e.target.checked)}
            />
            Remove the token
          </label>
        )}
      </div>

      <h3>CDR</h3>
      <div className="field">
        <label htmlFor="cdr-url">URL</label>
        <input
          id="cdr-url"
          value={form.cdrUrl}
          onChange={(e) => set('cdrUrl', e.target.value)}
          inputMode="url"
          spellCheck={false}
          aria-describedby="cdr-url-help"
        />
        <p className="help" id="cdr-url-help">
          FHIR base. Each chat message is sent to <code>{'{url}'}/Bundle</code> as a FHIR message. Leave empty to keep the chat
          in MMD only.
        </p>
      </div>
      <div className="field">
        <label htmlFor="cdr-source">Source service (optional)</label>
        <input
          id="cdr-source"
          value={form.cdrSourceService}
          onChange={(e) => set('cdrSourceService', e.target.value)}
          spellCheck={false}
          aria-describedby="cdr-source-help"
        />
        <p className="help" id="cdr-source-help">
          Sent in <code>X-Source-Service</code>.
        </p>
      </div>
      <div className="field">
        <label htmlFor="cdr-key">Service key (optional)</label>
        <input
          id="cdr-key"
          type="password"
          value={form.cdrServiceKey}
          onChange={(e) => set('cdrServiceKey', e.target.value)}
          autoComplete="off"
          spellCheck={false}
          disabled={form.removeCdrServiceKey}
          placeholder={view.cdrServiceKeyHint ? `Saved (${view.cdrServiceKeyHint}). Fill in to replace.` : ''}
          aria-describedby="cdr-key-help"
        />
        <p className="help" id="cdr-key-help">
          Sent in <code>X-Service-Key</code>.
        </p>
        {view.cdrServiceKeyHint && (
          <label className="check">
            <input type="checkbox" checked={form.removeCdrServiceKey} onChange={(e) => set('removeCdrServiceKey', e.target.checked)} />
            Remove the service key
          </label>
        )}
      </div>

      <h3>This app</h3>
      <div className="field">
        <label htmlFor="public-url">Public address (optional)</label>
        <input
          id="public-url"
          value={form.publicUrl}
          onChange={(e) => set('publicUrl', e.target.value)}
          inputMode="url"
          spellCheck={false}
          aria-describedby="public-url-help"
        />
        <p className="help" id="public-url-help">
          Written as the sender in the FHIR messages MMD sends.
        </p>
      </div>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="actions">
        <button type="submit" className="button" disabled={busy}>
          {busy ? 'Saving …' : 'Save changes'}
        </button>
        <button type="button" className="button subtle" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

const notSet = <span className="muted">Not set</span>;

export function ServiceSettingsCard() {
  const [view, setView] = useState<ServiceSettingsView | null>(null);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.settings().then(setView, (e: unknown) => setError(e instanceof Error ? e.message : 'Could not load the settings.'));
  }, []);

  return (
    <article className="card connection">
      <header className="connection-header">
        <h2>Other services</h2>
      </header>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {view &&
        (editing ? (
          <SettingsForm
            view={view}
            onSaved={(saved) => {
              setView(saved);
              setEditing(false);
            }}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <>
            <dl className="facts">
              <div>
                <dt>Health Connect</dt>
                <dd className="mono">{view.healthConnectUrl ?? notSet}</dd>
              </div>
              <div>
                <dt>Health Connect token</dt>
                <dd className="mono">{view.healthConnectTokenHint ?? notSet}</dd>
              </div>
              <div>
                <dt>CDR</dt>
                <dd className="mono">{view.cdrUrl ?? notSet}</dd>
              </div>
              <div>
                <dt>CDR source service</dt>
                <dd className="mono">{view.cdrSourceService ?? notSet}</dd>
              </div>
              <div>
                <dt>CDR service key</dt>
                <dd className="mono">{view.cdrServiceKeyHint ?? notSet}</dd>
              </div>
              <div>
                <dt>This app's address</dt>
                <dd className="mono">{view.publicUrl ?? notSet}</dd>
              </div>
            </dl>
            <div className="actions">
              <button type="button" className="button subtle" onClick={() => setEditing(true)}>
                Edit
              </button>
            </div>
          </>
        ))}
    </article>
  );
}
