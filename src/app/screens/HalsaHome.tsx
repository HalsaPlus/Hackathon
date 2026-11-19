import { useState } from 'react';
import { HALSA_SERIES, type HalsaOverview, type HalsaPoint, type HalsaVaccination, type OverviewCategory, type OverviewMeasure } from '../../../shared/halsa.ts';
import figure from '../assets/halsa-figure.png';
import type { HalsaLoad } from '../halsa.ts';
import { formatClock, formatShort } from '../model.ts';
import { Sparkline } from './Health.tsx';

// The Hälsa+ home for a linked patient: the Health score and the dotted body
// with six category bubbles. A tap on a bubble opens that category alone:
// one card per type with its last 14 days as a graph, or its latest value.
// The scores are computed by Hälsa+ against DEMO ranges (see halsa-plus/README.md).

// Everything is placed in one 360 × 480 coordinate system: the SVG (figure,
// connector lines, dots) uses it as its viewBox, and the bubbles are
// positioned in percent of it, so the whole thing scales together.
const W = 360;
const H = 480;
const IMAGE = { width: 318, height: 1316 };
const SCALE = 470 / IMAGE.height;
const IMAGE_X = (W - IMAGE.width * SCALE) / 2;
const IMAGE_Y = 5;
/** A point on the body, in the image's own pixels. */
const onBody = (x: number, y: number) => ({ x: IMAGE_X + x * SCALE, y: IMAGE_Y + y * SCALE });

const LAYOUT: Record<OverviewCategory['id'], { bubble: { x: number; y: number }; dot: { x: number; y: number } }> = {
  // Left: Lungs, Liver, Hormones.
  lungs: { bubble: { x: 46, y: 95 }, dot: onBody(100, 330) }, // chest, left
  liver: { bubble: { x: 46, y: 205 }, dot: onBody(128, 445) }, // upper abdomen
  hormones: { bubble: { x: 46, y: 315 }, dot: onBody(150, 520) }, // abdomen (pancreas: glucose)
  // Right: Mental health, Heart, Urinary tract.
  'mental-health': { bubble: { x: 314, y: 55 }, dot: onBody(159, 75) }, // head
  heart: { bubble: { x: 314, y: 165 }, dot: onBody(217, 330) }, // chest, right
  'urinary-tract': { bubble: { x: 314, y: 300 }, dot: onBody(159, 612) }, // lower abdomen
};

const percent = (value: number, of: number) => `${(value / of) * 100}%`;
const when = (time: string) => `${formatShort(time)} ${formatClock(time)}`;

