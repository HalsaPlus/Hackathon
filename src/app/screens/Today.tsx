import type { ScreenProps } from '../App.tsx';
import { CheckIcon, ChatIcon, MmdMark } from '../icons.tsx';
import {
  activeRequests,
  formatClock,
  formatShort,
  formatWeekday,
  measureHref,
  milestones,
  observationsFor,
  planDay,
  planWeeks,
  stopState,
  todaysStops,
} from '../model.ts';

function Ring({ done, total }: { done: number; total: number }) {
  const r = 26;
  const length = 2 * Math.PI * r;
  const fraction = total ? done / total : 0;
  return (
    <svg role="img" aria-label={`${done} of ${total} done today`} width="64" height="64" viewBox="0 0 64 64" style={{ flex: 'none' }}>
      <circle cx="32" cy="32" r={r} style={{ fill: 'none', stroke: 'rgba(255,255,255,.12)', strokeWidth: 8 }} />
      <circle
        cx="32"
        cy="32"
        r={r}
        transform="rotate(-90 32 32)"
        style={{ fill: 'none', stroke: '#03D4D1', strokeWidth: 8, strokeLinecap: 'round', strokeDasharray: `${fraction * length} ${length}`, transition: 'stroke-dasharray .6s ease' }}
      />
      <text x="32" y="38" textAnchor="middle" style={{ font: '700 16px Quicksand, sans-serif', fill: '#fff' }}>
        {done}/{total}
      </text>
    </svg>
  );
}

export function TodayScreen({ view, today }: ScreenProps) {
  const requests = activeRequests(view);
  const first = view.patient.displayName?.split(' ')[0] ?? 'there';
  const initial = (view.patient.displayName ?? '?').charAt(0);

  const header = (
    <header className="top">
      <span className="brand">
        <MmdMark />
        MMD
      </span>
      <a className="avatar" href="#/patients" aria-label="Switch patient">
        {initial}
      </a>
    </header>
  );

  if (requests.length === 0) {
    return (
      <main className="screen">
        {header}
        <h1>Hi {first}</h1>
        <section className="card">
          <h2>Your plan is on its way</h2>
          <p className="muted">Your care team is preparing it with you. It shows up here when it arrives.</p>
        </section>
      </main>
    );
  }

  const request = requests[0];
  const items = todaysStops(view, today);
  const done = items.filter((i) => i.stop.performedAt);
  const fromHealth = done
    .map((i) => ({ i, obs: observationsFor(view, i.lane.request.guid, i.lane.activity.key, i.stop.index) }))
    .find((x) => x.obs.some((o) => o.device));
  const unseen = requests.find((r) => !r.seenAt);
  const lastTeam = [...view.messages].reverse().find((m) => m.sender === 'care-team');
  const nextMilestone = milestones(view)
    .filter((m) => Date.parse(m.stop.dueAt) >= today)
    .sort((a, b) => Date.parse(a.stop.dueAt) - Date.parse(b.stop.dueAt))[0];
  const week = Math.ceil(planDay(request, today) / 7);

  return (
    <main className="screen">
      {header}
      <div>
        <h1>Hi {first}</h1>
        <p className="muted" style={{ margin: 0 }}>
          {formatWeekday(today)} · week {Math.max(1, week)} of {planWeeks(request)}
        </p>
      </div>

      {unseen && (
        <a className="row" href={`#/new-plan/${encodeURIComponent(unseen.guid)}`} style={{ borderColor: 'rgba(3,212,209,.55)', color: 'inherit' }}>
          <span className="mark planned" style={{ ['--c' as string]: '#03D4D1' }} />
          <span className="row-body">
            <span className="row-title">New plan from the care team</span>
            <span className="muted small">{unseen.carePlans.map((p) => p.title).filter(Boolean).join(', ')}</span>
          </span>
          <span className="btn">Open</span>
        </a>
      )}

      <section className="card" style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <Ring done={done.length} total={items.length} />
        <div>
          <h2 style={{ fontSize: 17 }}>
            {done.length} of {items.length} done today
          </h2>
          <p className="muted small" style={{ margin: '4px 0 0' }}>
            {fromHealth
              ? `${fromHealth.i.lane.activity.title} came in from Health at ${formatClock(fromHealth.obs[0].recordedAt)}.`
              : items.length
                ? 'One stop at a time. You decide when.'
                : 'Nothing planned for today.'}
          </p>
        </div>
      </section>

      {items.length > 0 && (
        <section aria-labelledby="today-stops">
          <h2 id="today-stops" className="k" style={{ marginBottom: 8 }}>
            Today's stops
          </h2>
          <ul className="list">
            {items.map(({ lane, stop }) => {
              const state = stopState(stop, today);
              const obs = observationsFor(view, lane.request.guid, lane.activity.key, stop.index);
              const href = measureHref(lane.request.guid, lane.activity.key, stop.index);
              return (
                <li key={`${lane.request.guid}/${lane.activity.key}`}>
                  <a className="row" href={href} style={{ color: 'inherit', borderColor: state === 'today' ? `${lane.color}88` : 'transparent' }}>
                    <span className={`mark ${state}`} style={{ ['--c' as string]: lane.color }}>
                      {state === 'done' && <CheckIcon />}
                    </span>
                    <span className="row-body">
                      <span className="row-title">{lane.activity.title}</span>
                      <span className="muted small">
                        {lane.planTitle} ·{' '}
                        {stop.performedAt
                          ? `done ${formatClock(stop.performedAt)}${obs.some((o) => o.device) ? ', from Health' : ''}`
                          : 'to do today'}
                      </span>
                    </span>
                    {!stop.performedAt && <span className="btn">Do it</span>}
                  </a>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {lastTeam && (
        <section className="row" style={{ background: 'var(--card-2)' }}>
          <span className="mark" style={{ width: 36, height: 36, background: 'var(--lavender)', color: 'var(--bg)' }}>
            <ChatIcon />
          </span>
          <span className="row-body">
            <span className="small" style={{ fontWeight: 700, color: 'var(--lavender)' }}>
              Care team
            </span>
            <span style={{ fontSize: 14 }}>{lastTeam.text}</span>
          </span>
          <a href="#/chat" style={{ fontWeight: 700, fontSize: 13 }}>
            Reply
          </a>
        </section>
      )}

      {nextMilestone && (
        <section className="row" style={{ background: 'transparent', border: '1px dashed rgba(255,255,255,.28)' }}>
          <svg aria-hidden="true" width="28" height="28" viewBox="0 0 28 28" style={{ flex: 'none' }}>
            <rect x="3" y="9" width="22" height="10" rx="5" style={{ fill: '#181144', stroke: '#fff', strokeWidth: 2 }} />
          </svg>
          <span className="row-body">
            <span className="row-title">Next interchange: {nextMilestone.activity.title.toLowerCase()}</span>
            <span className="muted small">
              {formatShort(nextMilestone.stop.dueAt)} · all {request.carePlans.length > 1 ? `${request.carePlans.length} plans` : 'of your plan'}
            </span>
          </span>
        </section>
      )}
    </main>
  );
}
