# Hälsa+ (simulerad backend)

> **Bara syntetiska testdata.** Andrea Lindqvist är en påhittad patient i Nordic Hackathon 2026-scenariot. Ingen verklig person beskrivs.

En liten backend som låtsas vara Hälsa+, patientappen. Data sparas i SQLite. Just nu finns en patient, Andrea, men fler kan läggas till utan kodändringar. Andrea har:
- hennes egna mätvärden från flera enheter;
- hennes självskattningar i appen;
- CRP-svar från ett externt labb som hon går till på eget initiativ (påhittat för demon).

GUI:t anropar API:t. MMD och vården får samma data som FHIR.

API:t går att köra på två sätt:
- **Monterat i MMD-tjänsten** under `/halsa-plus`, till exempel `http://localhost:3001/halsa-plus/api/v1/health`. Caspers `server/index.ts` monterar det före admininloggningen, eftersom Hälsa+ har sin egen inloggning med token.
- **Fristående** på port 3002 (`npm run dev` i `halsa-plus/`).

- **Kontrakt:** [`openapi.yaml`](openapi.yaml) (OpenAPI 3.1).
- **Exempelsvar:** [`examples/`](examples/). De skapas ur API:ets riktiga svar med `node scripts/write-examples.ts`, med serverns klocka satt till 2026-11-19 12:00 UTC.

## Köra lokalt

Kräver Node 24.

