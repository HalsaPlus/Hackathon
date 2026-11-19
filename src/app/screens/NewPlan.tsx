import { useState } from 'react';
import { call } from '../../api.ts';
import type { ScreenProps } from '../App.tsx';
import { ShieldIcon } from '../icons.tsx';
import { formatShort, isMilestone, lanes, planColor, planWeeks } from '../model.ts';

// Step 5: the plan the care team sent, before the patient opens the map.

export function NewPlanScreen({ view, patientGuid, refresh, requestGuid }: ScreenProps & { requestGuid: string }) {
  const request = view.requests.find((r) => r.guid === requestGuid);
  const [opening, setOpening] = useState(false);

  if (!request) {
    return (
      <main className="screen">
        <a className="back" href="#/chat">← Chat</a>
        <p className="error">The plan was not found.</p>
      </main>
    );
  }

  const ownLanes = lanes(view).filter((l) => l.request.guid === request.guid);
  const followUp = request.activities.filter(isMilestone).flatMap((a) => a.stops)[0];

  const open = async () => {
    setOpening(true);
    try {
      await call('POST', `/api/app/${encodeURIComponent(patientGuid)}/requests/${encodeURIComponent(request.guid)}/seen`);
      await refresh();
    } finally {
      window.location.hash = '#/plan';
    }
  };

  return (
    <main className="screen">
      <a className="back" href="#/chat">
        ← Chat
      </a>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <p className="k" style={{ color: 'var(--cyan)' }}>
          {request.seenAt ? 'Your plan' : 'New plan from the care team'}
        </p>
        <h1>Your plan for the next {planWeeks(request)} weeks</h1>
        <p className="muted" style={{ margin: 0 }}>
          {formatShort(request.periodStart)} – {formatShort(request.periodEnd)}
          {followUp ? ` · follow-up ${formatShort(followUp.dueAt)}` : ''}
        </p>
        {request.closed && (
          <p className="error" role="status" style={{ margin: 0 }}>
            The care team has closed this plan. It is no longer on your map.
          </p>
        )}
      </div>

      <section className="card" aria-labelledby="goals" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <h2 id="goals" className="k">
          Goals
        </h2>
        {request.carePlans.flatMap((plan) =>
          plan.goals.map((goal) => (
            <div key={`${plan.id}/${goal.text}`} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span className="dot" style={{ background: planColor(view, request.guid, plan.id) }} aria-hidden="true" />
              <span>
                {goal.text}
                {goal.target && <span className="muted small"> · {goal.target}</span>}
              </span>
            </div>
          )),
        )}
      </section>

      <section aria-labelledby="todo" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <h2 id="todo" className="k">
          What you do
        </h2>
        {ownLanes.map((lane) => (
          <div key={lane.activity.key} className="row">
            <svg aria-hidden="true" width="40" height="12" viewBox="0 0 40 12" style={{ flex: 'none' }}>
              <path d="M2 6 H38" style={{ stroke: lane.color, strokeWidth: 4, strokeLinecap: 'round' }} />
              {[6, 20, 34].map((x) => (
                <circle key={x} cx={x} cy="6" r="3.5" style={{ fill: '#221B5C', stroke: lane.color, strokeWidth: 2 }} />
              ))}
            </svg>
            <span className="row-body">
              <span className="row-title">{lane.planTitle}</span>
              <span className="muted small">
                {lane.activity.title} · {lane.activity.schedule.toLowerCase()}
              </span>
            </span>
          </div>
        ))}
      </section>

      <p className="muted small" style={{ display: 'flex', gap: 10, margin: 0 }}>
        <ShieldIcon />
        The plan comes from your care team through PDHC. What you report is marked as patient reported, from MMD.
      </p>

      <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: 10 }}>
        <button type="button" className="btn big" onClick={() => void open()} disabled={opening}>
          Show my plan
        </button>
        <a href="#/chat" className="btn ghost">
          Questions? Chat with the care team
        </a>
      </div>
    </main>
  );
}
