import { useState } from 'react';
import type { IpsView, ObservationView } from '../../../shared/types.ts';
import { call } from '../../api.ts';
import type { ScreenProps } from '../App.tsx';
import { CheckIcon } from '../icons.tsx';
import { DAY, formatShort, lanes } from '../model.ts';

// Step 11: the patient's own reported data next to the clinical summary (IPS)
// fetched through Health Connect, with a toggle between the two.

type Mode = 'mine' | 'clinical';

function Sparkline({ values, low, high, color }: { values: number[]; low?: number; high?: number; color: string }) {
  if (values.length < 2) return null;
  const w = 300;
  const h = 56;
  const min = Math.min(...values, low ?? Infinity);
  const max = Math.max(...values, high ?? -Infinity);
  const span = max - min || 1;
  const y = (v: number) => h - 6 - ((v - min) / span) * (h - 12);
  const points = values.map((v, i) => `${(i / (values.length - 1)) * (w - 8) + 4},${y(v).toFixed(1)}`).join(' ');
  const last = points.split(' ').at(-1)!.split(',');
  return (
    <svg role="img" aria-label={`Trend over ${values.length} values`} width="100%" height={h} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
      {low !== undefined && high !== undefined && (
        <rect x="0" y={y(high)} width={w} height={Math.max(2, y(low) - y(high))} rx="6" style={{ fill: `${color}1c` }} />
      )}
      <polyline points={points} style={{ fill: 'none', stroke: color, strokeWidth: 2.5, strokeLinecap: 'round', strokeLinejoin: 'round' }} />
      <circle cx={last[0]} cy={last[1]} r="4" style={{ fill: color }} />
    </svg>
  );
}

function ConfirmedChip({ latest }: { latest: ObservationView }) {
  if (latest.confirmed) {
    return (
      <span className="chip">
        <CheckIcon color="#03D4D1" size={12} />
        {latest.reportStatus === 'demo' ? 'Confirmed (demo)' : 'Confirmed by the care team'}
      </span>
    );
  }
  if (latest.reportStatus === 'failed') return <span className="chip orange">Not delivered</span>;
  return <span className="chip plain">Waiting for confirmation</span>;
}

