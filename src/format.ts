// Dates in Swedish, in the viewer's own time zone.

export const DAY = 24 * 60 * 60 * 1000;

export function startOfDay(time: number) {
  const date = new Date(time);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

const short = new Intl.DateTimeFormat('sv-SE', { day: 'numeric', month: 'short' });
const shortWithYear = new Intl.DateTimeFormat('sv-SE', { day: 'numeric', month: 'short', year: 'numeric' });
const long = new Intl.DateTimeFormat('sv-SE', { weekday: 'long', day: 'numeric', month: 'long' });
const dateTime = new Intl.DateTimeFormat('sv-SE', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const month = new Intl.DateTimeFormat('sv-SE', { month: 'short' });

export const formatShort = (time: number | string) => short.format(new Date(time));
export const formatShortYear = (time: number | string) => shortWithYear.format(new Date(time));
export const formatDateTime = (time: number | string) => dateTime.format(new Date(time));
export const formatMonth = (time: number) => month.format(new Date(time)).replace('.', '');

export function formatLong(time: number | string) {
  const text = long.format(new Date(time));
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function formatRange(from: number, to: number) {
  return `${formatShort(from)} – ${formatShortYear(to)}`;
}

/** ISO week number, as Swedish calendars show it. */
export function isoWeek(time: number) {
  // Work on the local calendar date in UTC, so daylight saving cannot shift it.
  const local = new Date(time);
  const date = new Date(Date.UTC(local.getFullYear(), local.getMonth(), local.getDate()));
  const weekday = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - weekday); // the Thursday of the same week
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
  return Math.ceil(((date.getTime() - yearStart) / DAY + 1) / 7);
}

const PERFORMERS: Record<string, string> = {
  patient: 'Patienten',
  practitioner: 'Vårdpersonal',
  relatedperson: 'Närstående',
};

export function performerLabel(value: string | null) {
  if (!value) return null;
  return PERFORMERS[value.toLowerCase()] ?? value;
}

const REQUIREMENTS: Record<string, string> = {
  required: 'Obligatorisk',
  recommended: 'Rekommenderad',
  optional: 'Valfri',
};

export const requirementLabel = (value: string | undefined) => (value ? (REQUIREMENTS[value] ?? value) : null);

const SOURCES = { push: 'Push från PDHC', poll: 'Hämtad från PDHC', demo: 'Exempel, syntetiska data' } as const;
export const sourceLabel = (value: keyof typeof SOURCES) => SOURCES[value];
