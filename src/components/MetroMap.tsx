import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { ServiceRequestView } from '../../shared/types.ts';
import { DAY, formatMonth, formatShort, isoWeek, startOfDay } from '../format.ts';
import { buildLines, chooseGrouping, type Line, STATE_LABEL, type Station } from '../metro.ts';

// The care plan as a metro map. Time runs left to right. Every activity is a
// line that leaves the Start station, runs through its stops and arrives at
// the Goal station. Stops are drawn by state: done, today, coming, missed.

export const lineColor = (index: number) => `var(--line-${index % 6})`;

const MIN_WIDTH = 760;
const MIN_STATION_GAP = 26;
const BUNDLE_GAP = 10;
const TOP = 60;
const EDGE = 44;

interface Props {
  request: ServiceRequestView;
  selectedId: string | null;
  onSelect: (line: Line, station: Station) => void;
}

function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(MIN_WIDTH);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.round(entry.contentRect.width)));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

function StationMark({ station, color }: { station: Station; color: string }) {
  switch (station.state) {
    case 'done':
      return (
        <>
          <circle r={8} style={{ fill: color }} />
          <path d="M-3.6 0.2 L-1.1 2.7 L3.8 -2.4" className="check" />
        </>
      );
    case 'today':
      return (
        <>
          <circle r={14} className="pulse" style={{ fill: color }} />
          <circle r={8.5} className="station-fill" style={{ stroke: color }} strokeWidth={4} />
          <circle r={3} style={{ fill: color }} />
        </>
      );
    case 'partial': {
      const fraction = station.doneCount / station.stops.length;
      const angle = fraction * 2 * Math.PI;
      const r = 6.5;
      const x = r * Math.sin(angle);
      const y = -r * Math.cos(angle);
      return (
        <>
          <circle r={8} className="station-fill" style={{ stroke: color }} strokeWidth={3} />
          <path d={`M0 0 L0 ${-r} A${r} ${r} 0 ${fraction > 0.5 ? 1 : 0} 1 ${x} ${y} Z`} style={{ fill: color }} />
        </>
      );
    }
    case 'missed':
      return <circle r={7} className="station-fill missed" strokeWidth={3} strokeDasharray="3.2 2.3" />;
    case 'planned':
      return <circle r={7} className="station-fill" style={{ stroke: color }} strokeWidth={3} />;
  }
}

