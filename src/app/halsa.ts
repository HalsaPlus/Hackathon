import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  HALSA_SERIES,
  type HalsaConsent,
  type HalsaOverview,
  type HalsaPoint,
  type HalsaPoints,
  type HalsaSeries,
  type HalsaVaccination,
  halsaSeriesFor,
  PLAIN_NAMES,
  type RatingScale,
} from '../../shared/halsa.ts';
import type { ObservationView, Transaction } from '../../shared/types.ts';
import { isRating } from './healthkit.ts';

// Hälsa+ in the patient app. For a patient linked to Hälsa+ (server side, see
// server/halsa-link.ts), values the plan asks for come from Hälsa+ instead of
// the simulation in healthkit.ts, ratings are 1–7, and nothing is sent to the
// care team before she has agreed to share her values. Patients without a
// link keep everything as it was.
//
// The demo clock: ?asOf=2026-11-25T08:00:00Z in the app's address moves the
// Hälsa+ values forward (or back). The plan itself follows the real clock.

const DAY = 24 * 60 * 60 * 1000;

/** What one of the server's /api/app/:patient/halsa… endpoints gave. 'unlinked' = 404, no Hälsa+ link. */
export type HalsaLoad<T> =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'unlinked' }
  | { status: 'error'; message: string }
  | { status: 'ready'; data: T };

export type HalsaState = HalsaLoad<HalsaPoints>;

/** ?asOf= from the app's address, as an ISO time, or undefined for the real clock. */
export function demoAsOf(search: string = typeof window === 'undefined' ? '' : window.location.search): string | undefined {
  const raw = new URLSearchParams(search).get('asOf');
  const ms = raw ? Date.parse(raw) : NaN;
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

async function fetchHalsa<T>(url: string, init?: RequestInit): Promise<HalsaLoad<T>> {
  try {
    const response = await fetch(url, { credentials: 'same-origin', ...init });
    if (response.status === 404) return { status: 'unlinked' };
    const data = (await response.json().catch(() => ({}))) as T & { error?: string };
    if (!response.ok) return { status: 'error', message: data.error ?? `The server answered with error ${response.status}.` };
    return { status: 'ready', data };
  } catch {
    return { status: 'error', message: 'Hälsa+ could not be reached.' };
  }
}

/** Loads one of the server's Hälsa+ endpoints. null loads nothing. `reload` fetches it again. */
export function useHalsaJson<T>(url: string | null): HalsaLoad<T> & { reload: () => void; set: (data: T) => void } {
  const [state, setState] = useState<HalsaLoad<T>>({ status: url ? 'loading' : 'idle' });
  const [round, setRound] = useState(0);
  useEffect(() => {
    if (!url) {
      setState({ status: 'idle' });
      return;
    }
    let live = true;
    setState((previous) => (previous.status === 'ready' ? previous : { status: 'loading' }));
    void fetchHalsa<T>(url).then((next) => {
      if (live) setState(next);
    });
    return () => {
      live = false;
    };
  }, [url, round]);
  const reload = useCallback(() => setRound((r) => r + 1), []);
  const set = useCallback((data: T) => setState({ status: 'ready', data }), []);
  return { ...state, reload, set };
}

export const useHalsa = (url: string | null): HalsaState => useHalsaJson<HalsaPoints>(url);

const base = (patientGuid: string) => `/api/app/${encodeURIComponent(patientGuid)}/halsa`;
const withAsOf = (query: Record<string, string> = {}) => {
  const asOf = demoAsOf();
  return new URLSearchParams({ ...query, ...(asOf ? { asOf } : {}) }).toString();
};

/** The latest value of a series, optionally at or before a time. */
export function latestPoint(points: HalsaPoint[], series: HalsaSeries, atOrBefore = Infinity): HalsaPoint | undefined {
  let best: HalsaPoint | undefined;
  for (const point of points) {
    const time = Date.parse(point.time);
    if (point.series !== series || time > atOrBefore) continue;
    if (!best || time >= Date.parse(best.time)) best = point;
  }
  return best;
}

/**
 * The asOf to read a stop's values at: the end of the stop's day, but never
 * later than the demo clock. undefined means "now" (Hälsa+'s own clock).
 */
export function measureAsOf(dueAt: string, asOf: string | undefined, now = Date.now()): string | undefined {
  const endOfDay = new Date(dueAt);
  endOfDay.setHours(23, 59, 59, 999);
  const end = endOfDay.getTime();
  if (asOf) return new Date(Math.min(end, Date.parse(asOf))).toISOString();
  return end < now ? new Date(end).toISOString() : undefined;
}

/** What Hälsa+ says about one of a stop's transactions. undefined: not from Hälsa+. */
export interface HalsaReading {
  series: HalsaSeries;
  label: string;
  /** Set for a 1–7 self-rating. */
  rating?: RatingScale;
  loading: boolean;
  point?: HalsaPoint;
}

export function halsaReading(transaction: Transaction, state: HalsaLoad<HalsaPoints>): HalsaReading | undefined {
  const series = halsaSeriesFor(transaction);
  if (!series || state.status === 'idle' || state.status === 'unlinked') return undefined;
  const { label, rating } = HALSA_SERIES[series];
  const reading = { series, label, rating, loading: state.status === 'loading' };
  return state.status === 'ready' ? { ...reading, point: latestPoint(state.data.points, series) } : reading;
}

/**
 * The value a stop starts with before the patient changes anything. From
 * Hälsa+ when the transaction is read from there (empty if Hälsa+ has no
 * value: a linked patient never gets a simulated one); otherwise exactly as
 * before: the simulation, a rating's default 3, or empty.
 */
export function prefilledValue(transaction: Transaction, reading: HalsaReading | undefined, simulated: string | undefined): string {
  if (reading) return reading.point ? String(reading.point.value) : '';
  return simulated ?? (isRating(transaction.name, transaction.rangeMin, transaction.rangeMax) ? '3' : '');
}

/** The Hälsa+ series in a stop, for one request to /halsa/latest. */
export function useStopHalsa(patientGuid: string, transactions: Transaction[], dueAt: string | undefined): HalsaState {
  const types = [...new Set(transactions.map(halsaSeriesFor).filter((s): s is HalsaSeries => !!s).map((s) => HALSA_SERIES[s].type))].join(',');
  const url = useMemo(() => {
    if (!types || !dueAt) return null;
    const asOf = measureAsOf(dueAt, demoAsOf());
    const query = new URLSearchParams({ type: types, ...(asOf ? { asOf } : {}) });
    return `${base(patientGuid)}/latest?${query}`;
  }, [patientGuid, types, dueAt]);
  return useHalsa(url);
}

/** The last 14 days of every series, for "My data". */
export function useHalsaSeries(patientGuid: string): HalsaState {
  const url = useMemo(() => {
    const asOf = demoAsOf();
    const from = new Date((asOf ? Date.parse(asOf) : Date.now()) - 14 * DAY).toISOString();
    return `${base(patientGuid)}?${withAsOf({ from })}`;
  }, [patientGuid]);
  return useHalsa(url);
}

export function useHalsaOverview(patientGuid: string) {
  const url = useMemo(() => `${base(patientGuid)}/overview?${withAsOf()}`, [patientGuid]);
  return useHalsaJson<HalsaOverview>(url);
}

export function useHalsaVaccinations(patientGuid: string) {
  return useHalsaJson<{ items: HalsaVaccination[] }>(`${base(patientGuid)}/vaccinations`);
}

/** Her consent for one PDHC request. 'unlinked' for a patient without Hälsa+: consent does not apply. */
export function useHalsaConsent(patientGuid: string, requestGuid: string | undefined) {
  const url = requestGuid ? `${base(patientGuid)}/consent/${encodeURIComponent(requestGuid)}` : null;
  const state = useHalsaJson<HalsaConsent>(url);
  const decide = useCallback(
    async (decision: 'accept' | 'decline'): Promise<string | null> => {
      if (!url) return null;
      const result = await fetchHalsa<HalsaConsent>(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision }),
      });
      if (result.status === 'ready') state.set(result.data);
      return result.status === 'error' ? result.message : null;
    },
    [url, state.set],
  );
  return { ...state, decide };
}

