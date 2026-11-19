// Sleep (smartwatch) and Andrea's daily self-ratings of anxiety and stress (0–10,
// entered in the Hälsa+ app), 2026-03-01 to the end of the data window.
// SYNTHETIC TEST DATA ONLY. The self-ratings are not a validated instrument.
//
// The scenario's shape: after the move to Paris (separation from home) there
// is some stress from the start. From mid-April, sleep gets shorter, later and
// more broken, she rates stress and anxiety higher, and she misses more days,
// up to the emergency visit on 2026-08-24. Nothing during the stay. After
// discharge it improves gradually and unevenly. Each night and day has its own
// seed, so it gets the same values on every restart.

import { DAY, DISCHARGE_MS, ER_MS, inHospital, lerp, T_DECLINE, T_DISCHARGE, T_ER } from './history.ts';
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
  type: 'anxiety' | 'stress';
  at: string;
  value: number;
}

export function generateRatings(lastDate: string, endMs: number): Rating[] {
  const out: Rating[] = [];
  for (const date of datesBetween(FIRST_DATE, lastDate)) {
    const { rand, normal } = randomFor(`ratings:${date}`);
    const t = dayIndex(date);
    const f = strain(t);
    // Some stress from the move from the start; more in the decline.
    const level = t < T_DECLINE ? lerp(0.2, 0.3, t / T_DECLINE) : Math.max(0.3 * (t < T_DISCHARGE ? 1 : 0.5), f);
    const missed = rand() < (t < T_DISCHARGE ? 0.08 + 0.45 * f : 0.12);
    const onlyStress = rand() < 0.08;
    const at = Math.round(parisTime(date, 21 * 60 + normal() * 50) / 60_000) * 60_000;
    const stress = Math.round(clamp(2.5 + 5.5 * level + normal() * 1.2, 0, 10));
    const anxiety = Math.round(clamp(2 + 5 * level + normal() * 1.2, 0, 10));
    if (missed || inHospital(at) || at > endMs) continue;
    const iso = new Date(at).toISOString();
    if (!onlyStress) out.push({ type: 'anxiety', at: iso, value: anxiety });
    out.push({ type: 'stress', at: iso, value: stress });
  }
  return out;
}
