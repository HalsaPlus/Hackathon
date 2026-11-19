// How a PDHC plan's concepts map to Hälsa+ observations, shared by the server
// (server/halsa-link.ts) and the patient app (src/app/halsa.ts).
//
// A transaction is matched on its PDHC concept GUID first, then on the exact
// concept name (as plan.pdhc's templates write it), never on display text.
// `B-glucos` (capillary blood glucose) is deliberately not mapped: Hälsa+'s
// glucose comes from a CGM sensor.

/** One series the app can read from Hälsa+. Blood pressure gives two. */
export type HalsaSeries =
  | 'glucose'
  | 'sleep'
  | 'steps'
  | 'systolic'
  | 'diastolic'
  | 'energy'
  | 'mood'
  | 'stress'
  | 'anxiety'
  | 'depression'
  | 'weight';

/** Hälsa+'s own observation types that the app reads. */
export type HalsaType = 'glucose' | 'sleep' | 'steps' | 'blood-pressure' | 'energy' | 'mood' | 'stress' | 'anxiety' | 'depression' | 'bmi';

export const HALSA_TYPES: readonly HalsaType[] = ['glucose', 'sleep', 'steps', 'blood-pressure', 'energy', 'mood', 'stress', 'anxiety', 'depression', 'bmi'];

/** The self-ratings Hälsa+ takes from the app, all on 1–7. */
export const HALSA_RATINGS = ['energy', 'mood', 'stress', 'anxiety', 'depression'] as const;
export type HalsaRating = (typeof HALSA_RATINGS)[number];

/** A 1–7 self-rating's scale and what its ends mean. */
export interface RatingScale {
  min: 1;
  max: 7;
  low: string;
  high: string;
}

const HOW_MUCH: RatingScale = { min: 1, max: 7, low: 'Not at all', high: 'Very much' };
const HOW_HIGH: RatingScale = { min: 1, max: 7, low: 'Very low', high: 'Very high' };

export interface HalsaSeriesInfo {
  type: HalsaType;
  /** The label everywhere in the app. Anxiety is always "Anxiety". */
  label: string;
  /** A 1–7 self-rating rather than a measured value. */
  rating?: RatingScale;
}

/** In the order the app lists them. */
export const HALSA_SERIES: Record<HalsaSeries, HalsaSeriesInfo> = {
  glucose: { type: 'glucose', label: 'Glucose (CGM)' },
  sleep: { type: 'sleep', label: 'Sleep' },
  steps: { type: 'steps', label: 'Steps' },
  systolic: { type: 'blood-pressure', label: 'Systolic blood pressure' },
  diastolic: { type: 'blood-pressure', label: 'Diastolic blood pressure' },
  energy: { type: 'energy', label: 'Energy', rating: HOW_HIGH },
  mood: { type: 'mood', label: 'Mood', rating: HOW_HIGH },
  stress: { type: 'stress', label: 'Stress', rating: HOW_MUCH },
  anxiety: { type: 'anxiety', label: 'Anxiety', rating: HOW_MUCH },
  depression: { type: 'depression', label: 'Depression', rating: HOW_MUCH },
  weight: { type: 'bmi', label: 'Weight' },
};

export const isHalsaRating = (series: string): series is HalsaRating => (HALSA_RATINGS as readonly string[]).includes(series);

/** What a plan's data is called in plain words, for the consent card. */
export const PLAIN_NAMES: Record<HalsaSeries, string> = {
  glucose: 'CGM glucose',
  sleep: 'sleep',
  steps: 'steps',
  systolic: 'blood pressure',
  diastolic: 'blood pressure',
  energy: 'energy',
  mood: 'mood',
  stress: 'stress',
  anxiety: 'anxiety',
  depression: 'depression',
  weight: 'weight',
};

