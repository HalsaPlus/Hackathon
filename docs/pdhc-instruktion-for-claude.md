# Instruktion till Claude: hämta vårdplaner och mätvärden från PDHC

*Klistra in hela texten i Claude. Den beskriver exakt hur MMD (HalsaPlus/Hackathon) hämtar beställningar och vårdplaner från PDHC och skickar mätvärden tillbaka, verifierat mot PDHC den 19 november 2026. Det finns ingen token i texten. Du har din egen.*

---

Du ska koppla upp mot PDHC som **leverantör** och ta fram allt som MMD har lyckats få ut: beställningarna, den frysta vårdplanen per beställning med aktiviteter, schema, utförare, mål och termer, och mätvärdena på de aktiviteter som är utförda. Bygg det i mitt projekt och mitt språk, men följ reglerna nedan exakt. De är framtagna mot PDHC:s riktiga svar, och flera skiljer sig från PDHC:s egen manual.

MMD:s kod är publik och kan läsas som referens: https://github.com/HalsaPlus/Hackathon
- `server/pdhc.ts`: anrop och felhantering.
- `server/sync.ts`: hämtning och stängda beställningar.
- `server/fhir.ts`: tolkning av FHIR och schema.
- `server/plandefinition.ts`: den frysta vårdplanen och reserven via planmallen.
- `server/concepts.ts`: termer.
- `server/report.ts`: att skicka värden.

## Regler

- **Bara syntetiska data.** PDHC får inte användas med riktiga patientuppgifter.
- **Min token** (Provider Access Token, PAT) ska ligga i en miljövariabel eller en lokal, ignorerad databas. Fråga mig var. Skriv den aldrig i kod, loggar, commits eller svar, och skriv aldrig ut `grant_token`.
- **Kopiera inget känsligt från PDHC:s manualer:** inga lösenord, nycklar, interna IP-adresser eller kontaktuppgifter.
- **Visa inte personnummer.** Patienten i nedladdningen har ett personnummer (`identifier`). Det används inte till något.

## Adresser

| Vad | Bas-URL | Inloggning |
| --- | --- | --- |
| Beställningar (request.pdhc) | `https://request.pdhc.se/api/v1` | `X-Provider-Token: <PAT>` |
| Rapporter och mätvärden (gateway.pdhc) | `https://gateway.pdhc.se/api/v1` | Rapport: `X-Provider-Token: <PAT>`. Läsa värden: `Authorization: Bearer <SSO-token>` |
| Planmallar och begrepp (plan.pdhc) | `https://plan.pdhc.se/api/v1` | Ingen |

PDHC:s manualer:
- https://pdhc.se/docs/provider/technical.md
- https://pdhc.se/docs/request/technical.md
- https://pdhc.se/docs/gateway/technical.md

## Steg 1: Testa anslutningen

`GET {request}/provider/feed?limit=1` med `X-Provider-Token`. Svaret är `{ "items": [...], "total": n }`.
- **401:** token fel, utgången eller återkallad.
- **403:** token saknar behörighet.

Flödet innehåller bara metadata, inga patientuppgifter.

## Steg 2: Lista beställningarna

`GET {request}/provider/feed?limit=200` (200 är max). Varje rad har bland annat:
- `service_request_guid`, `title` och `contract_guid`;
- `status`: matchningens status, t.ex. `sent`;
- `sr_status`: beställningens status, t.ex. `active`;
- `created_at` och `updated_at`, utan tidszon. Läs dem som UTC.

Viktigt:
- **Bara öppna beställningar finns i flödet.** En beställning som PDHC arkiverar försvinner från flödet, men dess FHIR-resurs säger fortfarande `status: active` (se steg 6).
- **Använd `since=<senaste updated_at>`** för att bara få det som är nytt eller ändrat. Ladda bara ner en beställning när dess `updated_at` har ändrats, eftersom varje nedladdning loggas hos PDHC som åtkomst till patientdata.
- **En beställning syns först när den har skickats.** Det sker strax efter att den skapats (i vårt fall 25 sekunder senare).

## Steg 3: Ladda ner en beställning

`GET {request}/provider/download/{service_request_guid}` med `X-Provider-Token`. Svaret är JSON med:

