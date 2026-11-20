# Vårdteamets chattkanal (FHIR messaging)

Andreas chatt i patientappen kopplas till vårdteamets system: hennes meddelanden skickas dit som FHIR-meddelanden, och vårdteamets svar kommer tillbaka in i chatten. Koden finns i `server/careteam-channel.ts`, `src/app/careteam.ts` och `src/components/CareTeamChannelCard.tsx`. **Bara syntetiska testdata.**

Utan inställningar fungerar chatten som förut: svar skrivs i adminsidan och skickas till CDR om en sådan finns.

## Koppla in vårdteamets endpoint

Admin → **Connection** → kortet **Care-team chat channel**:

| Fält | Vad du fyller i |
| --- | --- |
| Endpoint URL | Vårdteamets FHIR-bas, till exempel `https://…/fhir` |
| Token | Deras token. Sparas bara i databasen och visas aldrig, bara de sista fyra tecknen. |
| Auth header | Standard `Authorization: Bearer {token}`. Ändra till exempel till `X-Api-Key` om de vill ha token i en egen header. |
| Send path | Standard `$process-message`. Kan också vara en full URL. |
| Message text in | `R5`: `payload.contentCodeableConcept.text` (standard). `R4`: `payload.contentString`. |
| Replies from the care team | `Poll`: MMD hämtar var 30:e sekund. `Push`: de skickar till MMD. `Off`: MMD bara skickar. |
| Poll path | Standard `Communication?patient=Patient/{patientGuid}&_lastUpdated=gt{since}` |
| Push secret | Vid push: minst 16 tecken. Ge den till dem, tillsammans med push-adressen som kortet visar: `https://mmd-hackathon.onrender.com/api/v1/inbound/message` med headern `X-Push-Secret`. |
| Test path | Standard `metadata`, alltså `GET {endpoint}/metadata` |
| Patient GUID | Standard är Andrea, `28a29239-6424-48e7-a123-9d9e863670b8` |
| Care team patient aliases | Kommaseparerade id:n som vårdteamets system använder för samma patient. Standard `a7d3c1e2-5b4f-4c6a-9e8d-2f1b0c3d4e51` (Caspers demopatient). Ett svar om ett alias, eller utan patient, sparas för Andrea; andra patienter avvisas. |

Kryssa i **Channel on** och spara. Sedan:
- **Test connection** visar statuskod och svar.
- **Send test message** skickar ett syntetiskt testmeddelande.
- **Fetch now** hämtar svar direkt i poll-läge.

Bara meddelanden som skrivs efter att kanalen slogs på skickas.

### Caspers endpoint (kontrollerad 2026-11-20)

| Fält | Värde |
| --- | --- |
| Endpoint URL | `https://nordic-hackathon-2026.onrender.com/api/chat` |
| Token | Caspers token (från Christian, inte i repot) |
| Replies from the care team | Poll (han har ingen push) |
| Poll path | `Communication?_since={since}` |
| Övriga | standardvärden (`Authorization: Bearer {token}`, `$process-message`, R5) |

Hans system är FHIR R5, tar emot `$process-message` och söker `Communication` med `_since`. Hans token är inte knuten till ett patient-id, så matchningen görs hos oss med aliasen.

## Det MMD skickar

`POST {endpoint}/{sendPath}` med `Content-Type: application/fhir+json`. Kroppen är en `Bundle` av typen `message` och innehåller:

1. **`MessageHeader`:** med
   - `eventCoding` = `https://mmd.halsaplus.se/fhir/event#patient-message`;
   - `source.endpointUrl` = MMD:s publika adress;
   - `destination` = endpointen;
   - `focus` → kommunikationen.
2. **`Communication`:** Caspers format, med
   - `subject` = `Patient/28a29239-…` med personnumret som identifierare;
   - `sender` = patienten och `recipient` = Care team;
   - `basedOn` och `about` = hennes aktuella PDHC-beställning;
   - `sent`, och texten i `payload`;
   - `meta.tag` = `patient-reported`.
3. **`Patient`:** id, personnummer och födelsedatum.

Ett 2xx-svar räknas som levererat, och ett id i svaret sparas.
- **Nätverksfel:** prövas en gång till direkt.
- **Misslyckade leveranser:** prövas igen efter en minut, högst fem gånger. Kortet har också en **Retry**-knapp.
- **I appen:** under Andreas meddelande står "Sent to care team" eller "Not delivered – will retry".

## Vårdteamets system är master för chatten (poll)

- **Fullständig spegling:** vid varje hämtning hämtar MMD alla vårdteamets Communications för Andrea (`Communication?_since=2000-01-01T00:00:00Z`).
- **Andreas chatt görs lika med dem:**
  - nya läggs till;
  - ändrade uppdateras;
  - borttagna tas bort.
- **I en transaktion:** allt sker i samma transaktion, med Communication-id:t som nyckel.
- **Plankort (`system`)** rörs aldrig.
- **Avsändare:** en avsändare som är en Patient blir Andreas meddelande, allt annat vårdteamets. Tiden är `sent`.
- **Hennes nya meddelanden** skickas med `$process-message` och visas som väntande tills de kommer tillbaka från vårdteamets system. Då ersätts de av den speglade versionen. MMD känner igen meddelandet på något av tre sätt:
  - samma id som i svaret från `$process-message`;
  - vårt `mmd-message-<id>` med samma text;
  - samma text inom 10 minuter.
