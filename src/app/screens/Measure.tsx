import { useMemo, useState } from 'react';
import { halsaDevice } from '../../../shared/halsa.ts';
import type { ObservationView, ReportResult, Transaction } from '../../../shared/types.ts';
import { call } from '../../api.ts';
import type { ScreenProps } from '../App.tsx';
import { halsaReading, prefilledValue, useStopHalsa, writeRatingToHalsa } from '../halsa.ts';
import { isRating, simulate, simulationFor, SIMULATED_DEVICE } from '../healthkit.ts';
import { CheckIcon, HeartIcon } from '../icons.tsx';
import { DAY, formatClock, formatLong, observationsFor, planColor, planDay, stopState } from '../model.ts';

// Step 6: the patient reports a stop. Values a phone reads from Health are
// simulated; ratings use a slider; anything else is typed. On send, MMD stores
// the values with the stamp and passes them on to PDHC.
// For a patient linked to Hälsa+, what the plan asks for is read from Hälsa+
// instead (see ../halsa.ts), and ratings are written back to Hälsa+ as well.

interface Props extends ScreenProps {
  requestGuid: string;
  activityKey: string;
  stopIndex: number;
}

function seedOf(text: string, index: number) {
  let hash = index + 1;
  for (const char of text) hash = (hash * 31 + char.charCodeAt(0)) % 100003;
  return hash;
}

