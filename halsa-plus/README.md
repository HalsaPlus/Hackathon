# Hälsa+ (simulerad backend)

> **Bara syntetiska testdata.** Andrea Lindqvist är en påhittad patient i Nordic Hackathon 2026-scenariot.

En liten backend som låtsas vara Hälsa+, patientappen. Den har en patient, Andrea, med hennes egna mätvärden från flera enheter, hennes självskattningar och de labbsvar hon har importerat från vården.

## Status

**Kontraktet är klart, implementationen pågår.**

- [`openapi.yaml`](openapi.yaml): API-kontraktet (OpenAPI 3.1).
- [`examples/`](examples/): exempel på svar.

Exemplen för glukos, blodtryck och vikt/BMI innehåller exakt de värden som implementationen kommer att returnera. Exemplen för sömn och självskattningar visar formen, men siffrorna kommer att skilja sig.

## API i korthet

| Anrop | Vad |
| --- | --- |
| `GET /api/v1/health` | Lever tjänsten? Kräver ingen inloggning. |
| `GET /api/v1/me` | Andreas profil: namn, födelsedatum, personnummer (testserie) och längd. |
| `GET /api/v1/devices` | Hennes enheter och appen, med senaste synk. |
| `GET /api/v1/observations` | Tidsserier. Filter: `type`, `from`, `to`, `device`, `asOf`, `limit`, `cursor`. `format=fhir` ger en FHIR R4-Bundle. |
| `GET /api/v1/observations/latest` | Senaste värdet per typ. |
| `GET /api/v1/requests`, `POST /api/v1/requests/{id}/consent` | Platshållare för nästa steg: beställningar från vården och Andreas samtycke. |

**Typer:** `blood-pressure`, `glucose`, `sleep`, `anxiety`, `stress`, `bmi` och `crp`.

**Demoklocka:** `asOf` (eller env `DEMO_NOW`) styr vilken tidpunkt API:t visar. Data finns från 2026-03-01 till 28 dagar efter att servern startade. Värden efter verklig nu har `status: preliminary`, och värden före har `final`.

**Inloggning:** `Authorization: Bearer <HALSA_API_TOKEN>`. Webbläsare får anropa från de origins som står i `CORS_ORIGINS`.

**Inga tolkningar:** API:t har inga poäng, inga flaggor för högt eller lågt, inga referensintervall och ingen statistik. BMI räknas fram ur vikt och längd och får ingen kategori.

## Var data kommer ifrån

- **Glukos (CGM), blodtryck och vikt:** generatorn från Hälsa+-demon (`scripts/build-device-data.mjs`), med samma frö och scenario. Värdena till och med 2026-11-15 är identiska med originalet. Därefter skapas nya dagar med samma modell, och blodtrycket mäts då några gånger i veckan.
- **Längd:** fast 168 cm.
- **Sömn, ångest och stress:** nya, deterministiska serier som följer scenariot.
- **CRP:** labbsvar från vården.
  - 2026-08-24, 3 mg/L, från Hôpital Valmorins labbrapport (Andreas syntetiska dokument).
  - Genererade: 2026-09-10 och 2026-10-20 från Hôpital Valmorin (uppföljning efter utskrivningen), och 2026-12-15 `<5` mg/L från Vårdcentralen Norrskogen (planerat besök i Uppsala).
