// Andrea's whole data set for one server start: every observation from
// 2026-03-01 to 28 days after the start date, sorted by the time it becomes
// available. SYNTHETIC TEST DATA ONLY.

import { CRP_LAB, CRP_RESULTS } from './crp.ts';
import { generateExtension } from './extension.ts';
import { generateHistory, HISTORY } from './history.ts';
import { addDays, parisDate, parisTime } from './time.ts';
import { generateRatings, generateSleep } from './wellbeing.ts';

export const OBSERVATION_TYPES = ['blood-pressure', 'glucose', 'sleep', 'anxiety', 'stress', 'bmi', 'crp'] as const;
export type ObservationType = (typeof OBSERVATION_TYPES)[number];
export type Comparator = '<' | '<=' | '>' | '>=';

export interface Component {
  code: 'systolic' | 'diastolic' | 'pulse' | 'weight' | 'height' | 'sleep-duration' | 'awakenings';
  value: number;
  comparator?: Comparator;
  unit: string;
}

/** An observation as the API returns it, without `status` (that depends on the request time). */
export interface StoredObservation {
  id: string;
  type: ObservationType;
  sourceType: 'device' | 'patient-reported' | 'external-lab';
  deviceId: string | null;
  performer?: { name: string; type: 'laboratory'; city: string };
  effectiveDateTime?: string;
  effectivePeriod?: { start: string; end: string };
  issued?: string;
  value?: number;
  comparator?: Comparator;
  unit?: string;
  components?: Component[];
}

export interface Entry {
  /** When the observation becomes available: effective time, wake time (sleep) or issued (lab). */
  at: number;
  observation: StoredObservation;
}

export interface Device {
  id: string;
  type: 'cgm-sensor' | 'blood-pressure-monitor' | 'scale' | 'smartwatch' | 'app';
  name: string;
  source: 'bluetooth' | 'manual-entry';
  types: ObservationType[];
  since: string;
}

/** Andrea Lindqvist (synthetic). Her guid is the same as her patient GUID in PDHC. */
export const ANDREA = {
  guid: '28a29239-6424-48e7-a123-9d9e863670b8',
  name: 'Andrea Lindqvist',
  personalIdentityNumber: '200207252388',
  birthDate: '2002-07-25',
  identifierSystem: 'urn:oid:1.2.752.129.2.1.3.1',
  gender: 'female',
  heightCm: 168,
};
export const HEIGHT_CM = ANDREA.heightCm;

// Device ids as in the Hälsa+ demo (uuidV5 of "device:<type>").
export const ANDREA_DEVICES: Device[] = [
  { id: '6f9f647e-3f38-5bb4-a897-75ebf3d250b7', type: 'cgm-sensor', name: 'CGM sensor (demo)', source: 'bluetooth', types: ['glucose'], since: '2019-05-20' },
  { id: '487a0ac7-adec-5ab4-9a07-451e80585c1e', type: 'blood-pressure-monitor', name: 'Blood pressure monitor (demo)', source: 'bluetooth', types: ['blood-pressure'], since: '2026-03-01' },
  { id: '506bfdb7-f834-57d6-8631-9b8ba5a24897', type: 'scale', name: 'Scale (demo)', source: 'bluetooth', types: ['bmi'], since: '2026-03-01' },
  { id: '9aadb89f-7c71-5a8a-bb38-f32fceb26615', type: 'smartwatch', name: 'Smartwatch (demo)', source: 'bluetooth', types: ['sleep'], since: '2026-03-01' },
  { id: '6416ebbc-5cba-5d4d-875b-381123d451ea', type: 'app', name: 'Hälsa+ app', source: 'manual-entry', types: ['anxiety', 'stress', 'blood-pressure', 'glucose', 'bmi', 'sleep'], since: '2026-03-01' },
];
const [CGM, BP, SCALE, WATCH, APP] = ANDREA_DEVICES.map((d) => d.id);

/** ISO time without milliseconds, as the API writes it. */
export const isoTime = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const idFor = (type: ObservationType, ms: number) => `${type}-${isoTime(ms).replace(/[-:]/g, '')}`;