/**
 * Whether the Send button is on. Patients without a Hälsa+ link always may
 * send (as before). A linked patient may only after she has agreed. While
 * that is being checked (a moment) the button stays as it was, so patients
 * without a link see no change; the server refuses a report without consent
 * anyway (setupHalsaConsentGuard).
 */
export function maySend(consent: HalsaLoad<HalsaConsent>): boolean {
  if (consent.status === 'ready') return consent.data.decision === 'accept';
  return consent.status !== 'error';
}

/** Writes a 1–7 rating the patient just sent to Hälsa+ too. Resolves to an error message, or null. */
export async function writeRatingToHalsa(patientGuid: string, type: HalsaSeries, value: string): Promise<string | null> {
  const asOf = demoAsOf();
  const url = `${base(patientGuid)}/observations${asOf ? `?asOf=${encodeURIComponent(asOf)}` : ''}`;
  const result = await fetchHalsa(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type, value: Number(value) }),
  });
  return result.status === 'error' ? result.message : null;
}

/** The plan's data in plain words, each once ("CGM glucose, sleep, blood pressure …"), for the consent card. */
export function requestedData(request: { activities: { transactions: Transaction[] }[] }): string[] {
  const names = request.activities.flatMap((a) =>
    a.transactions.map((t) => {
      const series = halsaSeriesFor(t);
      return series ? PLAIN_NAMES[series] : t.name;
    }),
  );
  return [...new Set(names)];
}

/** Where a reported value came in from, for the Today screen. */
export function cameFrom(observations: ObservationView[]): 'Hälsa+' | 'Health' {
  return observations.some((o) => o.device?.startsWith('Hälsa+')) ? 'Hälsa+' : 'Health';
}
