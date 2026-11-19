import type { ActivityView, AppView, ObservationView, ServiceRequestView, Stop } from '../../shared/types.ts';

// What the patient app derives from the plan: lines, today's stops, follow-ups.

export const DAY = 24 * 60 * 60 * 1000;

/** Hälsa+'s palette: turquoise, orange, lavender, then a few more for bigger plans. */
export const PLAN_COLORS = ['#03D4D1', '#FFA22A', '#B6A7FF', '#FF7EB6', '#7BE495', '#6CB4FF'];

export function startOfDay(time: number) {
  const date = new Date(time);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export function addDays(time: number, days: number) {
  const date = new Date(time);
  date.setDate(date.getDate() + days);
  return date.getTime();
}

const long = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
const short = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });
const weekday = new Intl.DateTimeFormat('en-GB', { weekday: 'short' });
const clock = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' });

export const formatLong = (t: number | string) => long.format(new Date(t));
export const formatShort = (t: number | string) => short.format(new Date(t));
export const formatWeekday = (t: number | string) => weekday.format(new Date(t));
export const formatClock = (t: number | string) => clock.format(new Date(t));

export function activeRequests(view: AppView) {
  return view.requests.filter((r) => !r.status || r.status === 'active');
}

/**
 * A follow-up with the care team is a stop for the whole plan, not a line of
 * its own: drawn as an interchange where all lines meet.
 */
export function isMilestone(activity: ActivityView) {
  return (
    activity.timing.kind === 'events' &&
    activity.stops.length <= 3 &&
    /practitioner|care team|nurse|doctor|vård|läkare|sjuksköt/i.test(activity.performerType ?? '')
  );
}

export interface Lane {
  request: ServiceRequestView;
  activity: ActivityView;
  planTitle: string;
  color: string;
}

function planColors(view: AppView) {
  const colors = new Map<string, string>();
  let i = 0;
  for (const request of activeRequests(view)) {
    for (const plan of request.carePlans) colors.set(`${request.guid}/${plan.id}`, PLAN_COLORS[i++ % PLAN_COLORS.length]);
  }
  return colors;
}

export function planColor(view: AppView, requestGuid: string, planId: string) {
  return planColors(view).get(`${requestGuid}/${planId}`) ?? PLAN_COLORS[0];
}

/** One line per activity the patient does, coloured by its care plan. */
export function lanes(view: AppView): Lane[] {
  const colors = planColors(view);
  return activeRequests(view).flatMap((request) =>
    request.activities
      .filter((a) => !isMilestone(a) && a.stops.length > 0)
      .map((activity) => ({
        request,
        activity,
        planTitle: request.carePlans[activity.planIndex]?.title ?? request.title ?? 'Plan',
        color: colors.get(`${request.guid}/${activity.planId}`) ?? PLAN_COLORS[0],
      })),
  );
}

export function milestones(view: AppView) {
  return activeRequests(view).flatMap((request) =>
    request.activities.filter(isMilestone).flatMap((activity) => activity.stops.map((stop) => ({ request, activity, stop }))),
  );
}

export type StopState = 'done' | 'today' | 'missed' | 'planned';

export function stopState(stop: Stop, today: number): StopState {
  if (stop.performedAt) return 'done';
  const due = Date.parse(stop.dueAt);
  if (due >= today && due < today + DAY) return 'today';
  return due < today ? 'missed' : 'planned';
}

/** The stop on a given local day, if the activity has one then. */
export function stopOn(activity: ActivityView, day: number): Stop | undefined {
  const next = addDays(day, 1);
  return activity.stops.find((s) => {
    const due = Date.parse(s.dueAt);
    return due >= day && due < next;
  });
}

export function planDay(request: ServiceRequestView, time: number) {
  return Math.floor((startOfDay(time) - startOfDay(Date.parse(request.periodStart))) / DAY) + 1;
}

export function planWeeks(request: ServiceRequestView) {
  return Math.max(1, Math.round((Date.parse(request.periodEnd) - Date.parse(request.periodStart)) / (7 * DAY)));
}

export function observationsFor(view: AppView, requestGuid: string, activityKey: string, stopIndex: number): ObservationView[] {
  return view.observations.filter(
    (o) => o.serviceRequestGuid === requestGuid && o.activityKey === activityKey && o.stopIndex === stopIndex,
  );
}

/** Today's stops across every line, in order: what the "Today" screen lists. */
export function todaysStops(view: AppView, today: number) {
  return lanes(view)
    .map((lane) => ({ lane, stop: stopOn(lane.activity, today) }))
    .filter((item): item is { lane: Lane; stop: Stop } => !!item.stop);
}

export function nextStop(view: AppView, today: number) {
  const candidates = lanes(view).flatMap((lane) =>
    lane.activity.stops
      .filter((s) => !s.performedAt && Date.parse(s.dueAt) >= today)
      .slice(0, 1)
      .map((stop) => ({ lane, stop })),
  );
  return candidates.sort((a, b) => Date.parse(a.stop.dueAt) - Date.parse(b.stop.dueAt))[0];
}

export const measureHref = (requestGuid: string, activityKey: string, stopIndex: number) =>
  `#/measure/${encodeURIComponent(requestGuid)}/${encodeURIComponent(activityKey)}/${stopIndex}`;
