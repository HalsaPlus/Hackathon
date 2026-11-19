# MMD

MMD är en app för patientengagemang. Den tar emot en beställning (FHIR R5 `ServiceRequest`) från [PDHC](https://pdhc.se), sparar den och ritar patientens vårdplan som en tunnelbanekarta:

- **Linjer:** varje aktivitet i vårdplanen, till exempel dagbok, spirometri eller uppföljningsbesök.
- **Hållplatser:** de tillfällen då aktiviteten ska göras. De är utförda, missade, i dag eller kommande.
- **Start och mål:** alla linjer utgår från planens start och möts i målet.

Se [issue #1](https://github.com/HalsaPlus/Hackathon/issues/1).

> **Bara syntetiska data.** PDHC får inte användas med riktiga patientuppgifter, och inte heller den här appen.

## Köra lokalt

Kräver Node 24.

```bash
npm install
cp .env.example .env   # välj ett lösenord i ADMIN_PASSWORD
npm run dev
```

Öppna http://localhost:3001 och logga in med `admin` och lösenordet. Tryck på **Skapa exempelbeställning** för att se en karta utan uppkoppling mot PDHC.

| Kommando | Vad det gör |
| --- | --- |
| `npm run dev` | Server och webbapp på samma port, med omladdning vid ändring |
| `npm test` | Tester för mottagning, tolkning och lagring |
| `npm run build` | Typkontroll och produktionsbygge till `dist/` |
| `npm start` | Kör produktionsbygget |

## Ansluta till PDHC

Under **Anslutning** anger du:

- **URL:** `https://request.pdhc.se/api/v1` eller `https://gateway.pdhc.se/api/v1`.
- **Token:** er Provider Access Token (PAT), som PDHC-drift utfärdar.
- **Push-hemlighet:** behövs bara för push.

**Testa anslutningen** läser en rad ur PDHC:s lista (`GET /provider/feed?limit=1`) och laddar inte ner någon patientdata.

PDHC levererar beställningar på två sätt, och appen klarar båda:

| Sätt | Hur | I appen |
| --- | --- | --- |
| Hämtning | Appen läser `GET /provider/feed` och laddar ner nya eller ändrade beställningar med `GET /provider/download/{sr}` | Knappen **Hämta beställningar**, eller automatiskt varje minut |
| Push | PDHC skickar en FHIR-`Bundle` till `POST /api/v1/inbound/push` med `X-Push-Secret` | Svarar `202` och kvitterar med `POST /provider/receipt/{receipt_token}/ack` |

Push kräver att appen ligger på en publik adress. Lokalt fungerar bara hämtning.

## Hur det är byggt

- **Server:** Express i `server/`.
  - `fhir.ts` tolkar beställningen.
  - `store.ts` sparar i SQLite.
  - `pdhc.ts` anropar PDHC.
  - `sync.ts` hämtar och kvitterar.
  - `routes.ts` innehåller API:t.
- **Webbapp:** React i `src/`. Kartan finns i `src/components/MetroMap.tsx` och `src/metro.ts`.
- **Databas:** SQLite via Nodes inbyggda `node:sqlite`, i `data/mmd.sqlite`. Filen är gitignorerad, eftersom den innehåller token och patientdata. Tabellerna:

  | Tabell | Innehåll |
  | --- | --- |
  | `connections` | URL och token |
  | `patients` | Patienterna |
  | `service_requests` | Beställningarna, med rå FHIR, `grant_token` och `receipt_token` |
  | `care_plans` | Vårdplanerna |
  | `activities` | Linjerna |
  | `performances` | Utförda hållplatser |
  | `inbound_log` | Allt som kommit in |

- **Tidsschemat** för en aktivitet läses från FHIR `Timing` (`detail.scheduledTiming`, `timingTiming`) eller från plan.pdhc:s egna fält (`timing_type`, `timing_frequency`, `timing_period`, `timing_period_unit`, `timing_bounds_*`). PDHC dokumenterar inte vilket av dem som följer med i beställningen.

## Inte gjort än

- **Rapportera mätvärden** till gateway.pdhc (`POST /provider/report/{sr}`). `grant_token` sparas redan för det.
- **Patientinloggning.** Appen har bara en administratörsinloggning.
- **Driftsättning.** SQLite behöver en beständig disk.
- **Webhooks** av typen `service_request.dispatched` med `X-PDHC-Signature`.
