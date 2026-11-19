# MMD

A patient-engagement web app (React + Vite frontend, Express backend, SQLite via `node:sqlite`) that receives ServiceRequests with care plans from PDHC and draws the plan as a metro map. See `README.md` for running it and for the architecture.

## Rules

- This repository is **public**. Never commit `.env`, tokens, push secrets or the `data/` database.
- PDHC may only be used with synthetic data. Never put real patient data into PDHC, this app or this repo.
- Do not copy passwords, keys, internal IP addresses or personal contact details from the PDHC manuals; some manuals contain them.
- Connection settings (PDHC, Health Connect, the CDR, the app's public address) live in the database and are edited in the admin console, not in environment variables. Only `ADMIN_PASSWORD`, `DATABASE_PATH` and `PORT` stay in the environment, since they are needed before the database can be opened.

## PDHC reference

- Provider flow (feed, download, push, ack, report): https://pdhc.se/docs/provider/technical.md
- Order engine (ServiceRequest, CarePlan, PAT, grant): https://pdhc.se/docs/request/technical.md
- Report ingest: https://pdhc.se/docs/gateway/technical.md
- Live care plan templates with activity timing: `GET https://plan.pdhc.se/api/v1/PlanDefinition`

Verified against real deliveries (2026-11-19): the FHIR CarePlan's activities only list the concepts to measure (`activity[].performedActivity[].concept`, system `urn:pdhc:concept`). Title, schedule, performer, ranges, units and transaction GUIDs come from `care_plan` in `/provider/download`: the patient's instantiated CarePlan, frozen when the request was made, with that request's own transaction GUIDs. Only when it is missing (a push, an older delivery) does `server/plandefinition.ts` fall back to the live plan template in `instantiatesCanonical` (`GET https://plan.pdhc.se/api/v1/plandefinitions/{guid}`, no token), which may have changed since and then has other transaction GUIDs. Activity keys come from the delivery alone, so they stay the same either way.

PDHC closes a request outside the FHIR resource, whose `status` keeps saying `active`: `/provider/download` gives `sr_status` (e.g. `archived`) and `is_open`, and a closed request disappears from `/provider/feed`. `server/sync.ts` downloads requests that vanish from the feed once to read that, and a closed request is hidden from the patient and takes no reports.

Reports to gateway.pdhc (verified 2026-11-19): numeric values must be JSON numbers (a string gives 422 `Expected numeric value, got str`), and the answer is 202 with `status: accepted`, `observations_stored` and `receipt_guid`, not the manual's `recorded`.