/** PDHC concept GUIDs, as in plan.pdhc's template "MMD_plan". */
const BY_CONCEPT_GUID: Record<string, HalsaSeries> = {
  '22d0f6c6-2438-4637-ad4e-9d85431b8edb': 'glucose', // CGM
  '9bbc1c9e-f33c-4271-a71b-4242e58c2161': 'sleep', // sleep-duration
  'abf6ba5f-0b82-4163-94ec-4b6eb111cd2b': 'systolic', // systolic-blood-pressure
  'c6824284-13a3-4241-a88f-f6e58b6a8d4d': 'diastolic', // diastolic-blood-pressure
  '739ae368-f0df-4b14-a6bb-98affed01e3d': 'anxiety',
  'd3cb5dfe-23c4-4499-ba7b-e9c5481f43a4': 'stress',
};

/** PDHC concept names (lower case), for concepts whose GUID is not listed above. */
const BY_CONCEPT_NAME: Record<string, HalsaSeries> = {
  cgm: 'glucose',
  'sleep-duration': 'sleep',
  'systolic-blood-pressure': 'systolic',
  bp_systolic: 'systolic',
  'diastolic-blood-pressure': 'diastolic',
  bp_diastolic: 'diastolic',
  anxiety: 'anxiety',
  stress: 'stress',
  energy: 'energy',
  mood: 'mood',
  depression: 'depression',
  steps: 'steps',
  weight: 'weight',
  'body-weight': 'weight',
};

/** The Hälsa+ series a plan transaction asks for, if Hälsa+ has it. */
export function halsaSeriesFor(transaction: { conceptGuid?: string; name: string }): HalsaSeries | undefined {
  const byGuid = transaction.conceptGuid ? BY_CONCEPT_GUID[transaction.conceptGuid.toLowerCase()] : undefined;
  return byGuid ?? BY_CONCEPT_NAME[transaction.name.trim().toLowerCase()];
}

/** One value of one series, as the MMD server hands it to the app. */
export interface HalsaPoint {
  series: HalsaSeries;
  value: number;
  /** null for the 1–7 ratings. */
  unit: string | null;
  /** When the value became available: wake time for sleep, else the measurement time. */
  time: string;
  /** Device display name in Hälsa+, e.g. "CGM sensor (demo)". */
  device: string | null;
  status: 'final' | 'preliminary';
  sourceType: string;
}

export interface HalsaPoints {
  asOf: string;
  points: HalsaPoint[];
}

/** What the app shows as the source of a value read from Hälsa+, and stores as its device. */
export const halsaDevice = (point: Pick<HalsaPoint, 'device'>) => `Hälsa+ · ${point.device ?? 'Hälsa+'}`;

/** Minutes → hours, to two decimals (≈ ±18 seconds). The plan's unit for sleep is h. */
export const minutesToHours = (minutes: number) => Math.round((minutes / 60) * 100) / 100;

interface HalsaComponent {
  code: string;
  value: number;
  unit?: string;
}

/** A Hälsa+ observation as GET /api/v1/observations returns it (the fields used here). */
export interface HalsaObservation {
  type: string;
  status?: string;
  sourceType?: string;
  deviceId?: string | null;
  effectiveDateTime?: string;
  effectivePeriod?: { start: string; end: string };
  value?: number;
  unit?: string;
  components?: HalsaComponent[];
}

/**
 * The series values in one Hälsa+ observation. Values are passed on as they
 * are: nothing is clipped, filtered or fitted to a plan's range. The only
 * change is sleep, from minutes to hours.
 */
