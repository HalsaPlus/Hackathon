import { useEffect, useState } from 'react';
import type { PatientSummary } from '../../shared/types.ts';
import { api } from '../api.ts';
import { formatDateTime } from '../format.ts';

// The start page after sign-in: the patients on the left and, on the right,
// the patient app in a phone frame, so you see what the patient sees.

export function PatientsPage() {
  const [patients, setPatients] = useState<PatientSummary[] | null>(null);
  const [phoneGuid, setPhoneGuid] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.patients().then(setPatients, (e: Error) => setError(e.message));
  }, []);

  const createDemo = async () => {
    setBusy(true);
    setError(null);
    try {
      const view = await api.createDemo();
      window.location.hash = `#/patient/${view.patient.guid}`;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create the demo.');
      setBusy(false);
    }
  };

  const onPhone = patients?.find((p) => p.guid === phoneGuid) ?? patients?.[0] ?? null;
  const appUrl = onPhone ? `/app/?patient=${encodeURIComponent(onPhone.guid)}` : '/app/';
  const phoneName = onPhone?.displayName ?? 'the patient';

  return (
    <>
      <header className="page-header">
        <div>
          <h1>Patients</h1>
          <p className="lead">
            Patients with a care plan from PDHC. Choose a patient to see the plan as a metro map. The phone shows the
            patient app.
          </p>
        </div>
        <button type="button" className="button secondary" onClick={() => void createDemo()} disabled={busy}>
          {busy ? 'Creating …' : 'Create demo request'}
        </button>
      </header>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <div className="patients-layout">
        <section aria-label="Patients">
          {patients === null ? (
            <p className="muted">Loading …</p>
          ) : patients.length === 0 ? (
            <div className="card empty-state">
              <h2>No requests yet</h2>
              <p>
                Requests arrive here when PDHC pushes them or when the app fetches them. Add a{' '}
                <a href="#/connection">connection</a> with URL and token, or create a demo request with synthetic data
                to see what it looks like.
              </p>
            </div>
          ) : (
            <ul className="patient-list">
              {patients.map((patient) => {
                const isOnPhone = onPhone?.guid === patient.guid;
                return (
                  <li key={patient.guid} className={`card patient-row${isOnPhone ? ' is-on-phone' : ''}`}>
                    <a href={`#/patient/${patient.guid}`} className="patient-link">
                      <span className="patient-name">{patient.displayName ?? 'Patient without a name'}</span>
                      <span className="muted">
                        {patient.latestRequestTitle ?? 'Request without a title'}
                        {patient.requestCount > 1 ? ` and ${patient.requestCount - 1} more` : ''}
                      </span>
                      <span className="muted small">Last changed {formatDateTime(patient.updatedAt)}</span>
                    </a>
                    <button
                      type="button"
                      className="button subtle"
                      aria-pressed={isOnPhone}
                      onClick={() => setPhoneGuid(patient.guid)}
                    >
                      {isOnPhone ? 'On the phone' : 'Show on the phone'}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <aside className="phone-panel" aria-label="Patient app">
          <div className="phone-panel-header">
            <h2>Patient app</h2>
            <a href={appUrl}>Open full screen</a>
          </div>
          <div className="phone">
            <iframe key={appUrl} title={`Patient app for ${phoneName}`} src={appUrl} />
          </div>
          <p className="muted small phone-hint">
            What {phoneName} sees. On a phone, open <span className="mono">/app/</span> and add it to the home screen.
          </p>
        </aside>
      </div>
    </>
  );
}
