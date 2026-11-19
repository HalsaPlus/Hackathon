# Hälsa+ (simulerad backend)

> **Bara syntetiska testdata.** Andrea Lindqvist är en påhittad patient i Nordic Hackathon 2026-scenariot. Ingen verklig person beskrivs.

En liten backend som låtsas vara Hälsa+, patientappen. Den har en patient, Andrea, med:
- hennes egna mätvärden från flera enheter;
- hennes självskattningar i appen;
- de labbsvar hon har importerat från vården.

GUI:t anropar API:t. MMD och vården får samma data som FHIR.

- **Kontrakt:** [`openapi.yaml`](openapi.yaml) (OpenAPI 3.1).
- **Exempelsvar:** [`examples/`](examples/). De skapas ur API:ets riktiga svar med `node scripts/write-examples.ts`, med serverns klocka satt till 2026-11-19 12:00 UTC.

## Köra lokalt

Kräver Node 24.

```bash
cd halsa-plus
npm install
cp .env.example .env   # sätt HALSA_API_TOKEN
npm run dev
```

API:t svarar på http://localhost:3002:

```bash
curl http://localhost:3002/api/v1/health
curl -H "Authorization: Bearer <token>" "http://localhost:3002/api/v1/observations/latest"
curl -H "Authorization: Bearer <token>" "http://localhost:3002/api/v1/observations?type=glucose&from=2026-11-19T00:00:00Z"
```

| Kommando | Vad det gör |
| --- | --- |
| `npm run dev` | Startar servern och startar om den vid ändringar i `src/` |
| `npm start` | Startar servern (det Render kör) |
| `npm test` | Tester för data och API |
| `npx tsc --noEmit` | Typkontroll |
| `node scripts/write-examples.ts` | Skapar exemplen i `examples/` på nytt |

## Miljövariabler

| Variabel | Krävs | Vad |
| --- | --- | --- |
| `HALSA_API_TOKEN` | ja | Bearer-token för alla anrop utom `/api/v1/health`. Utan den svarar API:t `503`. |
| `CORS_ORIGINS` | för webbläsare | Tillåtna origins, kommaseparerade, till exempel `http://localhost:3001,https://<gui>.onrender.com`. `*` tillåter alla. |
| `DEMO_NOW` | nej | Standardvärde för demoklockan (`asOf`), ISO 8601. Utan den används verklig tid. |
| `PORT` | nej | Port, standard 3002. Render sätter den själv. |

## API i korthet

| Anrop | Vad |
| --- | --- |
| `GET /api/v1/health` | Lever tjänsten? Kräver ingen token. |
| `GET /api/v1/me` | Andreas profil: namn, födelsedatum, personnummer (testserie) och längd |
| `GET /api/v1/devices` | Enheterna och appen, med senaste synk (≤ `asOf`) |
| `GET /api/v1/observations` | Tidsserier, äldst först. Filter: `type`, `from`, `to`, `device`, `asOf`, `limit` (högst 5000) och `cursor`. `format=fhir` ger en FHIR R4-Bundle. |
| `GET /api/v1/observations/latest` | Senaste värdet per typ |
| `GET /api/v1/requests`, `POST /api/v1/requests/{id}/consent` | Platshållare för nästa steg. Listan är tom, och samtycke ger `404`. |

**Typer:** `blood-pressure`, `glucose`, `sleep`, `anxiety`, `stress`, `bmi` och `crp`.

### Demoklockan
- Data finns från **2026-03-01** (Paris-tid) till **28 dagar efter den dag servern startade**. Fönstret räknas om vid varje start.
- `asOf` (eller `DEMO_NOW`) bestämmer vad API:t visar: bara det som finns vid den tiden.
  - Sömn visas när hon vaknar.
  - Labbsvar visas när labbet har utfärdat dem.
- Utan `asOf` visas inget från framtiden.
- Ett GUI kan "spola fram" upp till fyra veckor med ett senare `asOf`.
- `status` skiljer verkliga värden från framtida:
  - **`final`**: tiden har redan passerat på riktigt.
  - **`preliminary`**: tiden ligger efter verklig nu. Värdet syns bara för att `asOf` ligger framåt i tiden. Visa aldrig ett sådant värde som om det redan hade hänt.

