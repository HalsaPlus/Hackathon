import { useEffect, useState } from 'react';
import type { PatientSummary } from '../../shared/types.ts';
import { api } from '../api.ts';
import { formatDateTime } from '../format.ts';

export function PatientsPage() {
  const [patients, setPatients] = useState<PatientSummary[] | null>(null);
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

  return (
    <>
      <header className="page-header">
        <div>
          <h1>Patients</h1>
          <p className="lead">Patients with a care plan from PDHC. Choose a patient to see the plan as a metro map.</p>
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

      {patients === null ? (
        <p className="muted">Loading …</p>
      ) : patients.length === 0 ? (
        <div className="card empty-state">
          <h2>No requests yet</h2>
          <p>
            Requests arrive here when PDHC pushes them or when the app fetches them. Add a{' '}
            <a href="#/connection">connection</a> with URL and token, or create a demo request with synthetic data to see
            what it looks like.
          </p>
        </div>
      ) : (
        <ul className="patient-list">
          {patients.map((patient) => (
            <li key={patient.guid}>
              <a href={`#/patient/${patient.guid}`} className="card patient-row">
                <span className="patient-name">{patient.displayName ?? 'Patient without a name'}</span>
                <span className="muted">
                  {patient.latestRequestTitle ?? 'Request without a title'}
                  {patient.requestCount > 1 ? ` and ${patient.requestCount - 1} more` : ''}
                </span>
                <span className="muted small">Last changed {formatDateTime(patient.updatedAt)}</span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
