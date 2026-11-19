// The observations as FHIR R4 resources, for the care side (MMD/PDHC).
// LOINC where a standard code exists, UCUM units. Andrea's self-ratings and the
// sleep night use Hälsa+'s own demo codes; the ratings are not a validated
// instrument. No interpretation and no reference ranges, as everywhere.

import { DEVICES, PATIENT_ID, type Component, type StoredObservation } from './synthetic/dataset.ts';

const LOINC = 'http://loinc.org';
export const LOCAL = 'https://halsaplus.example/codes';
const UCUM = 'http://unitsofmeasure.org';
const PNR = { system: 'urn:oid:1.2.752.129.2.1.3.1', value: '200207252388' };

const UCUM_CODES: Record<string, string> = { mmHg: 'mm[Hg]', 'kg/m²': 'kg/m2', count: '{count}' };

const coding = (system: string, code: string, display: string) => ({ coding: [{ system, code, display }] });
const category = (code: string) => [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code }] }];

function quantity(value: number, unit: string, comparator?: string) {
  const code = UCUM_CODES[unit] ?? unit;
  return { ...(comparator ? { comparator } : {}), value, unit: code, system: UCUM, code };
}

const CODES = {
  glucose: { category: 'laboratory', code: coding(LOINC, '105272-9', 'Glucose [Moles/volume] in Interstitial fluid') },
  'blood-pressure': { category: 'vital-signs', code: coding(LOINC, '85354-9', 'Blood pressure panel with all children optional') },
  bmi: { category: 'vital-signs', code: coding(LOINC, '39156-5', 'Body mass index (BMI) [Ratio]') },
  sleep: { category: 'activity', code: coding(LOCAL, 'sleep-night', 'Night of sleep (smartwatch)') },
  anxiety: { category: 'survey', code: coding(LOCAL, 'anxiety-self-rating', 'Anxiety, self-rating 0-10 in the Hälsa+ app (not a validated instrument)') },
  stress: { category: 'survey', code: coding(LOCAL, 'stress-self-rating', 'Stress, self-rating 0-10 in the Hälsa+ app (not a validated instrument)') },
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

export function toFhirObservation(o: StoredObservation & { status: string }) {
  const { category: cat, code } = CODES[o.type];
  const device = DEVICES.find((d) => d.id === o.deviceId);
  const rating = o.type === 'anxiety' || o.type === 'stress';
  return {
    resourceType: 'Observation',
    id: o.id,
    status: o.status,
    category: category(cat),
    code,
    subject: { reference: `Patient/${PATIENT_ID}`, identifier: PNR, display: 'Andrea Lindqvist' },
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

export function toFhirBundle(observations: (StoredObservation & { status: string })[], selfUrl: string, nextUrl: string | null) {
  return {
    resourceType: 'Bundle',
    type: 'searchset',
    meta: { tag: [{ system: LOCAL, code: 'synthetic', display: 'Synthetic test data' }] },
    link: [{ relation: 'self', url: selfUrl }, ...(nextUrl ? [{ relation: 'next', url: nextUrl }] : [])],
    entry: observations.map((o) => ({ fullUrl: `https://halsaplus.example/fhir/Observation/${o.id}`, resource: toFhirObservation(o), search: { mode: 'match' } })),
  };
}
