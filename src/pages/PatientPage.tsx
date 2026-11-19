import { useCallback, useEffect, useState } from 'react';
import type { PatientView, ServiceRequestView, Stop } from '../../shared/types.ts';
import { api } from '../api.ts';
import { lineColor, MetroMap } from '../components/MetroMap.tsx';
import { StopPanel } from '../components/StopPanel.tsx';
import { DAY, formatDateTime, formatLong, formatRange, formatShort, sourceLabel, startOfDay } from '../format.ts';
import { type Line, nextStop, progress, type Station, stationState } from '../metro.ts';

interface Selection {
  activityKey: string;
  stationId: string;
  indexes: number[];
  label: string;
}

function Today({ request, busy, onDone }: { request: ServiceRequestView; busy: boolean; onDone: (key: string, stop: Stop) => void }) {
  const today = startOfDay(Date.now());
  const due = request.activities
    .map((activity, index) => ({
      activity,
      index,
      stop: activity.stops.find((s) => Date.parse(s.dueAt) >= today && Date.parse(s.dueAt) < today + DAY),
    }))
    .filter((item) => item.stop);
  if (due.length === 0) return null;
  return (
    <section className="today" aria-labelledby={`today-${request.guid}`}>
      <h3 id={`today-${request.guid}`}>I dag</h3>
      <ul>
        {due.map(({ activity, index, stop }) => (
          <li key={activity.key} className={stop!.performedAt ? 'is-done' : undefined}>
            <span className="line-badge small" style={{ background: lineColor(index) }} aria-hidden="true">
              {index + 1}
            </span>
            <span className="today-title">{activity.title}</span>
            {stop!.performedAt ? (
              <span className="today-done">Klart</span>
            ) : (
              <button type="button" className="button" disabled={busy} onClick={() => onDone(activity.key, stop!)}>
                Markera som utförd
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function LineList({ request }: { request: ServiceRequestView }) {
  const today = startOfDay(Date.now());
  return (
    <section aria-labelledby={`lines-${request.guid}`}>
      <h3 id={`lines-${request.guid}`}>Linjerna</h3>
      <ol className="line-list">
        {request.activities.map((activity, index) => {
          const p = progress(activity, today);
          const next = nextStop(activity, today);
          return (
            <li key={activity.key}>
              <span className="line-badge" style={{ background: lineColor(index) }} aria-hidden="true">
                {index + 1}
              </span>
              <div className="line-info">
                <div className="line-title">{activity.title}</div>
                <div className="line-meta">
                  {activity.schedule}
                  {next ? ` · nästa ${Date.parse(next.dueAt) < today + DAY ? 'i dag' : formatShort(next.dueAt)}` : ''}
                </div>
                {p.total > 0 && (
                  <div className="meter" aria-label={`${p.done} av ${p.total} utförda`}>
                    <span style={{ width: `${(p.done / p.total) * 100}%`, background: lineColor(index) }} />
                  </div>
                )}
                <div className="line-meta">
                  {p.total === 0
                    ? 'Inga hållplatser: vårdplanen anger inget schema.'
                    : `${p.done} av ${p.total} utförda${p.missed ? `, ${p.missed} ${p.missed === 1 ? 'missad' : 'missade'}` : ''}`}
                </div>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function RequestCard({ request, onChanged }: { request: ServiceRequestView; onChanged: () => Promise<void> }) {
  const [selection, setSelection] = useState<Selection | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = async (activityKey: string, stop: Stop, performed: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await api.setPerformed(request.guid, activityKey, stop.index, performed);
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Det gick inte att spara.');
    } finally {
      setBusy(false);
    }
  };

  // Rebuild the selected station from fresh data, so the panel follows changes.
  let selectedLine: Line | null = null;
  let selectedStation: Station | null = null;
  if (selection) {
    const index = request.activities.findIndex((a) => a.key === selection.activityKey);
    const activity = request.activities[index];
    const stops = activity?.stops.filter((s) => selection.indexes.includes(s.index)) ?? [];
    if (activity && stops.length) {
      selectedLine = { activity, index, stations: [], firstTime: null, lastTime: null };
      selectedStation = {
        id: selection.stationId,
        activityKey: activity.key,
        stops,
        time: Date.parse(stops[0].dueAt),
        label: selection.label,
        state: stationState(stops, startOfDay(Date.now())),
        doneCount: stops.filter((s) => s.performedAt).length,
      };
    }
  }

  const goals = request.carePlan?.goals ?? [];
  return (
    <article className="card request">
      <header className="request-header">
        <div>
          <h2>{request.title ?? request.carePlan?.title ?? 'Beställning utan titel'}</h2>
          {request.carePlan?.description && <p className="lead">{request.carePlan.description}</p>}
        </div>
        <dl className="request-facts">
          <div>
            <dt>Period</dt>
            <dd>
              {formatRange(Date.parse(request.periodStart), Date.parse(request.periodEnd))}
              {!request.periodEndGiven && <span className="muted"> (slutdatum saknas, visar 12 veckor)</span>}
            </dd>
          </div>
          <div>
            <dt>Källa</dt>
            <dd>
              {sourceLabel(request.source)}
              {request.connectionName ? `, ${request.connectionName}` : ''}
            </dd>
          </div>
          <div>
            <dt>Mottagen</dt>
            <dd>{formatDateTime(request.receivedAt)}</dd>
          </div>
          {request.status && (
            <div>
              <dt>Status</dt>
              <dd>
                <code>{request.status}</code>
              </dd>
            </div>
          )}
        </dl>
      </header>

      {goals.length > 0 && (
        <div className="goals">
          <span className="goals-label">Mål</span>
          <ul>
            {goals.map((goal) => (
              <li key={goal.text}>
                <strong>{goal.text}</strong>
                {goal.target && <span className="muted">: {goal.target}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {request.activities.length === 0 ? (
        <p className="empty">Beställningen har ingen vårdplan med aktiviteter att rita.</p>
      ) : (
        <MetroMap
          request={request}
          selectedId={selection?.stationId ?? null}
          onSelect={(line, station) =>
            setSelection({
              activityKey: line.activity.key,
              stationId: station.id,
              indexes: station.stops.map((s) => s.index),
              label: station.label,
            })
          }
        />
      )}

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <div className="request-columns">
        <div>
          <Today request={request} busy={busy} onDone={(key, stop) => void toggle(key, stop, true)} />
          <LineList request={request} />
        </div>
        <div>
          {selectedLine && selectedStation ? (
            <StopPanel
              line={selectedLine}
              station={selectedStation}
              busy={busy}
              onToggle={(stop, performed) => void toggle(selectedLine!.activity.key, stop, performed)}
              onClose={() => setSelection(null)}
            />
          ) : (
            <div className="panel panel-empty">Välj en hållplats på kartan för att se vad som ska göras.</div>
          )}
        </div>
      </div>
    </article>
  );
}

export function PatientPage({ guid }: { guid: string }) {
  const [view, setView] = useState<PatientView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setView(await api.patient(guid));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Det gick inte att hämta patienten.');
    }
  }, [guid]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <p className="error">{error}</p>;
  if (!view) return <p className="muted">Hämtar …</p>;

  const { patient } = view;
  return (
    <>
      <a href="#/" className="back">
        ← Alla patienter
      </a>
      <header className="patient-header">
        <h1>{patient.displayName ?? 'Patient utan namn'}</h1>
        <p className="muted">
          {patient.birthDate && <>Född {patient.birthDate} · </>}
          <span className="mono">{patient.guid}</span>
        </p>
      </header>
      {view.requests.map((request) => (
        <RequestCard key={request.guid} request={request} onChanged={load} />
      ))}
      <p className="muted small">Uppdaterad {formatLong(Date.now())}.</p>
    </>
  );
}
