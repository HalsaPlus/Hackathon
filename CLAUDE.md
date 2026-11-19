# MMD

A patient-engagement web app (React + Vite frontend, Express backend, SQLite via `node:sqlite`) that receives ServiceRequests with care plans from PDHC and draws the plan as a metro map. See `README.md` for running it and for the architecture.

## Rules

- This repository is **public**. Never commit `.env`, tokens, push secrets or the `data/` database.
- PDHC may only be used with synthetic data. Never put real patient data into PDHC, this app or this repo.
- Do not copy passwords, keys, internal IP addresses or personal contact details from the PDHC manuals; some manuals contain them.

## PDHC reference

- Provider flow (feed, download, push, ack, report): https://pdhc.se/docs/provider/technical.md
- Order engine (ServiceRequest, CarePlan, PAT, grant): https://pdhc.se/docs/request/technical.md
- Report ingest: https://pdhc.se/docs/gateway/technical.md
- Live care plan templates with activity timing: `GET https://plan.pdhc.se/api/v1/PlanDefinition`

The exact way PDHC writes an activity's schedule inside the delivered CarePlan is undocumented; `server/fhir.ts` accepts FHIR Timing and plan.pdhc's flat `timing_*` fields. Verify against a real delivery when one is available.
