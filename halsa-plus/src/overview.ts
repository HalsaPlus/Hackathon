import type { Database } from './db.ts';
import { findObservations, latestObservations } from './store.ts';
import type { ObservationType, StoredObservation } from './synthetic/dataset.ts';

// The health overview like the Hälsa+ home screen: six body categories, each
// with a score, and a total "Health score".
//
// DEMO VALUES: the reference ranges below are made up for the demo. They are
// not clinical reference intervals and must not be read as such.
//
// Score of a category = the share (%) of the patient's values in the 14 days
// before asOf that lie within range, counting every value (all CGM readings).
// A blood pressure reading is within range only when both systolic and
// diastolic are. A category without values in the window gets score null.
// Health score = the mean of the categories that have a score.

const DAY = 86_400_000;
export const OVERVIEW_WINDOW_DAYS = 14;

export interface DemoRange {
  /** A component's code, or absent for the observation's own value. */
  component?: string;
  low: number;
  high: number;
  unit: string;
}

interface Measure {
  id: string;
  name: string;
  /** Absent for a measure Hälsa+ has no data source for (a placeholder). */
  type?: ObservationType;
  ranges?: DemoRange[];
}

interface CategoryRule {
  id: string;
  name: string;
  measures: Measure[];
}

const rating = (low: number, high: number): DemoRange[] => [{ low, high, unit: '1–7' }];

export const CATEGORIES: CategoryRule[] = [
  {
    id: 'lungs',
    name: 'Lungs',
    measures: [
      { id: 'oxygen-saturation', name: 'Oxygen saturation' },
      { id: 'peak-flow', name: 'Peak flow' },
    ],
  },
  {
    id: 'liver',
    name: 'Liver',
    measures: [
      { id: 'alt', name: 'ALT' },
      { id: 'ggt', name: 'GGT' },
    ],
  },
  {
    id: 'hormones',
    name: 'Hormones',
    measures: [{ id: 'glucose', name: 'Glucose (CGM)', type: 'glucose', ranges: [{ low: 3.9, high: 10.0, unit: 'mmol/L' }] }],
  },
  {
    id: 'heart',
    name: 'Heart',
    measures: [
      {
        id: 'blood-pressure',
        name: 'Blood pressure',
        type: 'blood-pressure',
        ranges: [
          { component: 'systolic', low: 90, high: 130, unit: 'mmHg' },
          { component: 'diastolic', low: 60, high: 85, unit: 'mmHg' },
        ],
      },
    ],
  },
  {
    id: 'urinary-tract',
    name: 'Urinary tract',
    measures: [
      { id: 'creatinine', name: 'Creatinine' },
      { id: 'urine-test', name: 'Urine test' },
    ],
  },
  {
    id: 'mental-health',
    name: 'Mental health',
    measures: [
      { id: 'sleep', name: 'Sleep', type: 'sleep', ranges: [{ component: 'sleep-duration', low: 360, high: 540, unit: 'min' }] },
      { id: 'energy', name: 'Energy', type: 'energy', ranges: rating(4, 7) },
      { id: 'mood', name: 'Mood', type: 'mood', ranges: rating(4, 7) },
      { id: 'stress', name: 'Stress', type: 'stress', ranges: rating(1, 4) },
      { id: 'anxiety', name: 'Anxiety', type: 'anxiety', ranges: rating(1, 4) },
      { id: 'depression', name: 'Depression', type: 'depression', ranges: rating(1, 4) },
    ],
  },
];

function valueOf(o: StoredObservation, component: string | undefined) {
  return component ? o.components?.find((c) => c.code === component)?.value : o.value;
}

/** Within every one of the measure's ranges; a value that is missing counts as outside. */
export function inDemoRange(o: StoredObservation, ranges: DemoRange[]) {
  return ranges.every((r) => {
    const value = valueOf(o, r.component);
    return value !== undefined && value >= r.low && value <= r.high;
  });
}

const percent = (part: number, whole: number) => Math.round((100 * part) / whole);

type Found = { at: number; observation: StoredObservation };

export function buildOverview<T>(database: Database, patientGuid: string, asOf: number, withStatus: (found: Found) => T) {
  const from = asOf - OVERVIEW_WINDOW_DAYS * DAY;
  const categories = CATEGORIES.map((category) => {
    let inWindow = 0;
    let inRange = 0;
    const measures = category.measures.map((m) => {
      if (!m.type) return { id: m.id, name: m.name, type: null, available: false, demoRanges: [], valuesInWindow: 0, valuesInRange: 0, latest: null };
      const values = findObservations(database, { patientGuid, types: [m.type], from, to: asOf, limit: 1_000_000 }).items.map((e) => e.observation);
      const ok = values.filter((o) => inDemoRange(o, m.ranges ?? [])).length;
      inWindow += values.length;
      inRange += ok;
      const [latest] = latestObservations(database, patientGuid, [m.type], asOf);
      return {
        id: m.id,
        name: m.name,
        type: m.type,
        available: !!latest,
        demoRanges: m.ranges ?? [],
        valuesInWindow: values.length,
        valuesInRange: ok,
        latest: latest ? withStatus(latest) : null,
      };
    });
    return {
      id: category.id,
      name: category.name,
      score: inWindow ? percent(inRange, inWindow) : null,
      available: measures.filter((m) => m.available).length,
      total: measures.length,
      valuesInWindow: inWindow,
      valuesInRange: inRange,
      measures,
    };
  });
  const scored = categories.map((c) => c.score).filter((s): s is number => s !== null);
  return {
    from,
    healthScore: scored.length ? Math.round(scored.reduce((a, b) => a + b, 0) / scored.length) : null,
    categories,
  };
}
