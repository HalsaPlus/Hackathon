// Andrea's device history 2026-03-01 .. 2026-11-15: CGM glucose, home blood
// pressure and weight. SYNTHETIC TEST DATA ONLY.
//
// This is a TypeScript copy of generate() in the Hälsa+ demo's
// scripts/build-device-data.mjs (repo Halsa-plus-demo), with the same seed,
// scenario and order of random draws, so the values are identical. A test
// checks that with a checksum of the original's output. Do not change the
// logic here: newer days are generated in extension.ts.
//
// The scenario: Andrea has lived in Paris since 2026-02-01. From mid-April she
// replaces CGM sensors later and later, skips meals and misses doses, and her
// glucose rises until she is taken to an emergency department in Paris on the
// evening of 2026-08-24. There are no readings during the stay. Discharge on
// 2026-08-27 15:00 is a scenario assumption. After that she measures regularly.

const H = 3_600_000;
export const DAY = 86_400_000;

/** Paris offset from UTC in hours: CET (+1), CEST (+2) from 2026-03-29 01:00Z to 2026-10-25 01:00Z. */
const parisOffset = (ms: number) => (ms >= Date.parse('2026-03-29T01:00:00Z') && ms < Date.parse('2026-10-25T01:00:00Z') ? 2 : 1);

/** UTC instant of a Paris wall-clock time "YYYY-MM-DD HH:MM" in 2026 (not at a clock change). */
export function paris(local: string) {
  const [y, mo, d, hh, mm] = local.split(/[-: ]/).map(Number);
  const wall = Date.UTC(y, mo - 1, d, hh, mm);
  return wall - parisOffset(wall - 2 * H) * H;
}

export const FIRST_DAY = Date.UTC(2026, 2, 1); // 2026-03-01, local
const LAST_DAY = Date.UTC(2026, 10, 15); // 2026-11-15, local
const ymd = (wallMs: number) => new Date(wallMs).toISOString().slice(0, 10);
const localMidnight = (d: number) => paris(`${ymd(FIRST_DAY + d * DAY)} 00:00`);
const DAYS = Math.round((LAST_DAY - FIRST_DAY) / DAY) + 1;

/** The history's period: local 2026-03-01 00:00 to local 2026-11-15 23:59:59.999 (Paris). */
export const HISTORY = { start: new Date(localMidnight(0)).toISOString(), end: new Date(localMidnight(DAYS) - 1).toISOString() };

export const SCENARIO = {
  movedToParis: '2026-02-01',
  declineFrom: '2026-04-15',
  emergency: '2026-08-24 19:30',
  discharge: '2026-08-27 15:00', // SCENARIO ASSUMPTION
};
export const ER_MS = paris(SCENARIO.emergency);
export const DISCHARGE_MS = paris(SCENARIO.discharge);

const WARM_UP_MS = 1 * H;
export const SENSOR_MS = 14 * DAY;
const SENSOR_SESSIONS = (() => {
  const fixed = [
    ['2026-02-24 08:00', '2026-03-10 08:00'],
    ['2026-03-10 08:00', '2026-03-24 08:00'],
    ['2026-03-24 08:00', '2026-04-07 08:00'],
    ['2026-04-07 08:00', '2026-04-21 08:00'],
    ['2026-04-22 21:00', '2026-05-06 21:00'],
    ['2026-05-09 22:00', '2026-05-23 22:00'],
    ['2026-05-28 21:00', '2026-06-11 21:00'],
    ['2026-06-19 22:00', '2026-07-03 22:00'],
    ['2026-07-15 21:00', '2026-07-29 21:00'],
    ['2026-08-11 22:00', SCENARIO.emergency],
  ].map(([on, off]) => ({ on: paris(on), off: paris(off) }));
  const after = [];
  for (let on = DISCHARGE_MS; on <= Date.parse(HISTORY.end); on += SENSOR_MS) after.push({ on, off: on + SENSOR_MS });
  return [...fixed, ...after];
})();

export const CGM_OFFSET_MS = 7 * 60_000;
const SEED = 20260301;
export const CGM_RANGE = { min: 2.2, max: 22.2 };

// --- deterministic randomness ----------------------------------------------

