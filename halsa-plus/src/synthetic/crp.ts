// CRP: lab results Andrea gets from an external lab she visits on her own
// initiative; the results end up in Hälsa+. INVENTED FOR THE DEMO, SYNTHETIC
// TEST DATA ONLY. Fixed values, not random.
//
// The lab, "Laboratoire Belvasse" in Paris, is fictional (not a real company).
// She lives in Paris (temporary address since 2026-02-01, no end date in her
// documents), so every sample is taken there.
//
// Roughly monthly from spring; none in July (the decline) and none during the
// hospital stay 2026-08-24 to 08-27. The hospital's own lab results stay in
// the hospital documents and are not part of this series. A few after
// discharge, and two in December that are only served with a later asOf.
//
// The lab reports a value under its limit as "<5" mg/L (comparator), the way
// a standard CRP method does; other values are whole numbers.

export const CRP_LAB = { name: 'Laboratoire Belvasse', city: 'Paris' };

export interface LabResult {
  /** Sample time (UTC). The Paris local time is in the comment. */
  sampled: string;
  issued: string;
  value: number;
  comparator?: '<' | '<=' | '>' | '>=';
}

export const CRP_RESULTS: LabResult[] = [
  { sampled: '2026-03-17T07:10:00Z', issued: '2026-03-17T14:40:00Z', value: 5, comparator: '<' }, // 08:10 Paris
  { sampled: '2026-04-15T06:20:00Z', issued: '2026-04-15T14:05:00Z', value: 5, comparator: '<' }, // 08:20
  { sampled: '2026-05-19T06:05:00Z', issued: '2026-05-19T13:30:00Z', value: 8 }, // 08:05
  { sampled: '2026-06-23T06:40:00Z', issued: '2026-06-23T15:10:00Z', value: 5, comparator: '<' }, // 08:40
  { sampled: '2026-08-04T07:15:00Z', issued: '2026-08-04T14:45:00Z', value: 6 }, // 09:15
  { sampled: '2026-09-22T06:15:00Z', issued: '2026-09-22T13:20:00Z', value: 5, comparator: '<' }, // 08:15
  { sampled: '2026-10-20T06:30:00Z', issued: '2026-10-20T14:00:00Z', value: 7 }, // 08:30
  { sampled: '2026-11-17T07:10:00Z', issued: '2026-11-17T13:55:00Z', value: 5, comparator: '<' }, // 08:10
  { sampled: '2026-12-01T07:20:00Z', issued: '2026-12-01T14:10:00Z', value: 5, comparator: '<' }, // 08:20
  { sampled: '2026-12-15T07:15:00Z', issued: '2026-12-15T14:35:00Z', value: 6 }, // 08:15
];
