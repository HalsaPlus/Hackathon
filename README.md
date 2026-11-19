# MMD

MMD is a patient engagement app. It receives a request (FHIR R5 `ServiceRequest`) from [PDHC](https://pdhc.se) with one or more longitudinal care plans, and gives the patient:

- **the plan as a metro map:** one line per activity, one stop per occasion, and follow-ups as interchanges;
- **today's stops:** the patient measures and answers. Values a phone reads from Apple Health are simulated in the demo;
- **reports back to PDHC:** stamped as patient reported, with MMD as the source, and linked to the care plan and the day in the plan;
- **a chat with the care team:** every message is a FHIR `Communication`, sent as FHIR messaging;
- **their health data:** their own reported values next to their clinical summary (IPS), fetched through Health Connect.

See [issue #1](https://github.com/HalsaPlus/Hackathon/issues/1). The whole case is described on the start page of Nordic Hackathon 2026.

> **Synthetic data only.** PDHC may not be used with real patient data, and neither may this app.

## Two apps in one service

| Address | What | For whom |
| --- | --- | --- |
| `/app/` | The patient app, a PWA you can install on a phone | The patient |
| `/` | The admin console: patients, the plan as a horizontal metro map, the PDHC connection and the inbound log | The team |

In the demo both sit behind the same admin login. A real patient sign-in is a later step.

## Running it locally

Needs Node 24.

```bash
npm install
cp .env.example .env   # choose a password for ADMIN_PASSWORD
npm run dev
```

Open http://localhost:3001/app/ and sign in with `admin` and the password. Choose **Create the demo patient Andrea**. You get a request with three care plans (diabetes, rheumatology, ADHD), eight days of history, the chat that led to the plan, and a synthetic IPS.

| Command | What it does |
| --- | --- |
| `npm run dev` | Server and both apps on one port, with reload on change |
| `npm test` | Tests for receiving, parsing, storing and reporting |
| `npm run build` | Type check and production build to `dist/` |
| `npm start` | Runs the production build |
| `node scripts/make-icons.mjs` | Redraws the app icons |

## Connecting to PDHC

Under **Connection** in the admin console you enter these:

| Field | What it is |
| --- | --- |
| **URL** | `https://request.pdhc.se/api/v1` (or the gateway) |
| **Gateway URL** | `https://gateway.pdhc.se/api/v1`, where reports go |
| **Token** | Your Provider Access Token (PAT) |
| **Push secret** | Only needed for push |

PDHC delivers requests in two ways, and the app handles both:

- **Fetch:** the app reads `GET /provider/feed` and downloads new or changed requests with `GET /provider/download/{sr}`.
- **Push:** PDHC sends a FHIR `Bundle` to `POST /api/v1/inbound/push` with `X-Push-Secret`. The app answers `202` and acknowledges with `POST /provider/receipt/{receipt_token}/ack`. Push needs the app on a public address.

Reports from the patient app go to `POST /provider/report/{sr}` on gateway.pdhc, with the PAT and the request's `grant_token`. A demo request stays in demo mode, and the app says so.

## Optional settings

| Variable | What it does |
| --- | --- |
| `HEALTH_CONNECT_URL`, `HEALTH_CONNECT_TOKEN` | Fetches the IPS with `GET {url}/Patient/{id}/$summary`. Without them the demo IPS is shown, marked synthetic. |
| `CDR_FHIR_URL`, `CDR_SOURCE_SERVICE`, `CDR_SERVICE_KEY` | Sends each chat message as a FHIR message Bundle to the CDR. Without them the messages are kept in MMD. |
| `DATABASE_PATH`, `PORT` | Where the SQLite file lives (default `data/mmd.sqlite`) and the port (default 3001). |

The chat is also available as FHIR for the control tower: `GET /api/fhir/Communication?patient={id}`.

## How it is built

- **Server:** Express, in `server/`.
  - `fhir.ts` parses the request and its care plans.
  - `store.ts` stores everything in SQLite.
  - `report.ts` and `pdhc.ts` report to PDHC.
  - `messaging.ts` turns the chat into FHIR messaging.
  - `ips.ts` reads the IPS.
  - `demo.ts` builds Andrea.
- **Patient app:** React, in `src/app/`. The screens are in `src/app/screens/`. The style follows Hälsa+ (MyMedicalData).
- **Admin console:** React, in `src/`.
- **Database:** SQLite through Node's built-in `node:sqlite`, in `data/mmd.sqlite`. The file is gitignored, since it holds tokens and patient data.

## Open questions

- **Schedules:** how PDHC writes an activity's schedule inside the delivered CarePlan is not documented. The parser accepts FHIR `Timing` and plan.pdhc's `timing_*` fields.
- **Matching values:** the gateway matches values by `transaction_guid`. plan.pdhc does not always send one, so the concept GUID is used as a fallback.
- **The chat in the CDR:** the PDHC CDR manual does not list `Communication` or message Bundles, so whether the CDR accepts the chat has to be tried.