function Body({ overview, onOpen }: { overview: HalsaOverview; onOpen: (id: OverviewCategory['id']) => void }) {
  return (
    <div style={{ position: 'relative', width: '100%', maxWidth: 420, margin: '0 auto', aspectRatio: `${W} / ${H}` }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height="100%" aria-hidden="true" style={{ position: 'absolute', inset: 0 }}>
        <image href={figure} x={IMAGE_X} y={IMAGE_Y} width={IMAGE.width * SCALE} height={IMAGE.height * SCALE} />
        {overview.categories.map((c) => {
          const { bubble, dot } = LAYOUT[c.id];
          return (
            <g key={c.id}>
              <line x1={bubble.x} y1={bubble.y} x2={dot.x} y2={dot.y} style={{ stroke: 'rgba(255,255,255,.45)', strokeWidth: 1 }} />
              <circle cx={dot.x} cy={dot.y} r={4} style={{ fill: '#fff', stroke: 'rgba(24,17,68,.9)', strokeWidth: 1.5 }} />
            </g>
          );
        })}
      </svg>
      {overview.categories.map((c) => {
        const { bubble } = LAYOUT[c.id];
        const scored = c.score !== null;
        return (
          <button
            key={c.id}
            type="button"
            onClick={() => onOpen(c.id)}
            aria-label={`${c.name}: ${scored ? `${c.score} %` : 'no data'}. Show details.`}
            style={{
              position: 'absolute',
              left: percent(bubble.x, W),
              top: percent(bubble.y, H),
              width: '18%',
              aspectRatio: '1',
              transform: 'translate(-50%, -50%)',
              borderRadius: '50%',
              border: scored ? 0 : '1.5px solid rgba(255,255,255,.35)',
              background: scored ? 'var(--cyan)' : 'var(--card)',
              color: scored ? 'var(--on-cyan)' : 'var(--muted)',
              font: '700 17px Quicksand, sans-serif',
              cursor: 'pointer',
              padding: 0,
            }}
          >
            {scored ? `${c.score}%` : '–'}
            <span
              aria-hidden="true"
              style={{
                position: 'absolute',
                top: '100%',
                left: '50%',
                transform: 'translateX(-50%)',
                marginTop: 4,
                whiteSpace: 'nowrap',
                font: '600 12px Quicksand, sans-serif',
                color: 'var(--text)',
              }}
            >
              {c.name}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function HalsaHome({ overview, onOpen }: { overview: HalsaLoad<HalsaOverview>; onOpen: (id: OverviewCategory['id']) => void }) {
  if (overview.status === 'loading' || overview.status === 'idle' || overview.status === 'unlinked') return null;
  if (overview.status === 'error') {
    return (
      <section className="card">
        <p className="muted" style={{ margin: 0 }}>
          The Hälsa+ overview could not be read: {overview.message}
        </p>
      </section>
    );
  }
  return (
    <section aria-labelledby="health-score" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ textAlign: 'center' }}>
        <p id="health-score" className="k" style={{ margin: 0 }}>
          Health score
        </p>
        <p style={{ margin: 0, fontSize: 48, fontWeight: 700, lineHeight: 1.1 }}>
          {overview.data.healthScore === null ? '–' : `${overview.data.healthScore}%`}
        </p>
        <p className="muted small" style={{ margin: 0 }}>
          From Hälsa+ · last 14 days · demo ranges
        </p>
      </div>
      <Body overview={overview.data} onOpen={onOpen} />
    </section>
  );
}

type View = 'graph' | 'latest';

/** One type in a category: its 14 days as a graph (default) or its latest value, with a small toggle. */
function MeasureCard({ measure, points }: { measure: OverviewMeasure; points: HalsaPoint[] }) {
  const [view, setView] = useState<View>('graph');
  const lines = measure.series
    .map((series) => ({ series, values: points.filter((p) => p.series === series) }))
    .filter((line) => line.values.length > 0);
  // A graph needs at least two values; with fewer the card shows the latest value.
  const hasGraph = lines.some((line) => line.values.length >= 2);
  const count = lines[0]?.values.length ?? 0;
  const hasLatest = !!measure.latest;
  const shown: View | null = hasGraph && hasLatest ? view : hasGraph ? 'graph' : hasLatest ? 'latest' : null;
  const titleId = `measure-${measure.id}`;

  return (
    <li className="card" aria-labelledby={titleId} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <h3 id={titleId} style={{ margin: 0, fontSize: 17, color: 'var(--cyan)' }}>
          {measure.name}
        </h3>
        {hasGraph && hasLatest && (
          <div className="segmented" role="group" aria-label={`${measure.name}: show`} style={{ fontSize: 12 }}>
            <button type="button" aria-pressed={view === 'latest'} onClick={() => setView('latest')} style={{ minHeight: 28, padding: '0 10px', whiteSpace: 'nowrap' }}>
              Latest
            </button>
            <button type="button" aria-pressed={view === 'graph'} onClick={() => setView('graph')} style={{ minHeight: 28, padding: '0 10px', whiteSpace: 'nowrap' }}>
              14 days
            </button>
          </div>
        )}
      </div>

      {shown === null && <span className="muted">No data available</span>}

      {shown === 'latest' && measure.latest && (
        <>
          <span style={{ fontSize: 26, fontWeight: 700 }}>
            {measure.latest.value}
            <span className="muted" style={{ fontSize: 14, fontWeight: 600 }}>
              {' '}
              {measure.latest.unit ?? ''}
            </span>
          </span>
          <span className="muted small">
            {when(measure.latest.time)} · From Hälsa+{measure.latest.device ? ` · ${measure.latest.device}` : ''}
            {measure.latest.status === 'preliminary' ? ' · preliminary' : ''}
          </span>
          {!hasGraph && (
            <span className="muted small">
              {count === 0 ? 'No values in the last 14 days' : `Only ${count} value in the last 14 days, too few for a graph`}
            </span>
          )}
        </>
      )}

      {shown === 'graph' &&
        lines.map(({ series, values }) => {
          const band = measure.bands.find((b) => b.series === series);
          return (
            <div key={series} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              {lines.length > 1 && <span className="muted small">{HALSA_SERIES[series].label}</span>}
              <Sparkline values={values.map((p) => p.value)} low={band?.low} high={band?.high} color="#03D4D1" />
            </div>
          );
        })}
      {shown === 'graph' && (
        <span className="muted small">
          {count} values · last 14 days
          {measure.range ? ` · demo range ${measure.range}` : ''}
        </span>
      )}
    </li>
  );
}

/** One category alone: its types only, one card each. Back returns to the figure. */
export function CategoryView({ category, points, onBack }: { category: OverviewCategory; points: HalsaPoint[]; onBack: () => void }) {
  return (
    <section aria-labelledby="category-title" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <button type="button" className="back" onClick={onBack} style={{ background: 'none', border: 0, padding: 0, textAlign: 'left', cursor: 'pointer' }}>
        ← Back to the body
      </button>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <h2 id="category-title" style={{ fontSize: 22 }}>
          {category.name}
        </h2>
        <span className={category.score === null ? 'chip plain' : 'chip'}>{category.score === null ? 'No score' : `${category.score}%`}</span>
      </div>
      <p className="muted" style={{ margin: 0 }}>
        Available data: {category.available}/{category.total}
      </p>
      <ul className="list" style={{ gap: 10 }}>
        {category.measures.map((m) => (
          <MeasureCard key={m.id} measure={m} points={points} />
        ))}
      </ul>
    </section>
  );
}

export function Vaccinations({ vaccinations }: { vaccinations: HalsaLoad<{ items: HalsaVaccination[] }> }) {
  if (vaccinations.status !== 'ready' || vaccinations.data.items.length === 0) return null;
  const items = [...vaccinations.data.items].sort((a, b) => b.date.localeCompare(a.date));
  return (
    <section className="card" aria-labelledby="vaccinations" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <h2 id="vaccinations" className="k">
          Vaccinations
        </h2>
        <span className="chip lavender">Synthetic</span>
      </div>
      <ul className="list" style={{ gap: 8 }}>
        {items.map((v) => (
          <li key={v.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
            <span>
              <span style={{ fontWeight: 600 }}>{v.vaccine}</span>
              <br />
              <span className="muted small">
                {v.dose} · {v.givenAt}
              </span>
            </span>
            <span className="muted small" style={{ whiteSpace: 'nowrap' }}>
              {new Date(`${v.date}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
