// The observations as FHIR R4 resources, for the care side (MMD/PDHC).
// LOINC where a standard code exists, UCUM units. Andrea's 1–7 self-ratings and
// the sleep night use Hälsa+'s own demo codes; the ratings are not a validated
// instrument. No interpretation and no reference ranges.

import type { PatientRow } from './patients.ts';
import type { DeviceDbRow } from './store.ts';
import { type Component, isRatingType, type StoredObservation } from './synthetic/dataset.ts';

/** Who the observations belong to, and her devices (for references with a display name). */
export interface FhirContext {
  patient: PatientRow;
  devices: DeviceDbRow[];
}

const LOINC = 'http://loinc.org';
export const LOCAL = 'https://halsaplus.example/codes';
const UCUM = 'http://unitsofmeasure.org';

const UCUM_CODES: Record<string, string> = { mmHg: 'mm[Hg]', 'kg/m²': 'kg/m2', count: '{count}', steps: '/d' };

const coding = (system: string, code: string, display: string) => ({ coding: [{ system, code, display }] });
const category = (code: string) => [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code }] }];

function quantity(value: number, unit: string, comparator?: string) {
  const code = UCUM_CODES[unit] ?? unit;
  return { ...(comparator ? { comparator } : {}), value, unit: code, system: UCUM, code };
}

const selfRating = (id: string, name: string) =>
  coding(LOCAL, `${id}-self-rating`, `${name}, self-rating 1-7 in the Hälsa+ app (not a validated instrument)`);

const CODES = {
  glucose: { category: 'laboratory', code: coding(LOINC, '105272-9', 'Glucose [Moles/volume] in Interstitial fluid') },
  'blood-pressure': { category: 'vital-signs', code: coding(LOINC, '85354-9', 'Blood pressure panel with all children optional') },
  bmi: { category: 'vital-signs', code: coding(LOINC, '39156-5', 'Body mass index (BMI) [Ratio]') },
  sleep: { category: 'activity', code: coding(LOCAL, 'sleep-night', 'Night of sleep (smartwatch)') },
  steps: { category: 'activity', code: coding(LOINC, '41950-7', 'Number of steps in 24 hour Measured') },
  energy: { category: 'survey', code: selfRating('energy', 'Energy') },
  mood: { category: 'survey', code: selfRating('mood', 'Mood') },
  stress: { category: 'survey', code: selfRating('stress', 'Stress') },
  anxiety: { category: 'survey', code: selfRating('anxiety', 'Anxiety') },
  depression: { category: 'survey', code: selfRating('depression', 'Depression') },
  crp: { category: 'laboratory', code: coding(LOINC, '1988-5', 'C reactive protein [Mass/volume] in Serum or Plasma') },
} as const;

const COMPONENT_CODES: Record<Component['code'], ReturnType<typeof coding>> = {
  systolic: coding(LOINC, '8480-6', 'Systolic blood pressure'),
  diastolic: coding(LOINC, '8462-4', 'Diastolic blood pressure'),
  pulse: coding(LOINC, '8867-4', 'Heart rate'),
  weight: coding(LOINC, '29463-7', 'Body weight'),
  height: coding(LOINC, '8302-2', 'Body height'),
  'sleep-duration': coding(LOINC, '93832-4', 'Sleep duration'),
  awakenings: coding(LOCAL, 'awakenings', 'Number of awakenings'),
};

export function toFhirObservation(o: StoredObservation & { status: string }, ctx: FhirContext) {
  const { category: cat, code } = CODES[o.type];
  const device = ctx.devices.find((d) => d.id === o.deviceId);
  const { patient } = ctx;
  const identifier =
    patient.personal_identity_number && patient.identifier_system ? { identifier: { system: patient.identifier_system, value: patient.personal_identity_number } } : {};
  const rating = isRatingType(o.type);
  return {
    resourceType: 'Observation',
    id: o.id,
    status: o.status,
    category: category(cat),
    code,
    subject: { reference: `Patient/${patient.guid}`, ...identifier, display: patient.name },
    ...(o.effectiveDateTime ? { effectiveDateTime: o.effectiveDateTime } : {}),
    ...(o.effectivePeriod ? { effectivePeriod: o.effectivePeriod } : {}),
    ...(o.issued ? { issued: o.issued } : {}),
    ...(o.performer ? { performer: [{ display: o.performer.name }] } : {}),
    ...(o.value !== undefined && rating ? { valueInteger: o.value } : {}),
    ...(o.value !== undefined && !rating ? { valueQuantity: quantity(o.value, o.unit ?? '', o.comparator) } : {}),
    ...(device ? { device: { reference: `Device/${device.id}`, display: device.name } } : {}),
    ...(o.components
      ? { component: o.components.map((c) => ({ code: COMPONENT_CODES[c.code], valueQuantity: quantity(c.value, c.unit, c.comparator) })) }
      : {}),
  };
}

export function toFhirBundle(observations: (StoredObservation & { status: string })[], ctx: FhirContext, selfUrl: string, nextUrl: string | null) {
  return {
    resourceType: 'Bundle',
    type: 'searchset',
    meta: { tag: [{ system: LOCAL, code: 'synthetic', display: 'Synthetic test data' }] },
    link: [{ relation: 'self', url: selfUrl }, ...(nextUrl ? [{ relation: 'next', url: nextUrl }] : [])],
    entry: observations.map((o) => ({ fullUrl: `https://halsaplus.example/fhir/Observation/${o.id}`, resource: toFhirObservation(o, ctx), search: { mode: 'match' } })),
  };
}