| Fält | Vad |
| --- | --- |
| `fhir_resource` | FHIR R5 `ServiceRequest` med `contained`: `Patient`, `Goal` och `CarePlan` |
| `grant_token` | Behövs för att rapportera värden. Spara det, men visa det aldrig. |
| `patient_guid`, `contract_guid`, `provider_org_guid`, `service_request_guid` | Nycklar |
| `sr_status`, `is_open` | Beställningens riktiga status. Den finns **utanför** FHIR-resursen. |
| `care_plan_guid`, `care_plan` | **Den instansierade, frysta vårdplanen.** Använd den. |

**Patienten.** `fhir_resource.subject.reference` är `#patient-<guid>` och pekar på den inbäddade `Patient`-resursen. Använd `patient_guid` från svaret som patientens id, inte den inbäddade resursens id, som har prefixet `patient-`.

**Den inbäddade FHIR-`CarePlan`.** Dess aktiviteter innehåller *bara* vilka begrepp som mäts:
```json
{ "performedActivity": [ { "concept": { "coding": [ { "system": "urn:pdhc:concept", "code": "<concept_guid>", "display": "CGM" } ] } } ] }
```
Den saknar titel, schema, gränser och `transaction_guid`. Ta dem från `care_plan`.

## Steg 4: Bygg vårdplanen från `care_plan`

```json
{
  "care_plan_guid": "…",
  "frozen_at": "2026-11-19T17:51:53.338391",
  "plan_definition_guid": "…",
  "plan_definition_title": "MMD_plan",
  "plan_definition_version": "1.0.0",
  "activities": [
    {
      "activity_guid": "…",
      "title": "Veckorapport",
      "description": null,
      "performer_type": "Practitioner",
      "timing_type": "repeat",
      "timing": { "repeat": { "count": 8, "frequency": 1, "period": 1, "periodUnit": "wk", "duration": 3, "durationUnit": "min" } },
      "transactions": [
        {
          "transaction_guid": "…",
          "concept_guid": "…",
          "concept_name": "systolic-blood-pressure",
          "unit": "mmHg",
          "range_min": 100,
          "range_max": 130,
          "requirement_type": "required",
          "response_type": "numeric"
        }
      ]
    }
  ]
}
```

**Regler för schemat.** `timing` är en FHIR Timing eller `null`.
- **`timing: null` och `timing_type: "once"`:** ett tillfälle, vid planens start.
- **`timing: null` och `timing_type: null`:** **inget schema**. Hitta inte på ett. Så var det för Veckorapport i en tidigare frusen plan.
- **Varaktighet utan schema.** Har `timing.repeat` bara `duration`/`durationUnit` och inget som säger hur ofta (`frequency`, `period`, `count`, `dayOfWeek`, `timeOfDay`, `when`, `bounds*`), är det **ett tillfälle**, inte varje dag. `duration` betyder hur länge varje tillfälle pågår.
- **Upprepning.** `frequency` gånger per `period` `periodUnit` (`d`, `wk`, `mo` …), högst `count` gånger.
- **Planens period.** Beställningen har ofta inget slutdatum. MMD använder `authoredOn` som start och sätter själv slutet till 12 veckor, eller längre om ett schema kräver det.
- **Utföraren.** `performer_type` säger vem som gör aktiviteten: `Patient` eller `Practitioner`.

**Knyt ihop med FHIR-`CarePlan`.** Para varje FHIR-aktivitet med en aktivitet i `care_plan` genom begreppens `concept_guid`, i första hand flest gemensamma begrepp och i andra hand position. Låt aktivitetens id bygga på FHIR-leveransen, inte på `care_plan`, så att den är stabil.

**Reserv.** Saknas `care_plan`, till exempel vid push, kan planmallen läsas via `instantiatesCanonical` (`GET https://plan.pdhc.se/api/v1/plandefinitions/{guid}`, `activities[]` med platta `timing_*`-fält). Mallen kan ha **ändrats** efter beställningen. Då stämmer varken schema eller `transaction_guid` med beställningen. Använd mallen bara när `care_plan` saknas, och flagga det.

**Mål.** Målet finns som inbäddad `Goal` med `target[].detailRange` (low/high), i det här fallet `cgm_mean_glucose` 4–8.

## Steg 5: Termer per begrepp

`GET https://plan.pdhc.se/api/v1/concepts/{concept_guid}` kräver ingen token. Fält:
- `concept_display_text`;
- `concept_type_name`, t.ex. Observation eller Procedure;
- `range_low` och `range_high`: begreppets tillåtna skala;
- `canonical_refnumber`: koden;
- `canonical_lib_url`: följ den, och `canonical_lib_url` i svaret är kodsystemet (`http://snomed.info/sct`, `http://loinc.org` eller en lokal kod);
- `response_type_url`: ger `response_type_name`, t.ex. numerical, Integer eller Slider;
- `unit_url`: ger `unit_name`.