export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function normalFrom(rand: () => number) {
  return () => {
    const u = Math.max(rand(), 1e-12);
    const v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
}

export const round1 = (x: number) => Math.round(x * 10) / 10;
const iso = (ms: number) => new Date(ms).toISOString();
const wallMs = (ms: number) => ms + parisOffset(ms) * H;
const localDays = (ms: number) => (wallMs(ms) - FIRST_DAY) / DAY;
const dayOf = (date: string) => (Date.parse(`${date}T00:00:00Z`) - FIRST_DAY) / DAY;
export const lerp = (a: number, b: number, f: number) => a + (b - a) * Math.min(1, Math.max(0, f));

export const T_DECLINE = dayOf(SCENARIO.declineFrom);
const T_LATE = dayOf('2026-08-15');
export const T_ER = localDays(ER_MS);
export const T_DISCHARGE = localDays(DISCHARGE_MS);
export const inHospital = (ms: number) => ms >= ER_MS && ms < DISCHARGE_MS;

/** The level glucose varies around before meals, in mmol/L. */
export function baseLevel(t: number) {
  if (t < T_DECLINE) return 9.2;
  if (t < T_LATE) return lerp(9.2, 15.0, (t - T_DECLINE) / (T_LATE - T_DECLINE));
  if (t < T_DISCHARGE) return lerp(15.0, 18.5, (t - T_LATE) / (T_ER - T_LATE));
  return 9.4 + 2.1 * Math.exp(-(t - T_DISCHARGE) / 20);
}
function skipMeal(t: number) {
  if (t < T_DECLINE) return 0;
  if (t < T_LATE) return lerp(0, 0.45, (t - T_DECLINE) / (T_LATE - T_DECLINE));
  if (t < T_DISCHARGE) return 0.5;
  return 0.05;
}
function takeBp(t: number) {
  if (t < T_DECLINE) return 0.95;
  if (t < dayOf('2026-08-01')) return lerp(0.95, 0.07, (t - T_DECLINE) / (dayOf('2026-08-01') - T_DECLINE));
  if (t < T_DISCHARGE) return 0.07;
  return 0.9;
}
export function weightLevel(t: number) {
  if (t < T_DECLINE) return 62.0;
  if (t < T_DISCHARGE) return lerp(62.0, 59.6, (t - T_DECLINE) / (dayOf('2026-08-23') - T_DECLINE));
  return lerp(59.7, 60.8, (t - T_DISCHARGE) / (dayOf('2026-11-15') - T_DISCHARGE));
}
export const soften = (g: number) => (g > 17 ? 17 + 4.8 * Math.tanh((g - 17) / 4.8) : g);

export interface Reading {
  at: string;
  value: number;
}
export interface BpReading {
  at: string;
  systolic: number;
  diastolic: number;
}
export interface History {
  glucose: Reading[];
  bp: BpReading[];
  weight: Reading[];
}

export function generateHistory(): History {
  const rand = mulberry32(SEED);
  const normal = normalFrom(rand);
  const startMs = Date.parse(HISTORY.start);
  const endMs = Date.parse(HISTORY.end);

  const day: { shift: number; meals: { hour: number; size: number; skip: number }[]; lowNight: boolean }[] = [];
  for (let d = 0; d < DAYS; d++) {
    const t = d + 0.5;
    const lowChance = t >= T_DECLINE && t < T_DISCHARGE ? 0.02 : 0.06;
    day.push({
      shift: normal() * 0.9,
      meals: [7.5, 12.5, 19.0].map((h) => ({ hour: h + normal() * 0.5, size: 3.2 + rand() * 3.2, skip: rand() })),
      lowNight: rand() < lowChance,
    });
  }
  const missed = new Set(['2026-10-03', '2026-11-10']);
  const worn = (ms: number) => SENSOR_SESSIONS.some((s) => ms >= s.on + WARM_UP_MS && ms < s.off);

  const glucose: Reading[] = [];
  let noise = 0;
  for (let ms = startMs + CGM_OFFSET_MS; ms <= endMs; ms += 15 * 60_000) {
    noise = 0.9 * noise + normal() * 0.35;
    if (!worn(ms)) continue;
    const t = localDays(ms);
    const d = Math.floor(t);
    const p = day[d];
    const hour = (t - d) * 24;
    let g = baseLevel(t) + p.shift;
    if (hour >= 4 && hour < 7) g += 1.0;
    if (hour >= 1 && hour < 4) g -= p.lowNight ? 5.0 : 1.0;
    const skip = skipMeal(t);
    for (const m of [...p.meals, ...(day[d - 1]?.meals ?? []).map((x) => ({ ...x, hour: x.hour - 24 }))]) {
      if (m.skip < skip) continue;
      const dt = (hour - m.hour) * 60;
      if (dt >= 0 && dt < 300) g += m.size * (dt / 60) * Math.exp(1 - dt / 60);
    }
    if (missed.has(ymd(wallMs(ms))) && hour >= 12) g += 5.5 * Math.min(1, (hour - 12) / 3);
    glucose.push({ at: iso(ms), value: round1(Math.min(CGM_RANGE.max, Math.max(CGM_RANGE.min, soften(g + noise)))) });
  }

  const bp: BpReading[] = [];
  for (let d = 0; d < DAYS; d++) {
    for (const h of [7.2, 21.5]) {
      const ms = Math.round((localMidnight(d) + (h + normal() * 0.25) * H) / 60_000) * 60_000;
      const systolic = Math.round(119 + normal() * 5);
      const diastolic = Math.round(77 + 0.5 * (systolic - 119) + normal() * 3);
      const taken = rand() < takeBp(localDays(ms));
      if (!taken || ms > endMs || inHospital(ms)) continue;
      bp.push({ at: iso(ms), systolic, diastolic });
    }
  }

  const weight: Reading[] = [];
  for (let d = 0; d < DAYS; d++) {
    const jitter = normal() * 0.2;
    if (new Date(FIRST_DAY + d * DAY).getUTCDay() !== 0) continue;
    const ms = localMidnight(d) + 8 * H;
    if (inHospital(ms)) continue;
    weight.push({ at: iso(ms), value: round1(weightLevel(localDays(ms)) + jitter) });
  }
  return { glucose, bp, weight };
}