```bash
cd halsa-plus
npm install
cp .env.example .env   # sätt HALSA_ANDREA_TOKEN till ett långt slumpat värde
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
| `npm run patient:create -- --name "…" --pnr <12 siffror> --birth-date <ÅÅÅÅ-MM-DD>` | Lägger till en patient (bara syntetiska data). Skriver ut patientens guid. |
| `npm run token:create -- --patient <guid> --label <text>` | Skapar en token för en patient och skriver ut den **en gång**. Bara en hash sparas. |
| `npm run examples` | Skapar exemplen i `examples/` på nytt |

## Miljövariabler

| Variabel | Krävs | Vad |
| --- | --- | --- |
| `HALSA_DATABASE_PATH` | nej | SQLite-filen. Standard: `halsa-plus/.data/halsa-plus.sqlite` (git-ignorerad). På Render: `/var/data/halsa-plus.sqlite`. |
| `HALSA_ANDREA_TOKEN` | nej | Om den är satt, ser servern till att det finns en token med just det värdet för Andrea. Bara en hash sparas, och värdet loggas aldrig. Minst 16 tecken. Används på Render, där det inte finns något skal. |
| `HALSA_CORS_ORIGINS` | för webbläsare från en annan origin | Tillåtna origins, kommaseparerade. `*` tillåter alla. Behövs inte när GUI:t serveras av MMD-tjänsten. |
| `DEMO_NOW` | nej | Standardvärde för demoklockan (`asOf`), ISO 8601. Utan den används verklig tid. |
| `PORT` | nej | Port när API:t körs fristående, standard 3002. |

När API:t är monterat i MMD läses variablerna från MMD-tjänstens miljö eller från rotens `.env`.

## Inloggning: en token per patient

- `Authorization: Bearer <token>` talar om **vilken patient** som anropar. `/me`, `/devices`, `/observations`, `/requests` och samtycke ger och ändrar bara den patientens data.
- Det finns ingen gemensam token och ingen admin-token. Den tidigare `HALSA_API_TOKEN` är borttagen.
- Bara en SHA-256-hash av varje token sparas (tabellen `patient_tokens`). En token jämförs i konstant tid och visas bara en gång, när den skapas.
- **Andrea:** sätt `HALSA_ANDREA_TOKEN`, eller kör `npm run token:create -- --patient 28a29239-6424-48e7-a123-9d9e863670b8 --label "Caspers GUI"`.
- **Fler patienter:** först `npm run patient:create`, sedan `npm run token:create`. Ingen kodändring behövs.
- **Spärra en token:** sätt `revoked_at` på raden i `patient_tokens`.

## Databasen

SQLite via `node:sqlite`, i samma stil som MMD:s `server/db.ts` (se [`src/db.ts`](src/db.ts)).

| Tabell | Innehåll |
| --- | --- |
| `patients` | guid, namn, personnummer, födelsedatum, identifierarsystem, kön och längd |
| `patient_tokens` | patient, token-hash, etikett, skapad och spärrad |
| `devices` | patientens enheter och Hälsa+-appen |
| `observations` | alla mätvärden. `source` är `generated`, `patient-entered` eller `external-lab`. |
| `consent_decisions` | varje samtyckesbeslut. Tabellen fylls bara på; triggers stoppar ändringar och radering. |
| `seed_state` | hur långt den genererade datan är inläst |

**Andrea läses in vid första start**, med guid `28a29239-6424-48e7-a123-9d9e863670b8` (samma som hennes patient-GUID i PDHC), personnummer `200207252388` (visas som `20020725-2388`) och födelsedatum 2002-07-25. Hennes genererade data läses in idempotent: samma id och samma värden varje gång. En omstart lägger bara till de nya dagarna i fönstret, och det hon själv har matat in rörs aldrig.

## API i korthet

| Anrop | Vad |
| --- | --- |
| `GET /api/v1/health` | Lever tjänsten? Kräver ingen token. |
| `GET /api/v1/me` | Andreas profil: namn, födelsedatum, personnummer (testserie) och längd |
| `GET /api/v1/devices` | Enheterna och appen, med senaste synk (≤ `asOf`) |
| `GET /api/v1/observations` | Tidsserier, äldst först. Filter: `type`, `from`, `to`, `device`, `asOf`, `limit` (högst 5000) och `cursor`. `format=fhir` ger en FHIR R4-Bundle. |
| `GET /api/v1/observations/latest` | Senaste värdet per typ |
| `POST /api/v1/observations` | Patienten matar in ett värde: `anxiety`, `stress`, `glucose`, `blood-pressure`, `bmi` (vikt) eller `sleep`. Värdet sparas. |
| `GET /api/v1/requests` | Förfrågningar från vården. Platshållare, listan är tom. |
| `POST /api/v1/requests/{id}/consent` | Godkänn eller avböj (`accept`/`decline`). Beslutet sparas, och det senaste gäller. |
| `GET /api/v1/requests/{id}/consent` | Alla beslut för en förfrågan, äldst först |

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

Den genererade datan är **deterministisk**. Samma dag får samma värden vid varje omstart.

| Typ | Enhet (källa) | Ursprung |
| --- | --- | --- |
| `glucose` | CGM-sensor, var 15:e minut | **Återanvänt:** generatorn `scripts/build-device-data.mjs` från Hälsa+-demon (repot Halsa-plus-demo), kopierad till [`src/synthetic/history.ts`](src/synthetic/history.ts) med samma frö och scenario. Värdena till och med **2026-11-15** är identiska med originalet, vilket ett test kontrollerar med en kontrollsumma. Därefter genereras de i [`extension.ts`](src/synthetic/extension.ts): sensorbyte var 14:e dag och en jämn nivå. |
| `blood-pressure` | Blodtrycksmätare | **Återanvänt** till och med 2026-11-15. Därefter några gånger i veckan, på morgonen. |
| `bmi` (+ `weight`, `height`) | Badrumsvåg, på söndagar | Vikten är **återanvänd** till och med 2026-11-15 och fortsätter sedan med samma modell. Längden är fast **168 cm**. BMI är vikt delat med längd i kvadrat, utan kategori. |
| `sleep` | Smartklocka, varje natt | Ny: läggtid, vakentid, sovminuter och uppvaknanden. Några nätter saknas, när klockan inte bars. |
| `anxiety`, `stress` | Hälsa+-appen, självskattning 0–10 per kväll | Ny, med missade dagar. Det är **inget validerat instrument**. |
| `crp` | Externt labb (Laboratoire Belvasse, Paris, påhittat) | Se nedan. |

**Scenariot:**
- Andrea har bott i Paris sedan februari, och någon stress finns från början.
- Från mitten av april blir sömnen sämre, självskattningarna högre och de missade dagarna fler. CGM-luckorna växer och glukosen stiger fram till akutbesöket 2026-08-24 klockan 19:30 (19,3 mmol/L klockan 19:22).
- Under vårdtiden fram till utskrivningen 2026-08-27 klockan 15:00 finns inga värden. Utskrivningstiden är ett antagande.
- Efter utskrivningen förbättras det gradvis och ojämnt.

**CRP:**
- **Påhittat för demon.** Andrea går på eget initiativ till ett externt labb, och svaren hamnar i Hälsa+.
- **Labbet:** **Laboratoire Belvasse** i Paris. Det är ett påhittat labb och inget riktigt företag. Alla prover tas i Paris, där Andrea bor sedan 2026-02-01; hennes dokument anger inget slutdatum för den adressen.
- **Datum:** ungefär en gång i månaden från mars.
  - Inget prov i juli och inget under vårdtiden 24–27 augusti.
  - Tre prover efter utskrivningen.
  - Två prover i december (1/12 och 15/12). De syns bara med ett senare `asOf` och har då `status: preliminary`.
- **Värden:** labbet svarar `<5` mg/L (`comparator: "<"`) när värdet ligger under dess gräns, och annars heltal (6, 7, 8). Värden med `comparator` tas aldrig bort.
- **Sjukhusets labbsvar ingår inte:** Hôpital Valmorins labbsvar från akutbesöket finns bara i sjukhusets dokument (repot Hackaton 2026) och är inte med i Hälsa+-serien.

**Inga tolkningar:** API:t har inga poäng, inga flaggor för högt, lågt eller normalt, inga färger, inga referensintervall och ingen statistik (medel, min, max). Ett test kontrollerar det.

## Render

**I MMD-tjänsten (det vi använder).** Hälsa+ följer med MMD-tjänsten, som redan har en disk på `/var/data`. Sätt dessa miljövariabler på MMD-tjänsten:

| Variabel | Värde |
| --- | --- |
| `HALSA_DATABASE_PATH` | `/var/data/halsa-plus.sqlite` |
| `HALSA_ANDREA_TOKEN` | ett långt slumpat värde (hemligt). Ge det till GUI:t. |
| `DEMO_NOW` | eventuellt |

API:t svarar då på `https://<mmd-tjänsten>/halsa-plus/api/v1/…`. Fler token kan skapas i tjänstens Shell med `cd halsa-plus && npm run token:create -- …`.

