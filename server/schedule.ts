import type { PeriodUnit, Timing } from '../shared/types.ts';

// Turns an activity's timing into the stops on its line: one date per time the
// activity should be done, between the start and end of the plan.

const DAY = 24 * 60 * 60 * 1000;
const UNIT_MS: Record<PeriodUnit, number> = {
  s: 1000,
  min: 60 * 1000,
  h: 60 * 60 * 1000,
  d: DAY,
  wk: 7 * DAY,
  mo: 30.4375 * DAY,
  a: 365.25 * DAY,
};

/** Stops per line the server returns at most. A year of daily stops fits. */
export const MAX_STOPS = 400;

/** If PDHC sends no end date, the plan is drawn this long. */
export const DEFAULT_PLAN_DAYS = 12 * 7;

export function durationMs(value: number | undefined, unit: PeriodUnit | undefined) {
  return (value ?? 0) * UNIT_MS[unit ?? 'd'];
}

function parseDate(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const time = Date.parse(value);
  return Number.isNaN(time) ? undefined : time;
}

/** The longest time any activity says it runs, used when the plan has no end. */
export function longestBounds(timings: Timing[]): number {
  let longest = 0;
  for (const timing of timings) {
    if (timing.kind === 'repeat' && timing.boundsValue) {
      longest = Math.max(longest, durationMs(timing.boundsValue, timing.boundsUnit));
    }
    if (timing.kind === 'repeat' && timing.count && timing.period) {
      const each = durationMs(timing.period, timing.periodUnit) / (timing.frequency || 1);
      longest = Math.max(longest, each * timing.count);
    }
    if (timing.kind === 'once' && timing.offsetValue) {
      longest = Math.max(longest, durationMs(timing.offsetValue, timing.offsetUnit));
    }
  }
  return longest;
}

export function occurrences(timing: Timing, planStart: Date, planEnd: Date): { dates: Date[]; truncated: boolean } {
  const start = planStart.getTime();
  const end = planEnd.getTime();

  switch (timing.kind) {
    case 'unscheduled':
      return { dates: [], truncated: false };

    case 'events': {
      const dates = (timing.events ?? [])
        .map(parseDate)
        .filter((t): t is number => t !== undefined)
        .sort((a, b) => a - b)
        .map((t) => new Date(t));
      return { dates: dates.slice(0, MAX_STOPS), truncated: dates.length > MAX_STOPS };
    }

    case 'once': {
      const due = start + durationMs(timing.offsetValue, timing.offsetUnit);
      return { dates: [new Date(Math.min(due, end))], truncated: false };
    }

    case 'repeat': {
      let step = durationMs(timing.period ?? 1, timing.periodUnit) / Math.max(timing.frequency ?? 1, 1);
      // Continuous monitoring (every minute or so) has no meaningful stops of
      // its own; show one stop per day instead.
      if (step < UNIT_MS.h) step = DAY;

      const from = Math.max(start, parseDate(timing.boundsStart) ?? start);
      let until = Math.min(end, parseDate(timing.boundsEnd) ?? end);
      if (timing.boundsValue) until = Math.min(until, from + durationMs(timing.boundsValue, timing.boundsUnit));

      const limit = Math.min(timing.count ?? Infinity, MAX_STOPS);
      const dates: Date[] = [];
      for (let t = from; t < until && dates.length < limit; t += step) dates.push(new Date(t));
      // A plan shorter than one step still gets its first stop.
      if (dates.length === 0 && from <= until) dates.push(new Date(from));
      const total = Math.floor((until - from) / step) + 1;
      return { dates, truncated: limit === MAX_STOPS && total > MAX_STOPS };
    }
  }
}

// --- In words (Swedish) --------------------------------------------------------

const UNIT_WORDS: Record<PeriodUnit, { one: string; many: string; per: string }> = {
  s: { one: 'sekund', many: 'sekunder', per: 'sekund' },
  min: { one: 'minut', many: 'minuter', per: 'minut' },
  h: { one: 'timme', many: 'timmar', per: 'timme' },
  d: { one: 'dag', many: 'dagar', per: 'dag' },
  wk: { one: 'vecka', many: 'veckor', per: 'vecka' },
  mo: { one: 'månad', many: 'månader', per: 'månad' },
  a: { one: 'år', many: 'år', per: 'år' },
};

function amount(value: number, unit: PeriodUnit | undefined) {
  const words = UNIT_WORDS[unit ?? 'd'];
  return `${value} ${value === 1 ? words.one : words.many}`;
}

function times(frequency: number) {
  if (frequency === 1) return 'En gång';
  if (frequency === 2) return 'Två gånger';
  if (frequency === 3) return 'Tre gånger';
  return `${frequency} gånger`;
}

export function describeTiming(timing: Timing): string {
  switch (timing.kind) {
    case 'unscheduled':
      return 'Inget schema angivet';
    case 'events': {
      const n = timing.events?.length ?? 0;
      return n === 1 ? 'Ett bestämt tillfälle' : `${n} bestämda tillfällen`;
    }
    case 'once':
      return timing.offsetValue ? `En gång, inom ${amount(timing.offsetValue, timing.offsetUnit)}` : 'En gång';
    case 'repeat': {
      const unit = timing.periodUnit ?? 'd';
      const period = timing.period ?? 1;
      const every = period === 1 ? `per ${UNIT_WORDS[unit].per}` : `var ${period}:e ${UNIT_WORDS[unit].one}`;
      let result = `${times(timing.frequency ?? 1)} ${every}`;
      if (timing.boundsValue) result += ` i ${amount(timing.boundsValue, timing.boundsUnit)}`;
      if (timing.count) result += `, högst ${timing.count} gånger`;
      return result;
    }
  }
}
