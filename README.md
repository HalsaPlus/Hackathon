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
| `/phone` | The patient app inside a phone on a Hälsa+ background, for showing MMD full screen on a computer (F: full screen, R: reload the app) | Demos |

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

To do the same from another app, give [docs/pdhc-instruktion-for-claude.md](docs/pdhc-instruktion-for-claude.md) (in Swedish) to Claude. It is the whole method as verified against PDHC: feed, download, the frozen care plan, terms, closed requests, and sending and reading measurements. It holds no token.

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

Reports from the patient app go to `POST /provider/report/{sr}` on gateway.pdhc, with the PAT and the request's `grant_token`. Numeric values are sent as JSON numbers; the gateway refuses text with 422. It answers 202 with `status: accepted` and a receipt per report. A demo request stays in demo mode, and the app says so.

To try the round trip, press **Send test observations** on the connection. For every open request it sends one set of synthetic values per activity, varied and now and then outside the plan's range, exactly as if the patient had reported them. No two parameters get the same value in one click, and each value's note says it is test data and which parameter it was meant for (`… systolic-blood-pressure = 135 mmHg`), so a value that ends up on the wrong parameter at PDHC can be traced. By default each value goes in a report of its own with its own `recorded_at`; untick the box to send all of an activity's values in one report, as the patient app does. The table under the button shows each value, its `transaction_guid` and PDHC's receipt, and **Copy what was sent** copies the exact payloads (without the grant token) to share with PDHC.

## Other services

Every connection setting is stored in the database and entered under **Connection** in the admin console, in the card **Other services**. None of it is read from environment variables. Tokens and keys can be replaced or removed, but they are never shown again once saved.

| Setting | What it does |
| --- | --- |
| **Health Connect:** URL and token | Fetches the IPS with `GET {url}/Patient/{id}/$summary`, with the token as `Authorization: Bearer`. Without a URL the demo IPS is shown, marked synthetic. |
| **CDR:** URL, source service and service key | Sends each chat message as a FHIR message Bundle to `{url}/Bundle`, with `X-Source-Service` and `X-Service-Key`. Without a URL the messages are kept in MMD. |
| **This app:** public address | Written as the sender in the FHIR messages MMD sends. |

## Environment variables

Only what the server needs before it can open the database:

| Variable | What it does |
| --- | --- |
| `ADMIN_PASSWORD` | The admin login. Required. |
| `DATABASE_PATH`, `PORT` | Where the SQLite file lives (default `data/mmd.sqlite`) and the port (default 3001). |

The chat is also available as FHIR for the control tower: `GET /api/fhir/Communication?patient={id}`.

## AI assistants (MCP)

MMD is also an MCP server (issue #7). MCP is an open standard for how AI assistants call a service. With it, a patient can talk to ChatGPT, Claude or another assistant about their plan and values, and ask it to write to the care team. The assistant only reaches MMD, never PDHC. It never sees the PDHC token, `grant_token`, transaction GUIDs or the personal identity number, only what the patient sees in the app.

| Tool | What it gives |
| --- | --- |
| `get_my_plan` | The open care plans: goals, and per activity who does it, the schedule, what is measured with its target, and occasions done |
| `get_my_values` | Reported values for up to 120 days, optionally for one parameter, marked when outside the target |
| `get_today` | What is due today and whether it is done |
| `get_health_summary` | The IPS: conditions, medications, allergies, results |
| `get_messages` | The latest messages with the care team |
| `send_message_to_care_team` | Writes to the care team in the same chat as the app, marked "via ChatGPT". Only with `confirmed: true` after the patient has approved the exact text. |

**To connect ChatGPT:**
1. Start a tunnel to the app, for example `cloudflared tunnel --url http://localhost:3001`. ChatGPT cannot reach a local computer.
2. Enter the tunnel's address as **This app** under **Connection → Other services**.
3. On the patient's page in the admin console, make a link under **AI assistants (MCP)**. It is shown once.
4. Add the link in ChatGPT as an MCP server with no authentication (Settings → Apps & Connectors → Advanced → Developer mode). If an assistant wants an API key instead, use `{address}/mcp` and the key shown with the link.

The care team reads and answers the chat under **Chat with the patient** on the same page. Links can be revoked there. Only a hash of each link's secret is stored.

**Limits.**
- **Synthetic data only.** Everything the patient writes to the assistant goes to whoever runs it.
- **Demo sign-in.** The secret link is a demo sign-in. Real patients need OAuth, a data processing agreement, and a GDPR and PDL assessment, and health advice from a chatbot may count as a medical device.
- **ChatGPT plans.** On some ChatGPT plans custom connectors may be read-only, so sending a message may not be offered there.

## How it is built

- **Server:** Express, in `server/`.
  - `fhir.ts` parses the request and its care plans.
  - `plandefinition.ts` fills in each activity's title, schedule and transactions from the plan template on plan.pdhc.
  - `store.ts` stores everything in SQLite.
  - `report.ts` and `pdhc.ts` report to PDHC.
  - `messaging.ts` turns the chat into FHIR messaging.
  - `ips.ts` reads the IPS.
  - `settings.ts` stores how to reach Health Connect, the CDR and this app's address.
  - `mcp.ts` is the MCP server for AI assistants, and `assistant.ts` handles its secret links per patient.
  - `demo.ts` builds Andrea.
- **Patient app:** React, in `src/app/`. The screens are in `src/app/screens/`. The style follows Hälsa+ (MyMedicalData).
- **Admin console:** React, in `src/`.
- **Database:** SQLite through Node's built-in `node:sqlite`, in `data/mmd.sqlite`. The file is gitignored, since it holds tokens and patient data.

## Open questions

- **Schedules:** answered. The FHIR CarePlan only lists the concepts each activity measures (`performedActivity`). The schedule, titles, ranges and `transaction_guid` come from `care_plan` in `/provider/download`, the patient's instantiated CarePlan frozen when the request was made. Without it, the app falls back to the plan template in `instantiatesCanonical` on plan.pdhc. If that cannot be reached either, the request is stored without a schedule and the inbound log says so.
- **Closed requests:** PDHC archives a request without changing the FHIR `status`. The app reads `sr_status` and `is_open` from the download, and checks requests that vanish from the feed. A closed request is hidden from the patient and takes no reports. The admin console still shows it, marked as closed.
- **Matching values:** answered. The gateway matches values by `transaction_guid` from the frozen `care_plan`, and accepted them on 2026-11-19 (202, one receipt per report). Without them, the concept GUID is used as a fallback, which has not been tried.
- **The chat in the CDR:** the PDHC CDR manual does not list `Communication` or message Bundles, so whether the CDR accepts the chat has to be tried.
