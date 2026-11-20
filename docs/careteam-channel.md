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

Kryssa i **Channel on** och spara. Sedan:
- **Test connection** visar statuskod och svar.
- **Send test message** skickar ett syntetiskt testmeddelande.
- **Fetch now** hämtar svar direkt i poll-läge.

Bara meddelanden som skrivs efter att kanalen slogs på skickas.

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

## Det MMD tar emot

- **Format:** `Communication`-resurser i en `Bundle` (searchset eller message), med texten i `contentString` eller `contentCodeableConcept.text`.
- **Avsändarnamn:** `sender.display` visas vid svaret.
- **Dubbletter:** samma `Communication.id` sparas bara en gång.
- **Ignoreras:** MMD:s egna meddelanden (`meta.source` = `MMD`, id `mmd-message-…`, eller avsändare som är en Patient).
- **Avvisas och loggas:** meddelanden för andra patienter.
- **Push:** svaret är ett FHIR-svarsmeddelande med `MessageHeader.response`.

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