export function pointsFromObservation(observation: HalsaObservation, deviceNames: ReadonlyMap<string, string> = new Map()): HalsaPoint[] {
  const time = observation.type === 'sleep' ? observation.effectivePeriod?.end : observation.effectiveDateTime;
  if (!time) return [];
  const base = {
    time,
    device: observation.deviceId ? (deviceNames.get(observation.deviceId) ?? observation.deviceId) : null,
    status: observation.status === 'preliminary' ? ('preliminary' as const) : ('final' as const),
    sourceType: observation.sourceType ?? 'device',
  };
  const component = (code: string) => observation.components?.find((c) => c.code === code && Number.isFinite(c.value));
  const point = (series: HalsaSeries, value: number | undefined, unit: string | null): HalsaPoint[] =>
    value === undefined || !Number.isFinite(value) ? [] : [{ series, value, unit, ...base }];

  switch (observation.type) {
    case 'glucose':
      return point('glucose', observation.value, observation.unit ?? 'mmol/L');
    case 'sleep': {
      const minutes = component('sleep-duration')?.value;
      return point('sleep', minutes === undefined ? undefined : minutesToHours(minutes), 'h');
    }
    case 'blood-pressure':
      return [
        ...point('systolic', component('systolic')?.value, component('systolic')?.unit ?? 'mmHg'),
        ...point('diastolic', component('diastolic')?.value, component('diastolic')?.unit ?? 'mmHg'),
      ];
    case 'bmi':
      return point('weight', component('weight')?.value, component('weight')?.unit ?? 'kg');
    case 'steps':
      return point('steps', observation.value, 'steps');
    default:
      return isHalsaRating(observation.type) ? point(observation.type, observation.value, null) : [];
  }
}

// --- The health overview, vaccinations and consent, as the app gets them ---------------

/** One measure in a category of the overview, with its latest value ready to show. */
export interface OverviewMeasure {
  id: string;
  name: string;
  available: boolean;
  /** The demo range in display units, e.g. "6–9 h"; null for a measure without data source. */
  range: string | null;
  latest: { value: string; unit: string | null; time: string; device: string | null; status: 'final' | 'preliminary' } | null;
}

export interface OverviewCategory {
  id: 'lungs' | 'liver' | 'hormones' | 'heart' | 'urinary-tract' | 'mental-health';
  name: string;
  /** % of the values in the last 14 days within the demo range; null without values. */
  score: number | null;
  available: number;
  total: number;
  measures: OverviewMeasure[];
}

export interface HalsaOverview {
  asOf: string;
  healthScore: number | null;
  /** The ranges are demo values, not clinical reference intervals. */
  demoRanges: true;
  categories: OverviewCategory[];
}

export interface HalsaVaccination {
  id: string;
  vaccine: string;
  against: string;
  date: string;
  dose: string;
  givenAt: string;
}

export interface HalsaConsent {
  /** The decision that applies (the latest), or null when she has not decided. */
  decision: 'accept' | 'decline' | null;
  decidedAt: string | null;
  history: { decision: 'accept' | 'decline'; decidedAt: string }[];
}

const number = (value: number) => String(Math.round(value * 100) / 100);

/** A Hälsa+ observation as one short value and unit, e.g. "118/76" mmHg or "7.28" h. */
export function displayValue(observation: HalsaObservation): { value: string; unit: string | null } | undefined {
  const component = (code: string) => observation.components?.find((c) => c.code === code)?.value;
  if (observation.type === 'blood-pressure') {
    const systolic = component('systolic');
    const diastolic = component('diastolic');
    return systolic === undefined || diastolic === undefined ? undefined : { value: `${systolic}/${diastolic}`, unit: 'mmHg' };
  }
  if (observation.type === 'sleep') {
    const minutes = component('sleep-duration');
    return minutes === undefined ? undefined : { value: number(minutesToHours(minutes)), unit: 'h' };
  }
  if (observation.value === undefined) return undefined;
  if (isHalsaRating(observation.type)) return { value: number(observation.value), unit: 'of 7' };
  return { value: number(observation.value), unit: observation.unit ?? null };
}

/** A demo range in display units: sleep in hours, blood pressure as systolic / diastolic. */
export function displayRange(ranges: { component?: string; low: number; high: number; unit: string }[]): string | null {
  if (!ranges.length) return null;
  if (ranges[0].component === 'sleep-duration') return `${minutesToHours(ranges[0].low)}–${minutesToHours(ranges[0].high)} h`;
  const unit = ranges[0].unit === '1–7' ? '' : ` ${ranges[0].unit}`;
  return `${ranges.map((r) => `${r.low}–${r.high}`).join(' / ')}${unit}`;
}
