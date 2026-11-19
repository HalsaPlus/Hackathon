import type { IpsView } from '../shared/types.ts';
import { getSettings } from './settings.ts';

// The International Patient Summary (IPS): a FHIR document Bundle with a
// Composition and sections for problems, medications, allergies and results.
// MMD fetches it through Health Connect (step 11 of the flow), never straight
// from a CDR. This reads the parts the patient app shows.

type Json = Record<string, any>;

const list = (value: unknown): Json[] => (Array.isArray(value) ? value.filter((v) => v && typeof v === 'object') : []);

function conceptText(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const concept = value as Json;
  if (typeof concept.text === 'string' && concept.text.trim()) return concept.text.trim();
  for (const coding of list(concept.coding)) {
    if (typeof coding.display === 'string' && coding.display.trim()) return coding.display.trim();
  }
  if (concept.concept) return conceptText(concept.concept); // R5 CodeableReference
  return null;
}

export function parseIps(bundle: unknown, source: string, synthetic: boolean, fetchedAt: string): IpsView {
  const resources = list((bundle as Json)?.entry).map((entry) => entry.resource as Json).filter(Boolean);
  const of = (type: string) => resources.filter((r) => r.resourceType === type);

  return {
    fetchedAt,
    source,
    synthetic,
    problems: of('Condition')
      .map((c) => ({ name: conceptText(c.code) ?? 'Unnamed condition', since: c.onsetDateTime ?? null }))
      .filter((p) => p.name),
    medications: [...of('MedicationStatement'), ...of('MedicationRequest')].map((m) => ({
      name: conceptText(m.medicationCodeableConcept) ?? conceptText(m.medication) ?? 'Unnamed medication',
      dosage: list(m.dosage ?? m.dosageInstruction)[0]?.text ?? null,
    })),
    allergies: of('AllergyIntolerance').map((a) => ({
      name: conceptText(a.code) ?? 'Unnamed allergy',
      criticality: typeof a.criticality === 'string' ? a.criticality : null,
    })),
    results: of('Observation').map((o) => ({
      name: conceptText(o.code) ?? 'Result',
      value:
        o.valueQuantity?.value !== undefined
          ? String(o.valueQuantity.value)
          : (o.valueString ?? conceptText(o.valueCodeableConcept) ?? ''),
      unit: o.valueQuantity?.unit ?? null,
      date: o.effectiveDateTime ?? null,
    })),
  };
}

/**
 * Fetches the IPS from Health Connect with the standard FHIR operation
 * `Patient/{id}/$summary`. Only used when Health Connect is set up in the
 * admin console.
 */
export async function fetchIpsFromHealthConnect(patientGuid: string): Promise<unknown> {
  const { healthConnectUrl: base, healthConnectToken: token } = getSettings();
  if (!base) throw new Error('Health Connect is not set up. Add it under Connection in the admin console.');
  const headers: Record<string, string> = { Accept: 'application/fhir+json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${base}/Patient/${encodeURIComponent(patientGuid)}/$summary`, {
    headers,
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Health Connect answered ${response.status}.`);
  return response.json();
}

/** A synthetic IPS for the demo patient, shaped like the real document. */
export function buildDemoIps(patientGuid: string, today: number) {
  const day = 24 * 60 * 60 * 1000;
  const date = (daysAgo: number) => new Date(today - daysAgo * day).toISOString().slice(0, 10);
  const entry = (resource: Json) => ({ fullUrl: `urn:uuid:${resource.id}`, resource });
  const subject = { reference: `Patient/${patientGuid}` };
  return {
    resourceType: 'Bundle',
    type: 'document',
    timestamp: new Date(today).toISOString(),
    entry: [
      entry({
        resourceType: 'Composition',
        id: 'ips-demo-composition',
        status: 'final',
        type: { coding: [{ system: 'http://loinc.org', code: '60591-5', display: 'Patient summary Document' }] },
        subject,
        title: 'International Patient Summary',
      }),
      entry({ resourceType: 'Condition', id: 'ips-c1', subject, code: { text: 'Type 2 diabetes' }, onsetDateTime: date(2900) }),
      entry({ resourceType: 'Condition', id: 'ips-c2', subject, code: { text: 'Rheumatoid arthritis' }, onsetDateTime: date(1500) }),
      entry({ resourceType: 'Condition', id: 'ips-c3', subject, code: { text: 'ADHD' }, onsetDateTime: date(4000) }),
      entry({
        resourceType: 'MedicationStatement',
        id: 'ips-m1',
        subject,
        medicationCodeableConcept: { text: 'Metformin 500 mg' },
        dosage: [{ text: '1 tablet twice a day' }],
      }),
      entry({
        resourceType: 'MedicationStatement',
        id: 'ips-m2',
        subject,
        medicationCodeableConcept: { text: 'Methotrexate 15 mg' },
        dosage: [{ text: 'Once a week' }],
      }),
      entry({
        resourceType: 'MedicationStatement',
        id: 'ips-m3',
        subject,
        medicationCodeableConcept: { text: 'Methylphenidate 36 mg' },
        dosage: [{ text: 'Every morning' }],
      }),
      entry({ resourceType: 'AllergyIntolerance', id: 'ips-a1', patient: subject, code: { text: 'Penicillin' }, criticality: 'low' }),
      entry({
        resourceType: 'Observation',
        id: 'ips-o1',
        status: 'final',
        subject,
        code: { text: 'HbA1c' },
        valueQuantity: { value: 52, unit: 'mmol/mol' },
        effectiveDateTime: date(20),
      }),
      entry({
        resourceType: 'Observation',
        id: 'ips-o2',
        status: 'final',
        subject,
        code: { text: 'CRP' },
        valueQuantity: { value: 6, unit: 'mg/L' },
        effectiveDateTime: date(20),
      }),
    ],
  };
}
