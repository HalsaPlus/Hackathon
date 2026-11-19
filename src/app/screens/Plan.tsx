import { Fragment, useState } from 'react';
import type { ScreenProps } from '../App.tsx';
import { CheckIcon } from '../icons.tsx';
import {
  activeRequests,
  addDays,
  DAY,
  formatShort,
  formatWeekday,
  lanes,
  measureHref,
  milestones,
  nextStop,
  planWeeks,
  startOfDay,
  stopOn,
  stopState,
} from '../model.ts';

// The care plan as a metro map, top to bottom: one row per day, one line per
// activity, coloured by care plan. A follow-up with the care team is an
// interchange across all lines.

const STATE_TEXT = { done: 'done', today: 'today', missed: 'missed', planned: 'coming' } as const;

export function PlanScreen({ view, today }: ScreenProps) {
  const lines = lanes(view);
  const request = activeRequests(view)[0];
  const start = request ? startOfDay(Date.parse(request.periodStart)) : today;
  const weeks = request ? planWeeks(request) : 1;
  const currentWeek = Math.min(weeks - 1, Math.max(0, Math.floor((today - start) / (7 * DAY))));
  const [week, setWeek] = useState(currentWeek);

  if (!request || lines.length === 0) {
    return (
      <main className="screen">
        <h1>My plan</h1>
        <section className="card">
          <h2>No plan yet</h2>
          <p className="muted">When your care team sends a plan, it is drawn here as a metro map.</p>
        </section>
      </main>
    );
  }

  const days = Array.from({ length: 7 }, (_, i) => addDays(start, week * 7 + i));
  const interchanges = milestones(view);
  const next = nextStop(view, today);
  const columns = `78px repeat(${lines.length}, minmax(58px, 1fr))`;

  return (
    <main className="screen">
      <header style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12 }}>
        <div>
          <h1>My plan</h1>
          <p className="muted" style={{ margin: 0 }}>
            {request.carePlans.map((p) => p.title).filter(Boolean).join(' · ')}
          </p>
        </div>
        <span className="chip plain">Goal {formatShort(request.periodEnd)}</span>
      </header>

      <div className="week-nav">
        <button type="button" className="icon-btn" onClick={() => setWeek(week - 1)} disabled={week === 0} aria-label="Previous week">
          ←
        </button>
        <strong aria-live="polite">
          Week {week + 1} of {weeks}
        </strong>
        <button type="button" className="icon-btn" onClick={() => setWeek(week + 1)} disabled={week >= weeks - 1} aria-label="Next week">
          →
        </button>
      </div>

      <div style={{ overflowX: 'auto' }}>
        <div className="metro" style={{ gridTemplateColumns: columns, minWidth: 78 + lines.length * 58 }} role="grid" aria-label={`Week ${week + 1}`}>
          <div className="metro-head" />
          {lines.map((lane) => (
            <div key={lane.activity.key} className="metro-head" style={{ color: lane.color }}>
              {lane.activity.title}
            </div>
          ))}
          {days.map((day) => {
            const isToday = day === today;
            const rowClass = isToday ? ' metro-row-today' : '';
            const dayInterchanges = interchanges.filter((m) => {
              const due = Date.parse(m.stop.dueAt);
              return due >= day && due < addDays(day, 1);
            });
            return (
              <Fragment key={day}>
                <div className={`metro-day${isToday ? ' is-today' : ''}${rowClass}`}>
                  {formatWeekday(day)}
                  <span className="small" style={{ fontWeight: 500 }}>
                    {isToday ? 'today' : formatShort(day)}
                  </span>
                </div>
                {lines.map((lane) => {
                  const stop = stopOn(lane.activity, day);
                  const state = stop ? stopState(stop, today) : null;
                  const label = stop ? `${lane.activity.title}, ${formatShort(day)}: ${STATE_TEXT[state!]}` : undefined;
                  return (
                    <div key={lane.activity.key} className={`metro-cell${rowClass}`} style={{ ['--c' as string]: lane.color }}>
                      {stop && state && (
                        <button
                          type="button"
                          className={`station ${state}`}
                          aria-label={label}
                          title={label}
                          disabled={state === 'planned'}
                          onClick={() => {
                            window.location.hash = measureHref(lane.request.guid, lane.activity.key, stop.index);
                          }}
                        >
                          {state === 'done' && <CheckIcon size={12} />}
                        </button>
                      )}
                    </div>
                  );
                })}
                {dayInterchanges.map((m) => (
                  <div key={`${m.activity.key}-${m.stop.index}`} style={{ gridColumn: `2 / span ${lines.length}` }} className="interchange">
                    {m.activity.title} · {formatShort(m.stop.dueAt)}
                  </div>
                ))}
              </Fragment>
            );
          })}
        </div>
      </div>

      <ul className="legend" aria-label="Key">
        <li>
          <span className="station done" style={{ ['--c' as string]: '#B9B5D6', width: 14, height: 14 }} />
          Done
        </li>
        <li>
          <span className="station" style={{ ['--c' as string]: '#B9B5D6', width: 14, height: 14, borderWidth: 3 }} />
          Coming
        </li>
        <li>
          <span className="station missed" style={{ width: 14, height: 14 }} />
          Missed
        </li>
        <li>
          <span className="interchange" style={{ minHeight: 16, margin: 0, padding: '0 8px', fontSize: 10, borderWidth: 2 }}>
            Follow-up
          </span>
          Interchange
        </li>
      </ul>

      {next && (
        <section className="row" style={{ marginTop: 'auto', borderColor: `${next.lane.color}88` }}>
          <span aria-hidden="true" style={{ width: 10, height: 36, flex: 'none', borderRadius: 5, background: next.lane.color }} />
          <span className="row-body">
            <span className="row-title">Next: {next.lane.activity.title.toLowerCase()}</span>
            <span className="muted small">
              {Date.parse(next.stop.dueAt) < today + DAY ? 'Today' : formatShort(next.stop.dueAt)} · {next.lane.planTitle}
            </span>
          </span>
          {Date.parse(next.stop.dueAt) < today + DAY && (
            <a className="btn" href={measureHref(next.lane.request.guid, next.lane.activity.key, next.stop.index)}>
              Do it
            </a>
          )}
        </section>
      )}
    </main>
  );
}