## Patientappen i MMD läser Hälsa+

MMD:s patientapp (`/app/`) hämtar värden från Hälsa+ för en patient som har en Hälsa+-länk. Koden finns i `server/halsa-link.ts`, `shared/halsa.ts` och `src/app/halsa.ts`.

- **Som en riktig integration:** MMD läser genom Hälsa+-API:t med patientens egen bearer-token, aldrig direkt ur Hälsa+-databasen.
- **Token:** finns bara på servern. Den skickas aldrig till webbläsaren och loggas aldrig.
- **Andrea:** hennes GUID i PDHC och i Hälsa+ är samma, så `HALSA_ANDREA_TOKEN` räcker. Samma värde används av Hälsa+ och av MMD.
- **Andra patienter:** får en rad i MMD:s tabell `halsa_links`.
- **Patienter utan länk:** behåller simuleringen i `src/app/healthkit.ts`.
- **Var Hälsa+ finns:** `HALSA_PLUS_URL`. Standard är Hälsa+ i samma tjänst, `http://127.0.0.1:$PORT/halsa-plus/api/v1`. Sätt den bara om Hälsa+ körs någon annanstans.
- **Koppling:** PDHC-begrepp mappas på concept GUID eller exakt begreppsnamn:

  | PDHC-begrepp | Hälsa+ |
  | --- | --- |
  | `CGM` | `glucose` |
  | `sleep-duration` | `sleep`, minuter omräknat till timmar med 2 decimaler |
  | `systolic-blood-pressure` / `diastolic-blood-pressure` | `blood-pressure` |
  | `anxiety` | `anxiety` |
  | `stress` | `stress` |
  | `weight` | `bmi.weight` |

- **`B-glucos` (blodsocker från fingerstick):** hämtas inte från Hälsa+.
- **Värden ändras aldrig:** inget klipps eller filtreras mot planens intervall.
- **Demoklockan:** `?asOf=2026-11-25T08:00:00Z` i appens adress flyttar Hälsa+-värdena. Planen följer den riktiga klockan.

**Fristående (valfritt).** Skapa en egen Web Service:

| Inställning | Värde |
| --- | --- |
| Root Directory | `halsa-plus` |
| Runtime | Node (version 24 läses från `.node-version`) |
| Build Command | `npm ci` |
| Start Command | `npm start` |
| Region | Frankfurt (EU Central) |
| Health Check Path | `/api/v1/health` |
| Disk | monterad på `/var/data`, med `HALSA_DATABASE_PATH=/var/data/halsa-plus.sqlite` |
| Environment | `HALSA_ANDREA_TOKEN` (hemligt), `HALSA_CORS_ORIGINS` (GUI:ts adress), eventuellt `DEMO_NOW` |

Utan disk försvinner det som matats in och alla samtyckesbeslut vid varje omstart. Andreas genererade data läses då in på nytt.