- **Utkorgen** skickar aldrig ett meddelande som kommit via speglingen.
- **Om hämtningen misslyckas** ändras ingenting, och den senaste speglingen står kvar.
- **Tider:** varje sekund medan någon har chatten öppen och synlig, annars var 30:e sekund.

## Det MMD tar emot

- **Format:** `Communication`-resurser i en `Bundle` (searchset eller message), med texten i `contentString` eller `contentCodeableConcept.text`.
- **Avsändarnamn:** `sender.display` visas vid svaret.
- **Dubbletter:** samma `Communication.id` sparas bara en gång.
- **Bara nytt:** bara det vårdteamet skrev efter att kanalen slogs på importeras.
- **Ignoreras:** MMD:s egna meddelanden (`meta.source` = `MMD`, id `mmd-message-…`, eller avsändare som är en Patient).
- **Avvisas och loggas:** meddelanden för andra patienter.
- **Push:** svaret är ett FHIR-svarsmeddelande med `MessageHeader.response`.

## Rapporterade värden till vårdteamet

Andreas rapporterade värden går till vårdteamets system i stället för PDHC:s gateway (`server/careteam-values.ts`). Två inställningar i kortet styr det:

- **Reported values go to** (`valuesTarget`): `careteam` (standard) eller `pdhc`, som förut. Går att växla tillbaka utan ny deploy.
- **Values URL** (`valuesUrl`): standard `https://nordic-hackathon-2026.onrender.com/api/mmd`.

**Anropet:** `POST {valuesUrl}` med samma token och auth-header som chatten. Kroppen är en `Bundle` av typen `transaction`, med en `Observation` per värde, var och en med `request: { method: POST, url: Observation }`.

**Varje Observation:**
- `status: final`;
- `category`: `vital-signs`, eller `survey` för 1–7-skattningar;
- `subject`: `Patient/<patientGuid>`, och för Andrea även hennes personnummer som `identifier`;
- `basedOn`: `ServiceRequest/<request.guid>`;
- `code.text`: värdets namn, och `coding` med PDHC:s concept-GUID (`urn:pdhc:concept`) och transaction-GUID (`urn:pdhc:transaction`) när de finns;
- `effectiveDateTime`: när värdet registrerades;
- `valueQuantity` (tal och enhet, UCUM när den är känd) för tal, annars `valueString`;
- `device.display` och `note` när de finns;
- `meta.tag`: källa MMD och patientrapporterat.

**Allt före utskicket är som förut:** samtyckesvakten, kontrollen av stängda planer, att värdena sparas lokalt, och demoläget för demoplaner.

**Utfall:**
- **2xx:** värdena markeras som skickade och bekräftade ("Sent to the care team"). Observation-id:na i svaret sparas som kvitto i `careteam_value_receipts`.
- **Annat svar, nätverksfel eller ingen token:** värdena markeras `failed` med ett kort meddelande. Token syns aldrig i meddelandet eller loggen.

Adminsidans testrapporter går samma väg.

## Frågor till Casper om hans API skiljer sig

- **Adress:** vilken är FHIR-basen? Tar de emot `$process-message`, eller vill de ha `POST /Bundle` eller `/Communication`? Det ändras i **Send path**.
- **Inloggning:** hur ser den ut? `Authorization: Bearer`, en egen header som `X-Api-Key`, eller något annat? Det ändras i **Auth header**.
- **FHIR-version:** R4 eller R5? Var ligger texten, i `contentString` eller `contentCodeableConcept.text`? Det ändras i **Message text in**.
- **Svar tillbaka:** poll eller push?
  - **Poll:** vilken sökning, och vilka parametrar för patient och "sedan"? Är det `_lastUpdated=gt…` eller `sent=gt…`, och anges patienten som `Patient/<guid>`? Det ändras i **Poll path**.
  - **Push:** kan de skicka en message-Bundle till vår adress med `X-Push-Secret`?
- **Identifiering:** känner de igen patienten på vår GUID `28a29239-…` eller på personnumret? Vi skickar båda.

## Lokalt med mocken

```bash
node scripts/mock-careteam.ts            # mock på http://localhost:4010
```

Ställ in kanalen med Endpoint URL `http://localhost:4010/fhir`, Token `mock-token` och Poll. Skriv sedan som Andrea i `/phone` och svara från mocken:

```bash
curl -X POST http://localhost:4010/reply -H "Content-Type: application/json" -d '{"text":"Hej Andrea!","sender":"Sjuksköterska Eva (demo)"}'
curl http://localhost:4010/messages      # allt mocken har tagit emot och svarat
```

**Push:** starta mocken med `MOCK_PUSH_URL=http://localhost:3001/api/v1/inbound/message` och `MOCK_PUSH_SECRET=<samma som i kortet>`, och välj Push i kortet.

**Värden:** sätt Values URL till `http://localhost:4010/api/mmd`. Mocken svarar med en `transaction-response` och sparar Bundle:n.
