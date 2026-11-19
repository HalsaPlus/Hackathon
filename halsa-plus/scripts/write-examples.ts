// Writes examples/*.json from the API's real responses, so the examples in
// openapi.yaml always match the implementation. The server's clock is fixed to
// 2026-11-19 12:00Z (the day before the demo).
//
//   node scripts/write-examples.ts

import { writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { createApp } from '../src/app.ts';
import { openDatabase } from '../src/db.ts';

const NOW = Date.parse('2026-11-19T12:00:00Z');
const TOKEN = 'examples-token-not-a-secret';
const out = path.resolve(import.meta.dirname, '..', 'examples');

const database = openDatabase(':memory:');
const app = createApp({ database, andreaToken: TOKEN, corsOrigins: [], now: () => NOW, startDate: '2026-11-19' });
const server = app.listen(0);
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://localhost:${(server.address() as AddressInfo).port}`;

const AS_OF = 'asOf=2026-11-15T22:59:00Z';
const examples: [string, string][] = [
  ['health.json', '/api/v1/health'],
  ['me.json', '/api/v1/me'],
  ['devices.json', `/api/v1/devices?${AS_OF}`],
  // The last CGM readings before the emergency visit (19:22 Paris = 17:22Z).
  ['observations-glucose.json', `/api/v1/observations?type=glucose&from=2026-08-24T16:30:00Z&to=2026-08-24T17:30:00Z&${AS_OF}`],
  ['observations-blood-pressure.json', `/api/v1/observations?type=blood-pressure&from=2026-11-14T00:00:00Z&limit=3&${AS_OF}`],
  ['observations-bmi.json', `/api/v1/observations?type=bmi&from=2026-11-01T00:00:00Z&${AS_OF}`],
  ['observations-sleep.json', `/api/v1/observations?type=sleep&from=2026-11-13T00:00:00Z&${AS_OF}`],
  ['observations-self-ratings.json', `/api/v1/observations?type=anxiety,stress&from=2026-11-13T00:00:00Z&${AS_OF}`],
  // Fast-forwarded: the result of 2026-12-15 is a simulated future value (preliminary).
  ['observations-crp.json', '/api/v1/observations?type=crp&asOf=2026-12-16T12:00:00Z'],
  ['observations-latest.json', `/api/v1/observations/latest?${AS_OF}`],
  ['observations-fhir.json', `/api/v1/observations?format=fhir&type=glucose,blood-pressure,sleep,anxiety,bmi&from=2026-11-15T20:00:00Z&limit=6&${AS_OF}`],
  ['observations-fhir-crp.json', '/api/v1/observations?format=fhir&type=crp&asOf=2026-12-16T12:00:00Z'],
  ['requests.json', '/api/v1/requests'],
  ['error-400.json', '/api/v1/observations?asOf=2027-01-01T00:00:00Z'],
];

const write = (file: string, data: unknown) => writeFileSync(path.join(out, file), JSON.stringify(data, null, 2) + '\n');

for (const [file, url] of examples) {
  const res = await fetch(base + url, { headers: { Authorization: `Bearer ${TOKEN}` } });
  write(file, await res.json());
  console.log(res.status, file);
}

// Writes: a value Andrea enters herself, and a consent decision (request and response).
const posts: [string, string, unknown][] = [
  ['observation-post', '/api/v1/observations', { type: 'anxiety', value: 4, effectiveDateTime: '2026-11-19T11:30:00Z' }],
  ['observation-post-blood-pressure', '/api/v1/observations', {
    type: 'blood-pressure',
    effectiveDateTime: '2026-11-19T07:15:00Z',
    components: [{ code: 'systolic', value: 118 }, { code: 'diastolic', value: 76 }, { code: 'pulse', value: 64 }],
  }],
  ['consent-post', '/api/v1/requests/sr-9b8a7c6d/consent', { decision: 'accept' }],
];
for (const [name, url, body] of posts) {
  const res = await fetch(base + url, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  write(`${name}-request.json`, body);
  write(`${name}-response.json`, await res.json());
  console.log(res.status, name);
}
const history = await fetch(`${base}/api/v1/requests/sr-9b8a7c6d/consent`, { headers: { Authorization: `Bearer ${TOKEN}` } });
write('consent-history.json', await history.json());
console.log(history.status, 'consent-history.json');
server.close();
database.close();