export interface Dataset {
  start: number;
  end: number;
  entries: Entry[];
}

/** The data window for a server that starts on `startDate` (Paris date): 2026-03-01 to 28 days later. */
export function dataWindow(startDate: string) {
  const lastDate = addDays(startDate, 28);
  return { start: Date.parse(HISTORY.start), end: parisTime(addDays(lastDate, 1), 0) - 1, lastDate };
}

/** Builds Andrea's generated data for a server that starts on `startDate` (Paris date, YYYY-MM-DD). */
export function buildDataset(startDate: string): Dataset {
  const { start, end, lastDate } = dataWindow(startDate);

  const history = generateHistory();
  const extension = generateExtension(end, history.glucose.at(-1)!.value);
  const entries: Entry[] = [];
  const add = (ms: number, observation: StoredObservation) => {
    if (ms >= start && ms <= end) entries.push({ at: ms, observation });
  };

  for (const r of [...history.glucose, ...extension.glucose]) {
    const ms = Date.parse(r.at);
    add(ms, { id: idFor('glucose', ms), type: 'glucose', sourceType: 'device', deviceId: CGM, effectiveDateTime: isoTime(ms), value: r.value, unit: 'mmol/L' });
  }
  for (const r of [...history.bp, ...extension.bp]) {
    const ms = Date.parse(r.at);
    add(ms, {
      id: idFor('blood-pressure', ms),
      type: 'blood-pressure',
      sourceType: 'device',
      deviceId: BP,
      effectiveDateTime: isoTime(ms),
      components: [
        { code: 'systolic', value: r.systolic, unit: 'mmHg' },
        { code: 'diastolic', value: r.diastolic, unit: 'mmHg' },
      ],
    });
  }
  for (const r of [...history.weight, ...extension.weight]) {
    const ms = Date.parse(r.at);
    add(ms, {
      id: idFor('bmi', ms),
      type: 'bmi',
      sourceType: 'device',
      deviceId: SCALE,
      effectiveDateTime: isoTime(ms),
      value: Math.round((r.value / (HEIGHT_CM / 100) ** 2) * 10) / 10,
      unit: 'kg/m²',
      components: [
        { code: 'weight', value: r.value, unit: 'kg' },
        { code: 'height', value: HEIGHT_CM, unit: 'cm' },
      ],
    });
  }
  for (const n of generateSleep(lastDate, end)) {
    const ms = Date.parse(n.wake);
    add(ms, {
      id: idFor('sleep', ms),
      type: 'sleep',
      sourceType: 'device',
      deviceId: WATCH,
      effectivePeriod: { start: isoTime(Date.parse(n.bedtime)), end: isoTime(ms) },
      components: [
        { code: 'sleep-duration', value: n.minutes, unit: 'min' },
        { code: 'awakenings', value: n.awakenings, unit: 'count' },
      ],
    });
  }
  for (const r of generateRatings(lastDate, end)) {
    const ms = Date.parse(r.at);
    add(ms, { id: idFor(r.type, ms), type: r.type, sourceType: 'patient-reported', deviceId: APP, effectiveDateTime: isoTime(ms), value: r.value, unit: '0–10' });
  }
  for (const r of CRP_RESULTS) {
    const sampled = Date.parse(r.sampled);
    add(Date.parse(r.issued), {
      id: idFor('crp', sampled),
      type: 'crp',
      sourceType: 'external-lab',
      deviceId: null,
      performer: { name: CRP_LAB.name, type: 'laboratory', city: CRP_LAB.city },
      effectiveDateTime: isoTime(sampled),
      issued: isoTime(Date.parse(r.issued)),
      value: r.value,
      ...(r.comparator ? { comparator: r.comparator } : {}),
      unit: 'mg/L',
    });
  }

  entries.sort((a, b) => a.at - b.at || (a.observation.id < b.observation.id ? -1 : a.observation.id > b.observation.id ? 1 : 0));
  return { start, end, entries };
}

/** The Paris date today, the day the data window is counted from. */
export const todayInParis = (now = Date.now()) => parisDate(now);
