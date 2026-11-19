import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { buildDataset, isRatingType } from './synthetic/dataset.ts';
import { ER_MS, DISCHARGE_MS, generateHistory } from './synthetic/history.ts';

// SYNTHETIC TEST DATA ONLY.

test('the history is identical to the Hälsa+ demo generator (checksum of its output)', () => {
  const history = generateHistory();
  assert.equal(history.glucose.length, 20542);
  assert.equal(history.bp.length, 340);
  assert.equal(history.weight.length, 38);
  // sha256 of JSON.stringify(generate()) in Halsa-plus-demo/scripts/build-device-data.mjs.
  const checksum = createHash('sha256').update(JSON.stringify(history)).digest('hex');
  assert.equal(checksum, 'f1275f42f2157ef4c4a8b601893e900e1c5f12cc70610108df34ef0b7ab08cc4');
  // The scenario's fixed point: 19.3 mmol/L at 19:22 Paris on the evening of the emergency visit.
  assert.deepEqual(history.glucose.find((r) => r.at === '2026-08-24T17:22:00.000Z'), { at: '2026-08-24T17:22:00.000Z', value: 19.3 });
});

test('deterministic, and a later start only adds days at the end', () => {
  const a = buildDataset('2026-11-19');
  const b = buildDataset('2026-11-19');
  assert.deepEqual(a.entries, b.entries);
  const later = buildDataset('2026-11-26');
  const upTo = (entries: typeof a.entries) => entries.filter((e) => e.at <= a.end);
  assert.deepEqual(upTo(later.entries), a.entries);
  assert.ok(later.entries.length > a.entries.length);
});

test('the window runs from 2026-03-01 (Paris) to 28 days after the start date', () => {
  const d = buildDataset('2026-11-19');
  assert.equal(new Date(d.start).toISOString(), '2026-02-28T23:00:00.000Z');
  assert.equal(new Date(d.end).toISOString(), '2026-12-17T22:59:59.999Z');
  assert.ok(d.entries.every((e) => e.at >= d.start && e.at <= d.end));
  const ids = new Set(d.entries.map((e) => e.observation.id));
  assert.equal(ids.size, d.entries.length, 'ids are unique');
});

test('every type is present, and nothing is measured during the hospital stay', () => {
  const d = buildDataset('2026-11-19');
  const types = new Set(d.entries.map((e) => e.observation.type));
  assert.deepEqual([...types].sort(), ['anxiety', 'blood-pressure', 'bmi', 'crp', 'depression', 'energy', 'glucose', 'mood', 'sleep', 'steps', 'stress']);
  const during = d.entries.filter((e) => {
    const o = e.observation;
    const start = Date.parse(o.effectivePeriod?.start ?? o.effectiveDateTime ?? '');
    return o.type !== 'crp' && start < DISCHARGE_MS && e.at > ER_MS;
  });
  assert.deepEqual(during, []);
});

test('no jump where the generated days join the history', () => {
  const d = buildDataset('2026-11-19');
  const seam = d.entries.filter((e) => e.observation.type === 'glucose' && e.at > Date.parse('2026-11-15T22:00:00Z')).slice(0, 4);
  for (let i = 1; i < seam.length; i++) {
    assert.ok(Math.abs(seam[i].observation.value! - seam[i - 1].observation.value!) < 1, JSON.stringify(seam.map((e) => e.observation.value)));
  }
});

test('blood pressure only a few times a week after the history', () => {
  const d = buildDataset('2026-11-19');
  const newBp = d.entries.filter((e) => e.observation.type === 'blood-pressure' && e.at > Date.parse('2026-11-16T00:00:00Z'));
  const weeks = (d.end - Date.parse('2026-11-16T00:00:00Z')) / (7 * 86_400_000);
  assert.ok(newBp.length / weeks >= 1.5 && newBp.length / weeks <= 5, `${newBp.length} in ${weeks.toFixed(1)} weeks`);
});