function Receipt({ observations, planTitle, message }: { observations: ObservationView[]; planTitle: string; message?: string }) {
  const first = observations[0];
  if (!first) return null;
  const status = message ?? first.reportMessage ?? '';
  const devices = [...new Set(observations.map((o) => o.device).filter(Boolean))];
  return (
    <section className="receipt" aria-live="polite">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span className="mark" style={{ width: 40, height: 40, background: 'var(--cyan)' }}>
          <CheckIcon size={20} />
        </span>
        <div>
          <h2 style={{ fontSize: 17 }}>Sent to the care team</h2>
          <span className="muted small">{formatClock(first.recordedAt)} · {status}</span>
        </div>
      </div>
      <ul className="list" style={{ gap: 4 }}>
        {observations.map((o) => (
          <li key={o.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
            <span className="muted">{o.name}</span>
            <strong>
              {o.value === 'done' ? 'Done' : o.value} {o.unit ?? ''}
            </strong>
          </li>
        ))}
      </ul>
      <div className="stamps" aria-label="Stamp">
        <span className="chip plain" style={{ color: 'var(--cyan)' }}>Patient reported</span>
        <span className="chip plain" style={{ color: 'var(--cyan)' }}>Source: {first.sourceApp}</span>
        {devices.map((d) => (
          <span key={d} className="chip plain">
            {d}
          </span>
        ))}
        <span className="chip plain" style={{ color: 'var(--orange)' }}>
          {planTitle}
          {first.planDay ? ` · day ${first.planDay}` : ''}
        </span>
      </div>
      <a href="#/" style={{ fontWeight: 700 }}>
        Back to today →
      </a>
    </section>
  );
}

export function MeasureScreen({ view, today, refresh, patientGuid, requestGuid, activityKey, stopIndex }: Props) {
  const request = view.requests.find((r) => r.guid === requestGuid);
  const activity = request?.activities.find((a) => a.key === activityKey);
  const stop = activity?.stops[stopIndex];
  const transactions: Transaction[] = activity?.transactions ?? [];
  const [seedBump, setSeedBump] = useState(0);
  const [values, setValues] = useState<Record<string, string>>({});
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<ReportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [halsaNote, setHalsaNote] = useState<string | null>(null);
  const halsa = useStopHalsa(patientGuid, transactions, stop?.dueAt);

  const simulated = useMemo(() => {
    const out: Record<string, string> = {};
    for (const t of transactions) {
      const sim = simulationFor(t.name);
      if (sim) out[t.name] = simulate(sim, seedOf(`${activityKey}/${t.name}`, stopIndex) + seedBump);
    }
    return out;
  }, [transactions, activityKey, stopIndex, seedBump]);

  if (!request || !activity || !stop) {
    return (
      <main className="screen">
        <a className="back" href="#/">← Today</a>
        <p className="error">This stop was not found in your plan.</p>
      </main>
    );
  }

  const plan = request.carePlans[activity.planIndex];
  const planTitle = plan?.title ?? request.title ?? 'Plan';
  const color = planColor(view, request.guid, activity.planId);
  const state = stopState(stop, today);
  const existing = observationsFor(view, request.guid, activity.key, stop.index);
  const due = Date.parse(stop.dueAt);

  const valueOf = (t: Transaction) => values[t.name] ?? prefilledValue(t, halsaReading(t, halsa), simulated[t.name]);

  const send = async () => {
    setSending(true);
    setError(null);
    try {
      const report = await call<ReportResult>('POST', `/api/app/${encodeURIComponent(patientGuid)}/report`, {
        serviceRequestGuid: request.guid,
        activityKey: activity.key,
        stopIndex: stop.index,
        values: transactions.map((t) => {
          const reading = halsaReading(t, halsa);
          const fromHalsa = reading?.point && !reading.rating && values[t.name] === undefined ? reading.point : undefined;
          return {
            name: t.name,
            value: valueOf(t),
            unit: fromHalsa?.unit ?? simulationFor(t.name)?.unit ?? t.unit,
            device: fromHalsa
              ? halsaDevice(fromHalsa)
              : !reading && simulated[t.name] !== undefined && values[t.name] === undefined
                ? SIMULATED_DEVICE
                : undefined,
          };
        }),
        note: note || undefined,
      });
      setResult(report);
      // Ratings go to Hälsa+ too, so both keep the same history.
      const ratings = transactions.flatMap((t) => {
        const reading = halsaReading(t, halsa);
        return reading?.rating ? [{ series: reading.series, value: valueOf(t) }] : [];
      });
      const failed = (await Promise.all(ratings.map((r) => writeRatingToHalsa(patientGuid, r.series, r.value)))).find(Boolean);
      setHalsaNote(failed ? `Sent to the care team, but not saved in Hälsa+: ${failed}` : null);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sending failed.');
    } finally {
      setSending(false);
    }
  };

  const missing = transactions.some((t) => !valueOf(t));

  return (
    <main className="screen">
      <a className="back" href="#/">
        ← Today
      </a>
      <div>
        <p className="k">{due >= today && due < today + DAY ? 'Today' : formatLong(due)}</p>
        <h1>{activity.title}</h1>
        <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
          <span className="chip" style={{ background: `${color}2a`, color }}>
            {planTitle}
          </span>
          <span className="chip plain">day {planDay(request, due)}</span>
        </div>
      </div>
      {activity.description && <p className="muted" style={{ margin: 0 }}>{activity.description}</p>}

      {result ? (
        <>
          <Receipt observations={result.observations} planTitle={planTitle} message={result.reportMessage} />
          {halsaNote && (
            <p className="error" role="alert">
              {halsaNote}
            </p>
          )}
        </>
      ) : existing.length > 0 || stop.performedAt ? (
        existing.length > 0 ? (
          <Receipt observations={existing} planTitle={planTitle} />
        ) : (
          <section className="card">
            <h2>Done</h2>
            <p className="muted small">Marked as done {formatClock(stop.performedAt!)}.</p>
          </section>
        )
      ) : state === 'planned' ? (
        <section className="card">
          <h2>Not yet</h2>
          <p className="muted">This stop is on {formatLong(due)}. You can report it then.</p>
        </section>
      ) : (
        <>
          {halsa.status === 'error' && <p className="muted small" style={{ margin: 0 }}>Hälsa+: {halsa.message}</p>}
          {transactions.map((t) => {
            const sim = simulationFor(t.name);
            const reading = halsaReading(t, halsa);
            const rating = !sim && (isRating(t.name, t.rangeMin, t.rangeMax) || !!reading?.rating);
            const id = `value-${seedOf(t.name, 0)}`;
            // From Hälsa+ without a value there: typed, like any other value.
            if (sim && (!reading || reading.loading || reading.point)) {
              return (
                <section key={t.name} className="card" aria-labelledby={id} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <h2 id={id} style={{ color }}>
                      {t.name}
                    </h2>
                    {t.rangeMin !== undefined && t.rangeMax !== undefined && Number(valueOf(t)) >= t.rangeMin && Number(valueOf(t)) <= t.rangeMax && (
                      <span className="chip">In range</span>
                    )}
                  </div>
                  <div className="big-value">
                    {valueOf(t) || '…'} <small>{reading?.point?.unit ?? sim.unit}</small>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                    <span className="muted small" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <HeartIcon />
                      {!reading
                        ? 'From Health · simulated in the demo'
                        : reading.point
                          ? `From ${halsaDevice(reading.point)}${reading.point.status === 'preliminary' ? ' · preliminary' : ''}`
                          : 'Reading from Hälsa+ …'}
                    </span>
                    {!reading && (
                      <button type="button" className="btn ghost" style={{ minHeight: 34 }} onClick={() => setSeedBump(seedBump + 1)}>
                        Read again
                      </button>
                    )}
                  </div>
                </section>
              );
            }
            if (rating) {
              return (
                <section key={t.name} className="card" style={{ display: 'flex', flexDirection: 'column', gap: 10, borderColor: `${color}88` }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 12 }}>
                    <label htmlFor={id} style={{ fontWeight: 700 }}>
                      {t.name.replace(/\s*\(0\s*[–-]\s*10\)/, '')}
                    </label>
                    <span style={{ fontSize: 30, fontWeight: 700, whiteSpace: 'nowrap' }}>
                      {valueOf(t) || '–'}
                      <span className="muted" style={{ fontSize: 14 }}>
                        {' '}
                        /10
                      </span>
                    </span>
                  </div>
                  <input
                    id={id}
                    type="range"
                    min={0}
                    max={10}
                    step={1}
                    value={valueOf(t)}
                    onChange={(e) => setValues({ ...values, [t.name]: e.target.value })}
                  />
                  <div className="muted small" style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span>None at all</span>
                    <span>Worst imaginable</span>
                  </div>
                </section>
              );
            }
            return (
              <section key={t.name} className="card" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <label htmlFor={id} style={{ fontWeight: 700 }}>
                  {t.name}
                  {t.unit ? ` (${t.unit})` : ''}
                </label>
                <input
                  id={id}
                  className="field"
                  inputMode="decimal"
                  value={valueOf(t)}
                  onChange={(e) => setValues({ ...values, [t.name]: e.target.value })}
                />
              </section>
            );
          })}

          <label className="visually-hidden" htmlFor="note">
            Note for the care team
          </label>
          <textarea id="note" className="field" rows={2} placeholder="Note for the care team (optional)" value={note} onChange={(e) => setNote(e.target.value)} />

          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: 10 }}>
            <button type="button" className="btn big" onClick={() => void send()} disabled={sending || missing}>
              {sending ? 'Sending …' : transactions.length ? 'Send to the care team' : 'Mark as done'}
            </button>
            <p className="muted small" style={{ margin: 0, textAlign: 'center' }}>
              Your values are marked as patient reported and sent with MMD as the source.
            </p>
          </div>
        </>
      )}
    </main>
  );
}