Spara svaren en stund. De ändras sällan.

## Steg 6: Stängda beställningar

En beställning som försvinner ur flödet ska laddas ner en gång till för att läsa `sr_status` och `is_open`. Gör det högst var 15:e minut per beställning.
- **Stängd** betyder `is_open: false` eller `sr_status` som `archived`, `revoked`, `completed` eller `cancelled`.
- **Hantering:** en stängd beställning ska inte visas som aktiv och ska inte ta emot nya värden.

Flera beställningar kan peka på samma `care_plan_guid` med olika fryst innehåll. Den senaste öppna gäller.

## Steg 7: Mätvärden

### Skicka

`POST {gateway}/provider/report/{service_request_guid}` med `X-Provider-Token` och `Content-Type: application/json`:
```json
{
  "patient_guid": "<patient_guid>",
  "grant_token": "<grant_token>",
  "status": "in-progress",
  "report_payload": {
    "observations": [
      { "transaction_guid": "<från care_plan>", "value": 126, "recorded_at": "2026-11-19T18:55:00.000Z", "notes": "valfri text" }
    ]
  }
}
```
- **Tal, inte text.** `value` ska vara ett **JSON-tal** för numeriska begrepp. Med text, som `"126"`, svarar gatewayen `422 Expected numeric value, got str`, trots att manualens exempel använder text.
- **Rätt GUID.** Använd `transaction_guid` från **den här beställningens** `care_plan`.
- **Svaret** är `202` med `{ "status": "accepted", "observations_stored": n, "receipt_guid": "…", "action": "created", "is_late": false }`, inte `recorded` som manualen säger. Behandla både `accepted` och `recorded` som mottaget, och spara kvittot.
- **Ett kvitto per rapport.** Flera värden i samma rapport får samma kvitto. Ett värde per rapport, med var sin `recorded_at`, ger ett kvitto per värde.
- **Fel per fält.** Felsvar har `details[]` med `field` och `message` för varje fält.

### Läsa tillbaka det PDHC har sparat

En leverantörstoken (PAT) **kan inte** läsa värden. `GET {gateway}/observations?organization=…` svarar `401 missing bearer token` med `X-Provider-Token`, och `invalid token` om PAT skickas som Bearer.

Läsning kräver `Authorization: Bearer <SSO-token>` från sso.pdhc, för ett konto **med åtkomst till analysdelen**. Svaret är ett FHIR R5 searchset-Bundle av `Observation` med `basedOn`, `performer`, `referenceRange` och tillägg för kontrakt och plan.

`organization` är den beställande organisationen. Det är troligen vårdgivaren, som i vårt fall står först i `ServiceRequest.performer` (utan display) och är patientens vårdgivare i PDHC. Det har vi inte kunnat prova, så kontrollera det. Fråga mig efter en SSO-token om du behöver den, och visa den aldrig.

Har du ingen sådan åtkomst är leverantörens egen kopia av det den har skickat den enda källan. MMD sparar den i tabellen `observations`, med `transaction_guid`, värde, tid och kvitto.

## Steg 8: Kontrollera mot det MMD såg

Om din token gäller samma kontrakt som MMD:s (`93a4aab1-068e-49c9-ace1-f608686f09c6`) ska du se detta:

**Den öppna beställningen**
- **Id och status:** `a4dbcff2-a1e7-4e14-9d25-a02933e19bc9`, "MMD_plan", `sr_status: active`, `is_open: true`.
- **Vårdplan:** `6f8b0ea1-dba4-46a5-b944-5bb41d82cb0f`, frusen 2026-11-19 17:51:53 UTC, från mallen MMD_plan 1.0.0.
- **Mål:** cgm_mean_glucose 4–8, LOINC `105273-7`.

