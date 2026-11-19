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

Verified against a real delivery (2026-11-19): the delivered CarePlan's activities only list the concepts to measure (`activity[].performedActivity[].concept`, system `urn:pdhc:concept`). Title, schedule, performer, ranges, units and transaction GUIDs are in the plan template the CarePlan points to with `instantiatesCanonical` (`GET https://plan.pdhc.se/api/v1/plandefinitions/{guid}`, no token). `server/fhir.ts` reads the concepts and `server/plandefinition.ts` fills in the rest from the template. Activity keys come from the delivery alone, so they stay the same whether or not the template could be read.
