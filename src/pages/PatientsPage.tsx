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
      setError(e instanceof Error ? e.message : 'Det gick inte att skapa exemplet.');
      setBusy(false);
    }
  };

  return (
    <>
      <header className="page-header">
        <div>
          <h1>Patienter</h1>
          <p className="lead">Patienter med en vårdplan från PDHC. Välj en patient för att se planen som en tunnelbanekarta.</p>
        </div>
        <button type="button" className="button secondary" onClick={() => void createDemo()} disabled={busy}>
          {busy ? 'Skapar …' : 'Skapa exempelbeställning'}
        </button>
      </header>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {patients === null ? (
        <p className="muted">Hämtar …</p>
      ) : patients.length === 0 ? (
        <div className="card empty-state">
          <h2>Inga beställningar ännu</h2>
          <p>
            Beställningar kommer hit när PDHC pushar dem eller när appen hämtar dem. Lägg upp en{' '}
            <a href="#/anslutning">anslutning</a> med URL och token, eller skapa en exempelbeställning med syntetiska data
            för att se hur det ser ut.
          </p>
        </div>
      ) : (
        <ul className="patient-list">
          {patients.map((patient) => (
            <li key={patient.guid}>
              <a href={`#/patient/${patient.guid}`} className="card patient-row">
                <span className="patient-name">{patient.displayName ?? 'Patient utan namn'}</span>
                <span className="muted">
                  {patient.latestRequestTitle ?? 'Beställning utan titel'}
                  {patient.requestCount > 1 ? ` och ${patient.requestCount - 1} till` : ''}
                </span>
                <span className="muted small">Senast ändrad {formatDateTime(patient.updatedAt)}</span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
