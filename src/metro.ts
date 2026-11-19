import type { ActivityView, ServiceRequestView, Stop } from '../shared/types.ts';
import { DAY, formatLong, formatShort, isoWeek, startOfDay } from './format.ts';

// Turns a care plan into stations on lines. Pure functions, no drawing.
//
// When a line has more stops than fit, stops are grouped (per week, two weeks,
// four weeks …) and one station stands for the whole group. All lines in a
// plan use the same grouping so they read the same way.

export type StationState = 'done' | 'partial' | 'missed' | 'today' | 'planned';

export interface Station {
  id: string;
  activityKey: string;
  stops: Stop[];
  time: number;
  label: string;
  state: StationState;
  doneCount: number;
}

export interface Line {
  activity: ActivityView;
  index: number;
  stations: Station[];
  firstTime: number | null;
  lastTime: number | null;
}

const BUCKETS = [7, 14, 28, 91, 182, 365];

/** The number of days per station, or 0 when every stop gets its own. */
export function chooseGrouping(request: ServiceRequestView, maxStations: number): number {
  const most = Math.max(0, ...request.activities.map((a) => a.stops.length));
  if (most <= maxStations) return 0;
  const spanDays = (Date.parse(request.periodEnd) - Date.parse(request.periodStart)) / DAY;
  return BUCKETS.find((days) => Math.ceil(spanDays / days) <= maxStations) ?? BUCKETS.at(-1)!;
}

export function stationState(stops: Stop[], today: number): StationState {
  const tomorrow = today + DAY;
  const done = stops.filter((s) => s.performedAt).length;
  if (done === stops.length) return 'done';
  if (stops.some((s) => !s.performedAt && Date.parse(s.dueAt) >= today && Date.parse(s.dueAt) < tomorrow)) return 'today';
  if (stops.every((s) => Date.parse(s.dueAt) >= tomorrow)) return 'planned';
  return done > 0 ? 'partial' : 'missed';
}

export const STATE_LABEL: Record<StationState, string> = {
  done: 'Done',
  partial: 'Partly done',
  missed: 'Missed',
  today: 'Today',
  planned: 'Coming',
};

export function buildLines(request: ServiceRequestView, groupDays: number, today: number): Line[] {
  const start = Date.parse(request.periodStart);
  return request.activities.map((activity, index) => {
    const groups = new Map<number, Stop[]>();
    for (const stop of activity.stops) {
      const key = groupDays ? Math.floor((Date.parse(stop.dueAt) - start) / (groupDays * DAY)) : stop.index;
      const group = groups.get(key);
      if (group) group.push(stop);
      else groups.set(key, [stop]);
    }

    const stations: Station[] = [...groups.entries()].map(([key, stops]) => {
      const times = stops.map((s) => Date.parse(s.dueAt));
      const first = Math.min(...times);
      const last = Math.max(...times);
      let label: string;
      if (stops.length === 1) label = formatLong(first);
      else if (groupDays === 7) label = `Week ${isoWeek(first)}, ${formatShort(first)} – ${formatShort(last)}`;
      else label = `${formatShort(first)} – ${formatShort(last)}`;
      return {
        id: `${activity.key}:${key}`,
        activityKey: activity.key,
        stops,
        time: stops.length === 1 ? first : (first + last) / 2,
        label,
        state: stationState(stops, today),
        doneCount: stops.filter((s) => s.performedAt).length,
      };
    });

    const times = activity.stops.map((s) => Date.parse(s.dueAt));
    return {
      activity,
      index,
      stations,
      firstTime: times.length ? Math.min(...times) : null,
      lastTime: times.length ? Math.max(...times) : null,
    };
  });
}

/** The next stop that is not done, today or later. */
export function nextStop(activity: ActivityView, today: number): Stop | undefined {
  return activity.stops.find((s) => !s.performedAt && Date.parse(s.dueAt) >= today);
}

export function progress(activity: ActivityView, today: number) {
  const tomorrow = startOfDay(today) + DAY;
  const due = activity.stops.filter((s) => Date.parse(s.dueAt) < tomorrow);
  return {
    done: activity.stops.filter((s) => s.performedAt).length,
    dueSoFar: due.length,
    missed: due.filter((s) => !s.performedAt && Date.parse(s.dueAt) < today).length,
    total: activity.stops.length,
  };
}
