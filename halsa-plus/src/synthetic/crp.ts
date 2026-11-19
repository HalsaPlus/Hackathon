// CRP: lab results from Andrea's care providers that she has imported into
// Hälsa+. SYNTHETIC TEST DATA ONLY. Fixed values, not random.
//
// From her existing synthetic documents (read only, values copied as they are):
//   * Hôpital Valmorin, emergency visit, lab report: CRP 3 mg/L, sample
//     2026-08-24 19:48 +02:00, issued 20:41 +02:00
//     (Hackaton 2026: out/andrea/paris-lab.json, LOINC 1988-5). The document
//     also has a reference range and an interpretation; they are left out here
//     on purpose (no interpretation in this API).
// No other CRP exists in Andrea's documents (Nordvik, Norrskogen, the Paris
// discharge summary) or in the Hälsa+ demo seed.
//
// Generated for dates without any document (sparse: care contacts and planned
// follow-ups only):
//   * 2026-09-10 and 2026-10-20, Hôpital Valmorin: follow-up after discharge in Paris.
//   * 2026-12-15, Vårdcentralen Norrskogen: planned visit in Uppsala. Reported
//     as "<5" mg/L (comparator), the way a lab reports a value under its limit.

export interface LabResult {
  sampled: string;
  issued: string;
  provider: string;
  value: number;
  comparator?: '<' | '<=' | '>' | '>=';
  /** Where the value comes from (not served by the API). */
  origin: 'document' | 'generated';
}

export const CRP_RESULTS: LabResult[] = [
  { sampled: '2026-08-24T17:48:00Z', issued: '2026-08-24T18:41:00Z', provider: 'Hôpital Valmorin', value: 3, origin: 'document' },
  { sampled: '2026-09-10T06:20:00Z', issued: '2026-09-10T09:05:00Z', provider: 'Hôpital Valmorin', value: 2, origin: 'generated' },
  { sampled: '2026-10-20T06:35:00Z', issued: '2026-10-20T08:50:00Z', provider: 'Hôpital Valmorin', value: 4, origin: 'generated' },
  { sampled: '2026-12-15T07:10:00Z', issued: '2026-12-15T12:30:00Z', provider: 'Vårdcentralen Norrskogen', value: 5, comparator: '<', origin: 'generated' },
];
