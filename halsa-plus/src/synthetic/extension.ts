// New device days after the history (from 2026-11-16 up to the end of the data
// window): CGM, home blood pressure and weight. SYNTHETIC TEST DATA ONLY.
//
// The same model as history.ts for the period after discharge: regular CGM wear
// (a new sensor every 14 days, one hour of warm-up), the glucose level settling
// slowly, blood pressure a few times a week, weight on Sundays. Every day has
// its own seed, so a day gets the same values whatever the window's end is.

import {
  baseLevel,
  CGM_OFFSET_MS,
  CGM_RANGE,
  DAY,
  DISCHARGE_MS,
  FIRST_DAY,
  HISTORY,
  round1,
  SENSOR_MS,
  soften,
  weightLevel,
  type History,
} from './history.ts';
import { addDays, clamp, datesBetween, parisDate, parisOffsetMs, parisTime, randomFor } from './time.ts';

const H = 3_600_000;
const SLOT_MS = 15 * 60_000;
const WARM_UP_MS = H;

/** Days since local 2026-03-01 00:00, on the Paris clock (the scale history.ts uses). */
const localDays = (ms: number) => (ms + parisOffsetMs(ms) - FIRST_DAY) / DAY;

interface DayPlan {
  shift: number;
  meals: { hour: number; size: number; skip: number }[];
  lowNight: boolean;
  missedDose: boolean;
}

function dayPlan(date: string): DayPlan {
  const { rand, normal } = randomFor(`cgm-day:${date}`);
  return {
    shift: normal() * 0.9,
    meals: [7.5, 12.5, 19.0].map((h) => ({ hour: h + normal() * 0.5, size: 3.2 + rand() * 3.2, skip: rand() })),
    lowNight: rand() < 0.06,
    missedDose: rand() < 0.03,
  };
}

/**
 * @param lastHistoryGlucose the history's last CGM value: the new series starts
 *   from it and joins its own course over a few hours, so there is no jump at the seam.
 */
export function generateExtension(endMs: number, lastHistoryGlucose: number): History {
  const firstDate = addDays(parisDate(Date.parse(HISTORY.end)), 1); // 2026-11-16
  const lastDate = parisDate(endMs);
  const plans = new Map<string, DayPlan>();
  const plan = (date: string) => {
    let p = plans.get(date);
    if (!p) plans.set(date, (p = dayPlan(date)));
    return p;
  };

  // CGM on the same 15-minute grid as the history; sensors keep the 14-day rhythm from discharge.
  const glucose: History['glucose'] = [];
  const firstSlot = Date.parse(HISTORY.start) + CGM_OFFSET_MS;
  let ms = firstSlot + Math.ceil((Date.parse(HISTORY.end) + 1 - firstSlot) / SLOT_MS) * SLOT_MS;
  const noiseSource = randomFor('cgm-noise:2026-11-16').normal;
  let noise = 0;
  const seamMs = ms;
  let seamOffset: number | undefined;
  for (; ms <= endMs; ms += SLOT_MS) {
    noise = 0.9 * noise + noiseSource() * 0.35;
    const intoSensor = (ms - DISCHARGE_MS) % SENSOR_MS;
    if (intoSensor < WARM_UP_MS) continue;
    const t = localDays(ms);
    const date = parisDate(ms);
    const p = plan(date);
    const hour = (t - Math.floor(t)) * 24;
    let g = baseLevel(t) + p.shift;
    if (hour >= 4 && hour < 7) g += 1.0;
    if (hour >= 1 && hour < 4) g -= p.lowNight ? 5.0 : 1.0;
    const yesterday = plan(addDays(date, -1)).meals.map((m) => ({ ...m, hour: m.hour - 24 }));
    for (const m of [...p.meals, ...yesterday]) {
      if (m.skip < 0.05) continue;
      const dt = (hour - m.hour) * 60;
      if (dt >= 0 && dt < 300) g += m.size * (dt / 60) * Math.exp(1 - dt / 60);
    }
    if (p.missedDose && hour >= 12) g += 5.5 * Math.min(1, (hour - 12) / 3);
    let value = soften(g + noise);
    seamOffset ??= lastHistoryGlucose - value;
    value += seamOffset * Math.exp(-(ms - seamMs) / (2 * H));
    glucose.push({ at: new Date(ms).toISOString(), value: round1(clamp(value, CGM_RANGE.min, CGM_RANGE.max)) });
  }

  const bp: History['bp'] = [];
  const weight: History['weight'] = [];
  for (const date of datesBetween(firstDate, lastDate)) {
    // Blood pressure a few times a week, in the morning.
    const b = randomFor(`bp:${date}`);
    if (b.rand() < 0.45) {
      const at = Math.round(parisTime(date, (7.2 + b.normal() * 0.25) * 60) / 60_000) * 60_000;
      const systolic = Math.round(119 + b.normal() * 5);
      const diastolic = Math.round(77 + 0.5 * (systolic - 119) + b.normal() * 3);
      if (at <= endMs) bp.push({ at: new Date(at).toISOString(), systolic, diastolic });
    }
    // Weight on Sundays at 08:00, slowly and unevenly back up after the summer.
    if (new Date(`${date}T00:00:00Z`).getUTCDay() === 0) {
      const w = randomFor(`weight:${date}`);
      const at = parisTime(date, 8 * 60);
      const weeks = (Date.parse(`${date}T00:00:00Z`) - Date.parse('2026-11-15T00:00:00Z')) / (7 * DAY);
      if (at <= endMs) weight.push({ at: new Date(at).toISOString(), value: round1(weightLevel(localDays(at)) + 0.04 * weeks + w.normal() * 0.2) });
    }
  }
  return { glucose, bp, weight };
}