test('CRP: one fictional external lab in Paris, roughly monthly, none during the stay', () => {
  const crp = buildDataset('2026-11-19').entries.filter((e) => e.observation.type === 'crp').map((e) => e.observation);
  assert.ok(crp.every((o) => o.sourceType === 'external-lab' && o.deviceId === null && o.issued && o.unit === 'mg/L'));
  assert.ok(crp.every((o) => JSON.stringify(o.performer) === JSON.stringify({ name: 'Laboratoire Belvasse', type: 'laboratory', city: 'Paris' })));
  const sampled = crp.map((o) => Date.parse(o.effectiveDateTime!));
  // Not the hospital's result, and nothing between the emergency visit and discharge.
  assert.ok(sampled.every((t) => t < ER_MS || t > DISCHARGE_MS));
  assert.ok(!crp.some((o) => o.effectiveDateTime === '2026-08-24T17:48:00Z'));
  // From spring, a few after discharge, and one or two in the four weeks after 2026-11-19.
  assert.ok(sampled[0] < Date.parse('2026-04-01T00:00:00Z'));
  const now = Date.parse('2026-11-19T12:00:00Z');
  assert.ok(sampled.filter((t) => t > DISCHARGE_MS && t <= now).length >= 2);
  const ahead = sampled.filter((t) => t > now && t <= now + 28 * 86_400_000).length;
  assert.ok(ahead >= 1 && ahead <= 2);
  for (let i = 1; i < sampled.length; i++) assert.ok(sampled[i] - sampled[i - 1] <= 50 * 86_400_000, 'roughly monthly');
  // A value under the lab's limit keeps its comparator.
  const below = crp.find((o) => o.comparator);
  assert.deepEqual([below?.comparator, below?.value], ['<', 5]);
});

test('self-ratings are integers 1–7 and BMI matches weight and height', () => {
  for (const { observation: o } of buildDataset('2026-11-19').entries) {
    if (isRatingType(o.type)) {
      assert.ok(Number.isInteger(o.value) && o.value! >= 1 && o.value! <= 7, `${o.id}: ${o.value}`);
      assert.equal(o.unit, '1–7');
    }
    if (o.type === 'bmi') {
      const kg = o.components!.find((c) => c.code === 'weight')!.value;
      const cm = o.components!.find((c) => c.code === 'height')!.value;
      assert.equal(o.value, Math.round((kg / (cm / 100) ** 2) * 10) / 10);
    }
  }
});

test('steps daily, energy/mood/stress/anxiety most evenings, depression about weekly', () => {
  const d = buildDataset('2026-11-19');
  const real = d.entries.filter((e) => e.at <= Date.parse('2026-11-19T12:00:00Z'));
  const count = (type: string, from: string) => real.filter((e) => e.observation.type === type && e.at >= Date.parse(from)).length;
  // The 8 weeks before the demo: 56 days.
  for (const type of ['steps', 'energy', 'mood', 'stress', 'anxiety']) {
    const n = count(type, '2026-09-24T00:00:00Z');
    assert.ok(n >= 35 && n <= 56, `${type}: ${n} in 56 days`);
  }
  const depression = count('depression', '2026-09-24T00:00:00Z');
  assert.ok(depression >= 4 && depression <= 8, `depression: ${depression} in 8 weeks`);
  // Some missed days and weeks.
  assert.ok(count('energy', '2026-03-01T00:00:00Z') < count('steps', '2026-03-01T00:00:00Z'));
  for (const e of real.filter((x) => x.observation.type === 'steps')) {
    assert.ok(Number.isInteger(e.observation.value) && e.observation.value! > 0 && e.observation.unit === 'steps');
    assert.equal(e.observation.deviceId, '9aadb89f-7c71-5a8a-bb38-f32fceb26615', 'from the smartwatch');
  }
});

test('the ratings and steps follow the scenario: worse before the emergency visit than in early spring', () => {
  const d = buildDataset('2026-11-19');
  const mean = (type: string, from: string, to: string) => {
    const values = d.entries
      .filter((e) => e.observation.type === type && e.at >= Date.parse(from) && e.at < Date.parse(to))
      .map((e) => e.observation.value!);
    return values.reduce((a, b) => a + b, 0) / values.length;
  };
  assert.ok(mean('stress', '2026-08-01', '2026-08-24') > mean('stress', '2026-03-01', '2026-04-01') + 1.5);
  assert.ok(mean('energy', '2026-08-01', '2026-08-24') < mean('energy', '2026-03-01', '2026-04-01') - 1.5);
  assert.ok(mean('steps', '2026-08-01', '2026-08-24') < mean('steps', '2026-03-01', '2026-04-01') - 2000);
});
