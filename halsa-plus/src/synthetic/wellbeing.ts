// Sleep and steps (smartwatch) and Andrea's self-ratings on a 1–7 scale
// (energy, mood, stress, anxiety daily; depression weekly; entered in the
// Hälsa+ app), 2026-03-01 to the end of the data window.
// SYNTHETIC TEST DATA ONLY. The self-ratings are not a validated instrument.
//
// The scenario's shape: after the move to Paris (separation from home) there
// is some stress from the start. From mid-April, sleep gets shorter, later and
// more broken, she rates stress and anxiety higher, and she misses more days and walks less,
// up to the emergency visit on 2026-08-24. Nothing during the stay. After
// discharge it improves gradually and unevenly. Each night and day has its own
// seed, so it gets the same values on every restart.

import { DAY, DISCHARGE_MS, ER_MS, inHospital, lerp, T_DECLINE, T_DISCHARGE, T_ER } from './history.ts';
import type { RatingType } from './dataset.ts';
import { addDays, clamp, datesBetween, parisTime, randomFor } from './time.ts';

const FIRST_DATE = '2026-03-01';
const dayIndex = (date: string) => (Date.parse(`${date}T00:00:00Z`) - Date.parse(`${FIRST_DATE}T00:00:00Z`)) / DAY;

/** 0 = how she was in early spring, 1 = the days before the emergency visit. */
function strain(t: number) {
  if (t < T_DECLINE) return 0;
  if (t < T_DISCHARGE) return lerp(0, 1, (t - T_DECLINE) / (T_ER - T_DECLINE));
  // After discharge: down gradually, with uneven weeks.
  return clamp(0.7 * Math.exp(-(t - T_DISCHARGE) / 35) + 0.08 * Math.sin((t - T_DISCHARGE) / 4.5), 0, 1);
}

export interface SleepNight {
  bedtime: string;
  wake: string;
  minutes: number;
  awakenings: number;
}

export function generateSleep(lastDate: string, endMs: number): SleepNight[] {
  const nights: SleepNight[] = [];
  // A night is named by the date she wakes up; the first one starts on the evening of 03-01.
  for (const wakeDate of datesBetween(addDays(FIRST_DATE, 1), lastDate)) {
    const { rand, normal } = randomFor(`sleep:${wakeDate}`);
    const f = strain(dayIndex(wakeDate));
    const notWorn = rand() < (dayIndex(wakeDate) < T_DISCHARGE ? 0.04 + 0.3 * f : 0.06);
    const bedMinutes = 23 * 60 + 15 + 120 * f + normal() * 35; // after midnight of the evening before
    const minutes = Math.round(clamp(435 - 80 * f + normal() * 30, 240, 560));
    const awake = 15 + 25 * f + Math.abs(normal()) * 10;
    const awakenings = Math.round(clamp(1 + 2.5 * f + normal() * 0.9, 0, 8));
    const bed = Math.round(parisTime(addDays(wakeDate, -1), bedMinutes) / 60_000) * 60_000;
    const wake = Math.round((bed + (minutes + awake) * 60_000) / 60_000) * 60_000;
    const overlapsStay = bed < DISCHARGE_MS && wake > ER_MS;
    if (notWorn || overlapsStay || wake > endMs) continue;
    nights.push({ bedtime: new Date(bed).toISOString(), wake: new Date(wake).toISOString(), minutes, awakenings });
  }
  return nights;
}

export interface Rating {
  type: RatingType;
  at: string;
  value: number;
}

/** A 1–7 rating: `base` when she is well, `base + swing` at the worst, plus noise. */
const rating = (base: number, swing: number, level: number, noise: number) => Math.round(clamp(base + swing * level + noise * 0.9, 1, 7));

/**
 * Her evening check-in in the app: energy, mood, stress and anxiety every day
 * she remembers it, depression on Sunday evenings (some weeks skipped). All on
 * the 1–7 scale: 1 = not at all … 7 = very much; for energy and mood
 * 1 = very low … 7 = very high.
 */
export function generateRatings(lastDate: string, endMs: number): Rating[] {
  const out: Rating[] = [];
  for (const date of datesBetween(FIRST_DATE, lastDate)) {
    const { rand, normal } = randomFor(`ratings-1to7:${date}`);
    const t = dayIndex(date);
    const f = strain(t);
    // Some stress from the move from the start; more in the decline.
    const level = t < T_DECLINE ? lerp(0.2, 0.3, t / T_DECLINE) : Math.max(0.3 * (t < T_DISCHARGE ? 1 : 0.5), f);
    const missed = rand() < (t < T_DISCHARGE ? 0.08 + 0.45 * f : 0.12);
    const at = Math.round(parisTime(date, 21 * 60 + normal() * 50) / 60_000) * 60_000;
    const values: [RatingType, number][] = [
      ['energy', rating(5.8, -4.2, level, normal())],
      ['mood', rating(5.6, -4, level, normal())],
      ['stress', rating(1.6, 4.8, level, normal())],
      ['anxiety', rating(1.4, 4.4, level, normal())],
    ];
    // Some evenings she answers only part of the check-in.
    const skips = values.map(() => rand() < 0.07);
    const weekly = new Date(`${date}T12:00:00Z`).getUTCDay() === 0;
    const depression = rating(1.3, 4.6, level, normal());
    const skipWeek = rand() < (t < T_DISCHARGE ? 0.15 + 0.3 * f : 0.2);
    if (missed || inHospital(at) || at > endMs) continue;
    const iso = new Date(at).toISOString();
    values.forEach(([type, value], i) => {
      if (!skips[i]) out.push({ type, at: iso, value });
    });
    if (weekly && !skipWeek) out.push({ type: 'depression', at: iso, value: depression });
  }
  return out;
}

export interface StepDay {
  /** The day's total, written when the watch syncs late in the evening. */
  at: string;
  steps: number;
}

/** Steps per day from the smartwatch: active in spring, fewer in the decline, back up unevenly after discharge. */
export function generateSteps(lastDate: string, endMs: number): StepDay[] {
  const out: StepDay[] = [];
  for (const date of datesBetween(FIRST_DATE, lastDate)) {
    const { rand, normal } = randomFor(`steps:${date}`);
    const t = dayIndex(date);
    const f = strain(t);
    const weekend = [0, 6].includes(new Date(`${date}T12:00:00Z`).getUTCDay());
    const notWorn = rand() < (t < T_DISCHARGE ? 0.04 + 0.2 * f : 0.05);
    const steps = Math.round(clamp(9200 - 5600 * f + (weekend ? 1400 : 0) + normal() * 1900, 600, 24000));
    const at = Math.round(parisTime(date, 23 * 60 + 30) / 60_000) * 60_000;
    const dayStart = parisTime(date, 0);
    const touchesStay = dayStart < DISCHARGE_MS && at > ER_MS;
    if (notWorn || touchesStay || at > endMs) continue;
    out.push({ at: new Date(at).toISOString(), steps });
  }
  return out;
}