export function MetroMap({ request, selectedId, onSelect }: Props) {
  const [wrapperRef, measured] = useWidth();
  const today = startOfDay(Date.now());

  const layout = useMemo(() => {
    const n = Math.max(request.activities.length, 1);
    const laneGap = n > 5 ? 54 : 68;
    const laneY = (i: number) => TOP + i * laneGap;
    const midY = (laneY(0) + laneY(n - 1)) / 2;
    const bundleY = (i: number) => midY + (i - (n - 1) / 2) * BUNDLE_GAP;
    const maxDy = Math.max(...Array.from({ length: n }, (_, i) => Math.abs(laneY(i) - bundleY(i))));
    const fan = 26 + maxDy;
    const width = Math.max(measured, MIN_WIDTH, 2 * (EDGE + 16 + fan) + 360);

    const xStart = EDGE;
    const xEnd = width - EDGE;
    const x0 = xStart + 16 + fan;
    const x1 = xEnd - 16 - fan;
    const start = Date.parse(request.periodStart);
    const end = Date.parse(request.periodEnd);
    const xOf = (time: number) => x0 + (Math.min(Math.max(time, start), end) - start) / Math.max(end - start, 1) * (x1 - x0);

    const groupDays = chooseGrouping(request, Math.floor((x1 - x0) / MIN_STATION_GAP));
    const lines = buildLines(request, groupDays, today);
    const axisY = laneY(n - 1) + 58;

    // Grid: weeks for short plans, months for long ones.
    const ticks: { x: number; label: string }[] = [];
    const spanDays = (end - start) / DAY;
    if (spanDays <= 120) {
      // Step with setDate, not with 7 × 24 h, so daylight saving time does not
      // push a tick onto the Sunday before.
      const monday = new Date(startOfDay(start));
      monday.setDate(monday.getDate() + ((8 - monday.getDay()) % 7));
      for (; monday.getTime() <= end; monday.setDate(monday.getDate() + 7)) {
        ticks.push({ x: xOf(monday.getTime()), label: `v.${isoWeek(monday.getTime())}` });
      }
    } else {
      const first = new Date(start);
      const month = new Date(first.getFullYear(), first.getMonth() + 1, 1);
      for (; month.getTime() <= end; month.setMonth(month.getMonth() + 1)) {
        const t = month.getTime();
        ticks.push({ x: xOf(t), label: month.getMonth() === 0 ? `${formatMonth(t)} ${month.getFullYear()}` : formatMonth(t) });
      }
    }

    return { n, laneY, bundleY, width, height: axisY + 30, xStart, xEnd, x0, x1, start, end, xOf, lines, axisY, ticks, groupDays };
  }, [request, measured, today]);

  const { n, laneY, bundleY, width, height, xStart, xEnd, x0, x1, start, end, xOf, lines, axisY, ticks, groupDays } = layout;
  // A line counts as running from Start (or to the Goal) if its first (or
  // last) stop is within one step of it, so a weekly line reaches the Goal.
  const near = (Math.max(groupDays, 7) + 1) * DAY;
  const now = Date.now();
  const showToday = now >= start && now <= end;

  // On a narrow screen the map scrolls sideways; open it with today in view.
  const todayX = showToday ? xOf(now) : null;
  useEffect(() => {
    const element = wrapperRef.current;
    if (!element || todayX === null || element.scrollWidth <= element.clientWidth) return;
    element.scrollLeft = Math.max(0, todayX - element.clientWidth / 2);
    // Only when the plan or the width changes, not on every render.
  }, [request.guid, width]);

  const select = (line: Line, station: Station) => onSelect(line, station);
  const onKey = (event: KeyboardEvent, line: Line, station: Station) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      select(line, station);
    }
  };

  const groupHint =
    groupDays === 0
      ? undefined
      : `Dense lines show one stop per ${groupDays === 7 ? 'week' : `${groupDays} days`}.`;

  return (
    <div className="metro-wrap">
    <div className="metro-scroll" ref={wrapperRef}>
      <svg
        className="metro"
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="group"
        aria-label={`The care plan as a metro map, ${formatShort(start)} to ${formatShort(end)}`}
      >
        {/* Grid and time axis */}
        {ticks.map((tick) => (
          <g key={tick.x}>
            <line x1={tick.x} x2={tick.x} y1={TOP - 34} y2={axisY - 16} className="grid" />
            <text x={tick.x} y={axisY} className="axis-label" textAnchor="middle">
              {tick.label}
            </text>
          </g>
        ))}

        {/* Today */}
        {showToday && (
          <g className="today-marker">
            <line x1={xOf(now)} x2={xOf(now)} y1={30} y2={axisY - 16} />
            <rect x={xOf(now) - 24} y={8} width={48} height={22} rx={11} />
            <text x={xOf(now)} y={23} textAnchor="middle">
              Today
            </text>
          </g>
        )}

        {/* Lines: a faint track from Start to Goal, solid where the activity runs */}
        {lines.map((line) => {
          const i = line.index;
          const color = lineColor(i);
          const bY = bundleY(i);
          const lY = laneY(i);
          const a = Math.abs(lY - bY);
          const track = `M${xStart} ${bY} H${x0 - a} L${x0} ${lY} H${x1} L${x1 + a} ${bY} H${xEnd}`;
          let solid = '';
          if (line.firstTime !== null && line.lastTime !== null) {
            const fromStart = line.firstTime - start < near;
            const toEnd = end - line.lastTime < near;
            solid = fromStart ? `M${xStart} ${bY} H${x0 - a} L${x0} ${lY}` : `M${xOf(line.firstTime)} ${lY}`;
            solid += ` H${toEnd ? x1 : xOf(line.lastTime)}`;
            if (toEnd) solid += ` L${x1 + a} ${bY} H${xEnd}`;
          }
          return (
            <g key={line.activity.key}>
              <path d={track} className="track" style={{ stroke: color }} />
              {solid && <path d={solid} className="line" style={{ stroke: color }} />}
            </g>
          );
        })}

        {/* Line names */}
        {lines.map((line) => (
          <g key={`label-${line.activity.key}`} transform={`translate(${x0} ${laneY(line.index) - 24})`} className="lane-label">
            <circle r={10} style={{ fill: lineColor(line.index) }} />
            <text className="lane-number" textAnchor="middle" y={4}>
              {line.index + 1}
            </text>
            <text className="lane-title" x={17} y={5}>
              {line.activity.title}
              <tspan className="lane-schedule"> · {line.activity.schedule}</tspan>
            </text>
          </g>
        ))}

        {/* Start and Goal */}
        {[
          { x: xStart, title: 'Start', date: start },
          { x: xEnd, title: 'Goal', date: end },
        ].map((terminal) => (
          <g key={terminal.title} className="terminal">
            <rect
              x={terminal.x - 11}
              y={bundleY(0) - 11}
              width={22}
              height={(n - 1) * BUNDLE_GAP + 22}
              rx={11}
            />
            <text x={terminal.x} y={bundleY(n - 1) + 32} textAnchor="middle" className="terminal-title">
              {terminal.title}
            </text>
            <text x={terminal.x} y={bundleY(n - 1) + 48} textAnchor="middle" className="terminal-date">
              {formatShort(terminal.date)}
            </text>
          </g>
        ))}

        {/* Stations */}
        {lines.map((line) =>
          line.stations.map((station) => {
            const selected = station.id === selectedId;
            const label = `${line.activity.title}, ${station.label}: ${STATE_LABEL[station.state]}${
              station.stops.length > 1 ? `, ${station.doneCount} of ${station.stops.length} done` : ''
            }`;
            return (
              <g
                key={station.id}
                className={`station state-${station.state}${selected ? ' selected' : ''}`}
                transform={`translate(${xOf(station.time)} ${laneY(line.index)})`}
                role="button"
                tabIndex={0}
                aria-label={label}
                aria-pressed={selected}
                onClick={() => select(line, station)}
                onKeyDown={(event) => onKey(event, line, station)}
              >
                <title>{label}</title>
                <circle r={15} className="hit" />
                <circle r={14} className="ring" />
                <StationMark station={station} color={lineColor(line.index)} />
              </g>
            );
          }),
        )}
      </svg>
    </div>
    <MetroLegend groupHint={groupHint} />
    </div>
  );
}

/** The key under the map. */
export function MetroLegend({ groupHint }: { groupHint?: string }) {
  const items: { state: Station['state']; text: string }[] = [
    { state: 'done', text: 'Done' },
    { state: 'today', text: 'Today' },
    { state: 'planned', text: 'Coming' },
    { state: 'partial', text: 'Partly done' },
    { state: 'missed', text: 'Missed' },
  ];
  return (
    <ul className="legend" aria-label="Key">
      {items.map((item) => (
        <li key={item.state}>
          <svg width={24} height={24} viewBox="-12 -12 24 24" aria-hidden="true" className="metro">
            <g className={`station state-${item.state}`}>
              <StationMark
                station={{ id: '', activityKey: '', stops: [{ index: 0, dueAt: '', performedAt: null }, { index: 1, dueAt: '', performedAt: null }], time: 0, label: '', state: item.state, doneCount: 1 }}
                color="var(--legend-line)"
              />
            </g>
          </svg>
          {item.text}
        </li>
      ))}
      {groupHint && <li className="legend-hint">{groupHint}</li>}
    </ul>
  );
}
