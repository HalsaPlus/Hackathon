// Andrea's glucose after discharge, adjusted so the recovery is clearer but
// uneven: the history generator (history.ts, identical to the Hälsa+ demo's)
// keeps her level near 9–11 mmol/L for months after the stay. This lowers
// the high values step by step after discharge, with better and worse weeks.
// Low values are left almost as they are. Deterministic: a function of the
// time and the value only. SYNTHETIC TEST DATA ONLY.

import { CGM_RANGE, DAY, DISCHARGE_MS, round1 } from './history.ts';
import { clamp } from './time.ts';

/** How much lower (mmol/L) a high value is, d days after discharge. */
export function recoveryDrop(d: number) {
  if (d < 0) return 0;
  const settling = 1.4 * (1 - Math.exp(-d / 24));
  const unevenWeeks = 0.55 * Math.sin(d / 5.3) + 0.35 * Math.sin(d / 13.7 + 1);
  return Math.max(0, settling + unevenWeeks);
}

export function recoveredGlucose(ms: number, value: number) {
  if (ms < DISCHARGE_MS) return value;
  // Highs come down the most; values near the low end barely move.
  const weight = clamp((value - 4.5) / 4, 0, 1);
  return round1(clamp(value - recoveryDrop((ms - DISCHARGE_MS) / DAY) * weight, CGM_RANGE.min, CGM_RANGE.max));
}