| Aktivitet | Schema | Utförare | Begrepp | Term | Enhet | Mål | Skala | transaction_guid |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| CGM | En gång | Patient | CGM | SNOMED `440404000` (Procedure) | mmol/L | 4–8 | 2–22 | `80762dc2-dc95-4246-827c-13fd1f49ae82` |
| Sleep ("rapportera sömntid") | Varje dag | Patient | sleep-duration | LOINC `93832-4` | h | 0–12 | 0–10 | `c8748729-ce3e-4132-b007-567bab3fe427` |
| Veckorapport | Varje vecka, högst 8 gånger | Practitioner | systolic-blood-pressure | SNOMED `271649006` | mmHg | 100–130 | 60–250, Integer | `9a0fbac3-31aa-4757-b5a3-cf3618c1fcdf` |
| | | | diastolic-blood-pressure | SNOMED `271650006` | mmHg | 60–80 | 30–150, Integer | `73632951-b7a2-497b-ad1d-487064b6a872` |
| | | | anxiety | SNOMED `48694002` | – | – | Slider, ingen skala | `37ed9a85-57e6-4945-bdf0-db22a27ca59a` |
| | | | stress | SNOMED `73595000` | – | – | 1–7, Slider | `94768738-9d5c-4f99-8623-77cc2ece1e1f` |

**Två arkiverade beställningar** (`sr_status: archived`, `is_open: false`, finns inte i flödet): `d6b81ca3-5149-46d5-9ba1-582716f263b2` och `3ec1555c-a79c-4a9c-870a-94a6b1b1e960`.
- Båda pekar på vårdplanen `74f6f0d8-7390-4490-a56d-631b4b59f7bc`.
- I den äldre har Veckorapport **inget schema**, och transaktionerna har andra GUID:er, t.ex. CGM `b48226ae…`.

**Mätvärden som MMD har skickat på den öppna beställningen.** Alla är syntetisk testdata, och PDHC svarade `accepted` på alla. Den senaste omgången:

| Tid (UTC) | Parameter | Värde | Kvitto |
| --- | --- | --- | --- |
| 2026-11-19 18:54:55 | CGM | 7.8 mmol/L | `fd2979d4-af38-4de0-af15-c1a3ad6a4f54` |
| 2026-11-19 18:54:57 | sleep-duration | 4.9 h | `c1ea678e-6934-419c-b4a5-d2909011d788` |
| 2026-11-19 18:55:00 | systolic-blood-pressure | 126 mmHg | `2cc6e4e9-e6f8-4a10-97f7-39efca268363` (4 värden i samma rapport) |
| 2026-11-19 18:55:00 | diastolic-blood-pressure | 85 mmHg | samma |
| 2026-11-19 18:55:00 | anxiety | 2 | samma |
| 2026-11-19 18:55:00 | stress | 6 | samma |

Tidigare samma kväll skickades fyra omgångar till: 18:07, 18:27, 18:29, och 18:31 med ett värde per rapport. Dessutom skickades tre värden direkt under felsökningen (sömn 7.2, och systoliskt 131 två gånger). Totalt finns 33 testvärden på beställningen. Varje värde från testknappen har en anteckning (`notes`) som börjar med "Testdata från MMD:s admin-konsol (syntetisk)" och, i de senare omgångarna, namnet på parametern.

## Fallgropar vi gick i

1. **Den inbäddade FHIR-`CarePlan` räcker inte.** Utan `care_plan` blev aktiviteterna "Activity 1–3" utan schema.
2. **Den aktuella planmallen gav fel schema och fel `transaction_guid`** för en beställning som frusits innan mallen ändrades. Använd `care_plan`.
3. **FHIR `status: active` betyder inte att beställningen är öppen.** Läs `sr_status` och `is_open`.
4. **Värden som text ger 422.** Skicka tal.
5. **Svaret är `accepted`, inte `recorded`,** och kvittot gäller per rapport.
6. **En FHIR Timing med bara `duration` är ett tillfälle,** inte varje dag.
7. **plan.pdhc renderar också mallar som FHIR R5:** `action[].timingTiming`, `participant[].role.text` som utförare (inte `type`), och begreppen som nästlade `action[]` med `_pdhc_concept_guid`. Läs `role` före `type`.

## Klart när

- Anslutningen är testad, och de öppna beställningarna listas.
- Varje öppen beställning visas med vårdplan, mål och aktiviteter, med schema, utförare, begrepp, term, enhet, mål och skala, och stämmer med tabellen i steg 8.
- Arkiverade beställningar visas som stängda, eller inte alls.
- Mätvärdena på utförda aktiviteter visas: från PDHC om du har en SSO-token med åtkomst till analysdelen, annars från din egen kopia. Varje värde visas med parameter, tid och kvitto.
- Inget av token, grant eller personnummer har skrivits ut, loggats eller committats.
