// Writes examples/*.json from the API's real responses, so the examples in
// openapi.yaml always match the implementation. The server's clock is fixed to
// 2026-11-19 12:00Z (the day before the demo).
//
//   node scripts/write-examples.ts

import { writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { createApp } from '../src/app.ts';

const NOW = Date.parse('2026-11-19T12:00:00Z');
const TOKEN = 'examples';
const out = path.resolve(import.meta.dirname, '..', 'examples');

const app = createApp({ token: TOKEN, corsOrigins: [], now: () => NOW, startDate: '2026-11-19' });
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

for (const [file, url] of examples) {
  const res = await fetch(base + url, { headers: { Authorization: `Bearer ${TOKEN}` } });
  writeFileSync(path.join(out, file), JSON.stringify(await res.json(), null, 2) + '\n');
  console.log(res.status, file);
}
server.close();
