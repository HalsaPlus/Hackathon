import { useEffect, useState } from 'react';
import type { PatientSummary, PatientView } from '../../../shared/types.ts';
import { call } from '../../api.ts';
import { MmdMark } from '../icons.tsx';

// Demo only: choose whose app this is. A real patient sign-in is a later step.

export function PatientPicker({ onChoose, current }: { onChoose: (guid: string) => void; current: string | null }) {
  const [patients, setPatients] = useState<PatientSummary[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    call<PatientSummary[]>('GET', '/api/patients').then(setPatients, (e: Error) => setError(e.message));
  }, []);

  const createDemo = async () => {
    setBusy(true);
    setError(null);
    try {
      const view = await call<PatientView>('POST', '/api/demo');
      onChoose(view.patient.guid);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create the demo patient.');
      setBusy(false);
    }
  };

  return (
    <main className="screen">
      <span className="brand">
        <MmdMark />
        MMD
      </span>
      <div>
        <h1>Who is using the app?</h1>
        <p className="muted" style={{ margin: '4px 0 0' }}>
          In the demo you choose a patient here. Synthetic data only.
        </p>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {patients === null ? (
        <p className="muted">Loading …</p>
      ) : (
        <ul className="list">
          {patients.map((p) => (
            <li key={p.guid}>
              <button
                type="button"
                className="row"
                onClick={() => onChoose(p.guid)}
                style={{ width: '100%', textAlign: 'left', color: 'inherit', cursor: 'pointer', borderColor: p.guid === current ? 'var(--cyan)' : 'transparent' }}
              >
                <span className="avatar" aria-hidden="true">
                  {(p.displayName ?? '?').charAt(0)}
                </span>
                <span className="row-body">
                  <span className="row-title">{p.displayName ?? 'Patient without a name'}</span>
                  <span className="muted small">{p.latestRequestTitle ?? 'No plan yet'}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <button type="button" className="btn big" onClick={() => void createDemo()} disabled={busy} style={{ marginTop: 'auto' }}>
        {busy ? 'Creating …' : 'Create the demo patient Andrea'}
      </button>
    </main>
  );
}