## Datan

Allt är **deterministiskt**. Samma dag får samma värden vid varje omstart.

| Typ | Enhet (källa) | Ursprung |
| --- | --- | --- |
| `glucose` | CGM-sensor, var 15:e minut | **Återanvänt:** generatorn `scripts/build-device-data.mjs` från Hälsa+-demon (repot Halsa-plus-demo), kopierad till [`src/synthetic/history.ts`](src/synthetic/history.ts) med samma frö och scenario. Värdena till och med **2026-11-15** är identiska med originalet, vilket ett test kontrollerar med en kontrollsumma. Därefter genereras de i [`extension.ts`](src/synthetic/extension.ts): sensorbyte var 14:e dag och en jämn nivå. |
| `blood-pressure` | Blodtrycksmätare | **Återanvänt** till och med 2026-11-15. Därefter några gånger i veckan, på morgonen. |
| `bmi` (+ `weight`, `height`) | Badrumsvåg, på söndagar | Vikten är **återanvänd** till och med 2026-11-15 och fortsätter sedan med samma modell. Längden är fast **168 cm**. BMI är vikt delat med längd i kvadrat, utan kategori. |
| `sleep` | Smartklocka, varje natt | Ny: läggtid, vakentid, sovminuter och uppvaknanden. Några nätter saknas, när klockan inte bars. |
| `anxiety`, `stress` | Hälsa+-appen, självskattning 0–10 per kväll | Ny, med missade dagar. Det är **inget validerat instrument**. |
| `crp` | Labb hos en vårdgivare (labbsvar som Andrea har importerat) | Se nedan. |

**Scenariot:**
- Andrea har bott i Paris sedan februari, och någon stress finns från början.
- Från mitten av april blir sömnen sämre, självskattningarna högre och de missade dagarna fler. CGM-luckorna växer och glukosen stiger fram till akutbesöket 2026-08-24 klockan 19:30 (19,3 mmol/L klockan 19:22).
- Under vårdtiden fram till utskrivningen 2026-08-27 klockan 15:00 finns inga värden. Utskrivningstiden är ett antagande.
- Efter utskrivningen förbättras det gradvis och ojämnt.

**CRP:**
- **Ur Andreas dokument:** Hôpital Valmorin, 2026-08-24 klockan 19:48 (Paris), 3 mg/L, utfärdat 20:41. Källan är `out/andrea/paris-lab.json` i repot Hackaton 2026. Dokumentets referensintervall och tolkning tas medvetet inte med. Inga andra CRP-värden finns i Andreas dokument eller i Hälsa+-demon.
- **Genererade**, för datum utan dokument:
  - 2026-09-10 och 2026-10-20, Hôpital Valmorin: uppföljning efter utskrivningen.
  - 2026-12-15, Vårdcentralen Norrskogen: `<5` mg/L (`comparator: "<"`), ett planerat besök i Uppsala.
- Värden under labbets gräns behåller sin `comparator` och tas aldrig bort.

**Inga tolkningar:** API:t har inga poäng, inga flaggor för högt, lågt eller normalt, inga färger, inga referensintervall och ingen statistik (medel, min, max). Ett test kontrollerar det.

## Render

Skapa en egen **Web Service** från repot `HalsaPlus/Hackathon`:

| Inställning | Värde |
| --- | --- |
| Root Directory | `halsa-plus` |
| Runtime | Node (version 24 läses från `.node-version`) |
| Build Command | `npm ci` |
| Start Command | `npm start` |
| Region | Frankfurt (EU Central) |
| Health Check Path | `/api/v1/health` |
| Environment | `HALSA_API_TOKEN` (hemligt), `CORS_ORIGINS` (GUI:ts adress), eventuellt `DEMO_NOW` |

Servern behöver ingen disk. Datan skapas i minnet vid start, på under en sekund. På Renders gratisnivå somnar tjänsten efter en stund utan anrop, och då tar första anropet längre tid. Väck den före demon.
