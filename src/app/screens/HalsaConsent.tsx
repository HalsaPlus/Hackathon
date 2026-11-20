import { useState } from 'react';
import type { ServiceRequestView } from '../../../shared/types.ts';
import { requestedData, useHalsaConsent } from '../halsa.ts';
import { ShieldIcon } from '../icons.tsx';
import { formatClock, formatShort } from '../model.ts';

// The consent card on the "New plan" screen, for a patient linked to Hälsa+:
// who asks, for which data, for which period, and her decision. The decision
// is stored in Hälsa+'s append-only consent log; the latest one applies, and
// nothing is sent to the care team without "Share my values" (the server
// checks it too). Patients without a link get no card.

const when = (time: string) => `${formatShort(time)}, ${formatClock(time)}`;

export function HalsaConsentCard({ patientGuid, request }: { patientGuid: string; request: ServiceRequestView }) {
  const consent = useHalsaConsent(patientGuid, request.guid);
  const [changing, setChanging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (consent.status === 'idle' || consent.status === 'unlinked' || consent.status === 'loading') return null;

  const decision = consent.status === 'ready' ? consent.data : null;
  const plans = request.carePlans.map((p) => p.title).filter(Boolean).join(', ') || request.title || 'your plan';
  const data = requestedData(request);

  const decide = async (choice: 'accept' | 'decline') => {
    setBusy(true);
    setError(null);
    const failed = await consent.decide(choice);
    setBusy(false);
    if (failed) setError(failed);
    else setChanging(false);
  };

  const decided = decision?.decision && decision.decidedAt && !changing;

  return (
    <section
      id="consent"
      className="card"
      aria-labelledby="consent-title"
      style={{ display: 'flex', flexDirection: 'column', gap: 10, borderColor: decision?.decision === 'accept' ? 'rgba(3,212,209,.55)' : 'rgba(255,162,42,.6)' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <ShieldIcon />
        <h2 id="consent-title" style={{ fontSize: 17 }}>
          Share your values with the care team?
        </h2>
      </div>
      <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 12px' }}>
        <dt className="muted small">Who asks</dt>
        <dd style={{ margin: 0 }}>Your care team, through PDHC · {plans}</dd>
        <dt className="muted small">Which data</dt>
        <dd style={{ margin: 0 }}>{data.length ? data.join(', ') : 'What you mark as done'}</dd>
        <dt className="muted small">Period</dt>
        <dd style={{ margin: 0 }}>
          {formatShort(request.periodStart)} – {formatShort(request.periodEnd)}
        </dd>
      </dl>
      <p className="muted small" style={{ margin: 0 }}>
        Your values are sent only when you press Send on a stop. You can change your mind at any time.
      </p>

      {consent.status === 'error' && (
        <p className="error" role="alert" style={{ margin: 0 }}>
          Your decision could not be read from Hälsa+: {consent.message}
        </p>
      )}

      {decided ? (
        <p role="status" style={{ margin: 0, fontWeight: 600 }}>
          {decision.decision === 'accept' ? `You agreed on ${when(decision.decidedAt!)}` : `You said not now on ${when(decision.decidedAt!)}`}
          {' · '}
          <button type="button" className="link" onClick={() => setChanging(true)} style={{ background: 'none', border: 0, padding: 0, color: 'var(--cyan)', font: 'inherit', fontWeight: 700, cursor: 'pointer' }}>
            Change
          </button>
        </p>
      ) : (
        consent.status === 'ready' && (
          <div style={{ display: 'flex', gap: 10 }}>
            <button type="button" className="btn" style={{ flex: 1 }} onClick={() => void decide('accept')} disabled={busy}>
              Share my values
            </button>
            <button type="button" className="btn ghost" style={{ flex: 1 }} onClick={() => void decide('decline')} disabled={busy}>
              Not now
            </button>
          </div>
        )
      )}
      {error && (
        <p className="error" role="alert" style={{ margin: 0 }}>
          {error}
        </p>
      )}
    </section>
  );
}
