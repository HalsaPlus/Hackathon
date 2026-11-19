// How a PDHC plan's concepts map to Hälsa+ observations, shared by the server
// (server/halsa-link.ts) and the patient app (src/app/halsa.ts).
//
// A transaction is matched on its PDHC concept GUID first, then on the exact
// concept name (as plan.pdhc's templates write it), never on display text.
// `B-glucos` (capillary blood glucose) is deliberately not mapped: Hälsa+'s
// glucose comes from a CGM sensor.

/** One series the app can read from Hälsa+. Blood pressure gives two. */
export type HalsaSeries = 'glucose' | 'sleep' | 'systolic' | 'diastolic' | 'anxiety' | 'stress' | 'weight';

/** Hälsa+'s own observation types that the app reads. */
export type HalsaType = 'glucose' | 'sleep' | 'blood-pressure' | 'anxiety' | 'stress' | 'bmi';

export const HALSA_TYPES: readonly HalsaType[] = ['glucose', 'sleep', 'blood-pressure', 'anxiety', 'stress', 'bmi'];

export interface HalsaSeriesInfo {
  type: HalsaType;
  label: string;
  /** A 0–10 self-rating rather than a measured value. */
  rating: boolean;
}

/** In the order the app lists them. */
export const HALSA_SERIES: Record<HalsaSeries, HalsaSeriesInfo> = {
  glucose: { type: 'glucose', label: 'Glucose (CGM)', rating: false },
  sleep: { type: 'sleep', label: 'Sleep', rating: false },
  systolic: { type: 'blood-pressure', label: 'Systolic blood pressure', rating: false },
  diastolic: { type: 'blood-pressure', label: 'Diastolic blood pressure', rating: false },
  anxiety: { type: 'anxiety', label: 'Anxiety', rating: true },
  stress: { type: 'stress', label: 'Stress', rating: true },
  weight: { type: 'bmi', label: 'Weight', rating: false },
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
  /** null for the 0–10 ratings. */
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
    case 'anxiety':
    case 'stress':
      return point(observation.type, observation.value, null);
    default:
      return [];
  }
}
