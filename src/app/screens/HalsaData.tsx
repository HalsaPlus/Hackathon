import { type ReactNode, useState } from 'react';
import { HALSA_SERIES, type HalsaPoint, type HalsaSeries, halsaDevice, halsaSeriesFor, type OverviewCategory } from '../../../shared/halsa.ts';
import type { ScreenProps } from '../App.tsx';
import { useHalsaOverview, useHalsaSeries, useHalsaVaccinations } from '../halsa.ts';
import { formatClock, formatShort, lanes } from '../model.ts';
import { CategoryView, HalsaHome, Vaccinations } from './HalsaHome.tsx';
import { Sparkline } from './Health.tsx';

// "My data" for a patient linked to Hälsa+. The main view: the Hälsa+ home
// (Health score and body figure), then the last 14 days of every series in
// the same cards as the values reported in MMD, then her vaccinations. A tap
// on a bubble shows that category alone (CategoryView), without the feed;
// back returns to the figure. Patients without a link get `fallback` (MMD's
// own list), unchanged.

const when = (time: string) => `${formatShort(time)} ${formatClock(time)}`;

export function HalsaData({ view, patientGuid, fallback }: Pick<ScreenProps, 'view' | 'patientGuid'> & { fallback: ReactNode }) {
  const state = useHalsaSeries(patientGuid);
  const overview = useHalsaOverview(patientGuid);
  const vaccinations = useHalsaVaccinations(patientGuid);
  const [open, setOpen] = useState<OverviewCategory['id'] | null>(null);
  const show = (id: OverviewCategory['id'] | null) => {
    setOpen(id);
    window.scrollTo(0, 0);
  };

  if (state.status === 'idle' || state.status === 'unlinked') return fallback;
  if (state.status === 'loading') {
    return (
      <section className="card">
        <p className="muted" style={{ margin: 0 }}>
          Reading your values from Hälsa+ …
        </p>
      </section>
    );
  }
  if (state.status === 'error') {
    return (
      <section className="card">
        <h2>Hälsa+ could not be read</h2>
        <p className="muted">{state.message}</p>
      </section>
    );
  }

  const category = open && overview.status === 'ready' ? overview.data.categories.find((c) => c.id === open) : undefined;
  if (category) return <CategoryView category={category} points={state.data.points} onBack={() => show(null)} />;

  // The plan's range and line colour for each series it asks for.
  const ranges = new Map<HalsaSeries, { low?: number; high?: number; color: string }>();
  for (const lane of lanes(view)) {
    for (const t of lane.activity.transactions) {
      const series = halsaSeriesFor(t);
      if (series && !ranges.has(series)) ranges.set(series, { low: t.rangeMin, high: t.rangeMax, color: lane.color });
    }
  }
  const bySeries = new Map<HalsaSeries, HalsaPoint[]>();
  for (const point of state.data.points) bySeries.set(point.series, [...(bySeries.get(point.series) ?? []), point]);
  const shown = (Object.keys(HALSA_SERIES) as HalsaSeries[]).filter((s) => bySeries.has(s));

  if (shown.length === 0) {
    return (
      <>
        <HalsaHome overview={overview} onOpen={show} />
        <section className="card">
          <h2>Nothing from Hälsa+ yet</h2>
          <p className="muted">Hälsa+ has no values from the last 14 days.</p>
        </section>
        <Vaccinations vaccinations={vaccinations} />
      </>
    );
  }

  return (
    <>
    <HalsaHome overview={overview} onOpen={show} />
    <h2 className="k" style={{ margin: '8px 0 0' }}>
      Last 14 days
    </h2>
    <ul className="list" style={{ gap: 12 }}>
      {shown.map((series) => {
        const info = HALSA_SERIES[series];
        const list = bySeries.get(series)!;
        const latest = list.at(-1)!;
        const numbers = list.map((p) => p.value);
        const average = numbers.reduce((a, b) => a + b, 0) / numbers.length;
        const range = ranges.get(series);
        const color = range?.color ?? '#03D4D1';
        const unit = (p: HalsaPoint) => (info.rating ? `of ${info.rating.max}` : (p.unit ?? ''));
        return (
          <li key={series} className="card" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
              <h2 style={{ color }}>{info.label}</h2>
              <span className="chip plain">Hälsa+</span>
            </div>
            <div style={{ fontSize: 24, fontWeight: 700 }}>
              {latest.value}
              <span className="muted" style={{ fontSize: 14, fontWeight: 600 }}>
                {' '}
                {unit(latest)} · latest{latest.status === 'preliminary' ? ' · preliminary' : ''}
              </span>
            </div>
            <Sparkline values={numbers} low={range?.low} high={range?.high} color={color} />
            <span className="muted small">
              {numbers.length > 1 ? `Average ${average.toFixed(1)} over ${numbers.length} values · ` : ''}
              {info.rating ? 'Patient reported · ' : ''}
              From {halsaDevice(latest)}
            </span>
            <ul className="list" style={{ gap: 2 }} aria-label={`Latest ${info.label.toLowerCase()} values`}>
              {list
                .slice(-3)
                .reverse()
                .map((p) => (
                  <li key={`${p.time}-${p.value}`} className="small" style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                    <span className="muted">
                      {when(p.time)} · {p.device ?? 'Hälsa+'}
                    </span>
                    <strong>
                      {p.value} {unit(p)}
                    </strong>
                  </li>
                ))}
            </ul>
          </li>
        );
      })}
    </ul>
    <Vaccinations vaccinations={vaccinations} />
    </>
  );
}