function MyData({ view }: Pick<ScreenProps, 'view'>) {
  const ranges = new Map<string, { low?: number; high?: number; color: string }>();
  for (const lane of lanes(view)) {
    for (const t of lane.activity.transactions) ranges.set(t.name, { low: t.rangeMin, high: t.rangeMax, color: lane.color });
  }
  const byName = new Map<string, ObservationView[]>();
  for (const o of view.observations) {
    if (o.value === 'done') continue;
    byName.set(o.name, [...(byName.get(o.name) ?? []), o]);
  }
  const since = Date.now() - 14 * DAY;

  if (byName.size === 0) {
    return (
      <section className="card">
        <h2>Nothing reported yet</h2>
        <p className="muted">Your values show up here once you report your first stop.</p>
      </section>
    );
  }

  return (
    <ul className="list" style={{ gap: 12 }}>
      {[...byName.entries()].map(([name, list]) => {
        const latest = list.at(-1)!;
        const recent = list.filter((o) => Date.parse(o.recordedAt) >= since);
        const numbers = recent.map((o) => Number(o.value)).filter((n) => Number.isFinite(n));
        const average = numbers.length ? numbers.reduce((a, b) => a + b, 0) / numbers.length : null;
        const range = ranges.get(name);
        const color = range?.color ?? '#03D4D1';
        const rating = /0\s*[–-]\s*10/.test(name);
        return (
          <li key={name} className="card" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
              <h2 style={{ color }}>{name.replace(/\s*\(0\s*[–-]\s*10\)/, '')}</h2>
              <ConfirmedChip latest={latest} />
            </div>
            <div style={{ fontSize: 24, fontWeight: 700 }}>
              {latest.value}
              <span className="muted" style={{ fontSize: 14, fontWeight: 600 }}>
                {' '}
                {rating ? 'of 10' : (latest.unit ?? '')} · latest
              </span>
            </div>
            <Sparkline values={numbers} low={range?.low} high={range?.high} color={color} />
            <span className="muted small">
              {average !== null && numbers.length > 1 ? `Average ${average.toFixed(1)} over ${numbers.length} values · ` : ''}
              Patient reported · source {latest.sourceApp}
              {latest.device ? ` · ${latest.device}` : ''}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function Clinical({ ips, onRefresh, refreshing, message }: { ips: IpsView | null; onRefresh: () => void; refreshing: boolean; message: string | null }) {
  if (!ips) {
    return (
      <section className="card">
        <h2>No clinical summary yet</h2>
        <p className="muted">Your clinical summary (IPS) is fetched through Health Connect.</p>
      </section>
    );
  }
  const section = (title: string, rows: { key: string; main: string; side: string | null }[]) =>
    rows.length > 0 && (
      <section className="card" aria-label={title} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <h2 className="k">{title}</h2>
        <ul className="list" style={{ gap: 6 }}>
          {rows.map((r) => (
            <li key={r.key} style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
              <span style={{ fontWeight: 600 }}>{r.main}</span>
              {r.side && <span className="muted small" style={{ textAlign: 'right' }}>{r.side}</span>}
            </li>
          ))}
        </ul>
      </section>
    );

  return (
    <>
      <section className="row" style={{ background: 'var(--card-2)' }}>
        <span className="row-body">
          <span className="row-title">International Patient Summary</span>
          <span className="muted small">
            {ips.source} · {formatShort(ips.fetchedAt)}
          </span>
        </span>
        <span className="chip lavender">{ips.synthetic ? 'Synthetic' : 'Clinical'}</span>
      </section>
      {section(
        'Results',
        ips.results.map((r, i) => ({ key: `${r.name}${i}`, main: `${r.name} ${r.value} ${r.unit ?? ''}`, side: r.date ? formatShort(r.date) : null })),
      )}
      {section('Conditions', ips.problems.map((p, i) => ({ key: `${p.name}${i}`, main: p.name, side: p.since ? `since ${p.since.slice(0, 4)}` : null })))}
      {section('Medications', ips.medications.map((m, i) => ({ key: `${m.name}${i}`, main: m.name, side: m.dosage })))}
      {section('Allergies', ips.allergies.map((a, i) => ({ key: `${a.name}${i}`, main: a.name, side: a.criticality ? `${a.criticality} risk` : null })))}
      <button type="button" className="btn ghost" onClick={onRefresh} disabled={refreshing}>
        {refreshing ? 'Fetching …' : 'Fetch again through Health Connect'}
      </button>
      {message && <p className="muted small" style={{ margin: 0, textAlign: 'center' }}>{message}</p>}
    </>
  );
}

export function HealthScreen({ view, patientGuid, refresh }: ScreenProps) {
  const [mode, setMode] = useState<Mode>('mine');
  const [refreshing, setRefreshing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const praise = [...view.messages].reverse().find((m) => m.sender === 'care-team');

  const refetch = async () => {
    setRefreshing(true);
    setMessage(null);
    try {
      await call('POST', `/api/app/${encodeURIComponent(patientGuid)}/ips/refresh`);
      await refresh();
      setMessage('Updated.');
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Fetching failed.');
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <main className="screen">
      <div>
        <h1>My health</h1>
        <p className="muted" style={{ margin: 0 }}>
          Your own values and your clinical summary
        </p>
      </div>

      <div className="segmented" role="group" aria-label="Show">
        <button type="button" aria-pressed={mode === 'mine'} onClick={() => setMode('mine')}>
          My data
        </button>
        <button type="button" aria-pressed={mode === 'clinical'} onClick={() => setMode('clinical')}>
          Clinical (IPS)
        </button>
      </div>

      {mode === 'mine' ? <MyData view={view} /> : <Clinical ips={view.ips} onRefresh={() => void refetch()} refreshing={refreshing} message={message} />}

      {mode === 'mine' && praise && (
        <section className="praise">
          <span className="mark" style={{ width: 44, height: 44, background: 'var(--bg)' }}>
            <CheckIcon color="#B6A7FF" size={20} />
          </span>
          <span>
            <span className="small" style={{ fontWeight: 700, letterSpacing: '.06em' }}>
              CARE TEAM
            </span>
            <br />
            <strong style={{ fontSize: 16 }}>{praise.text}</strong>
          </span>
        </section>
      )}
    </main>
  );
}
