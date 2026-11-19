import type { ActivityView, Stop } from '../../shared/types.ts';
import { DAY, formatDateTime, formatLong, performerLabel, requirementLabel, startOfDay } from '../format.ts';
import { type Line, STATE_LABEL, type Station, stationState } from '../metro.ts';
import { lineColor } from './MetroMap.tsx';

// What a stop on the map means: what to do, what is recorded, and whether it
// has been done. A stop can be marked as done (or undone) here.

interface Props {
  line: Line;
  station: Station;
  busy: boolean;
  onToggle: (stop: Stop, performed: boolean) => void;
  onClose: () => void;
}

function range(min: number | undefined, max: number | undefined, unit: string | undefined) {
  if (min === undefined && max === undefined) return null;
  const text = min !== undefined && max !== undefined ? `${min}–${max}` : min !== undefined ? `minst ${min}` : `högst ${max}`;
  return unit ? `${text} ${unit}` : text;
}

function StopRow({ stop, busy, onToggle }: { stop: Stop; busy: boolean; onToggle: Props['onToggle'] }) {
  const today = startOfDay(Date.now());
  const state = stationState([stop], today);
  const future = Date.parse(stop.dueAt) >= today + DAY;
  return (
    <li className={`stop-row state-${state}`}>
      <span className="stop-row-date">{formatLong(stop.dueAt)}</span>
      <span className="stop-row-state">
        {stop.performedAt ? `Utförd ${formatDateTime(stop.performedAt)}` : STATE_LABEL[state]}
      </span>
      {stop.performedAt ? (
        <button type="button" className="button subtle" disabled={busy} onClick={() => onToggle(stop, false)}>
          Ångra
        </button>
      ) : (
        <button type="button" className="button" disabled={busy || future} onClick={() => onToggle(stop, true)}>
          Markera som utförd
        </button>
      )}
    </li>
  );
}

function Activity({ activity }: { activity: ActivityView }) {
  const performer = performerLabel(activity.performerType);
  return (
    <>
      {activity.description && <p className="panel-description">{activity.description}</p>}
      <dl className="facts">
        <div>
          <dt>Hur ofta</dt>
          <dd>{activity.schedule}</dd>
        </div>
        {performer && (
          <div>
            <dt>Vem</dt>
            <dd>{performer}</dd>
          </div>
        )}
        {activity.status && (
          <div>
            <dt>Status i vårdplanen</dt>
            <dd>
              <code>{activity.status}</code>
            </dd>
          </div>
        )}
      </dl>
      {activity.transactions.length > 0 && (
        <>
          <h4>Det här registreras</h4>
          <ul className="transactions">
            {activity.transactions.map((t) => (
              <li key={t.transactionGuid ?? t.conceptGuid ?? t.name}>
                <span className="transaction-name">{t.name}</span>
                <span className="transaction-meta">
                  {[requirementLabel(t.requirement), range(t.rangeMin, t.rangeMax, t.unit)].filter(Boolean).join(' · ')}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}

export function StopPanel({ line, station, busy, onToggle, onClose }: Props) {
  const grouped = station.stops.length > 1;
  return (
    <section className="panel" aria-labelledby="panel-title">
      <header className="panel-header">
        <span className="line-badge" style={{ background: lineColor(line.index) }} aria-hidden="true">
          {line.index + 1}
        </span>
        <div>
          <h3 id="panel-title">{line.activity.title}</h3>
          <p className="panel-when">
            {station.label}
            {grouped && ` · ${station.doneCount} av ${station.stops.length} utförda`}
          </p>
        </div>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Stäng">
          ×
        </button>
      </header>
      <Activity activity={line.activity} />
      <h4>{grouped ? 'Hållplatserna' : 'Hållplatsen'}</h4>
      <ul className="stop-rows">
        {station.stops.map((stop) => (
          <StopRow key={stop.index} stop={stop} busy={busy} onToggle={onToggle} />
        ))}
      </ul>
      <p className="panel-note">
        Utförda hållplatser sparas bara i appen än så länge. Att rapportera mätvärden till PDHC (gateway.pdhc) kommer i ett
        senare steg.
      </p>
    </section>
  );
}
