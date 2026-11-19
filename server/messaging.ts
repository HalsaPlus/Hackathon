// The chat as FHIR messaging. Every message is a FHIR R5 Communication,
// delivered as a Bundle of type "message" whose MessageHeader points at it.
//
// MMD always keeps the Communication itself. When a CDR is configured
// (CDR_FHIR_URL), the message Bundle is also sent there, so the chat can feed
// the control tower's search for patients who are not doing well.
//
// Note: the PDHC CDR manual lists ten FHIR resource types (Patient,
// Observation, QuestionnaireResponse, Condition, …) and Bundles of type
// transaction, batch and collection. Communication and message Bundles are not
// listed, so whether the CDR accepts them has to be tried; the outcome is kept
// per message.

const EVENT_SYSTEM = 'https://mmd.halsaplus.se/fhir/event';
const CATEGORY_SYSTEM = 'https://mmd.halsaplus.se/fhir/CodeSystem/message-category';

export interface ChatMessage {
  id: number;
  patientGuid: string;
  sender: 'patient' | 'care-team' | 'system';
  text: string;
  serviceRequestGuid: string | null;
  createdAt: string;
}

export function toCommunication(message: ChatMessage) {
  const patient = { reference: `Patient/${message.patientGuid}` };
  const careTeam = { display: 'Care team' };
  const fromPatient = message.sender === 'patient';
  return {
    resourceType: 'Communication',
    id: `mmd-message-${message.id}`,
    meta: {
      source: 'MMD',
      tag: fromPatient ? [{ system: 'https://mmd.halsaplus.se/fhir/tag', code: 'patient-reported', display: 'Patient reported' }] : [],
    },
    status: 'completed',
    category: [
      {
        coding: [{ system: CATEGORY_SYSTEM, code: message.sender === 'system' ? 'notification' : 'chat' }],
        text: message.sender === 'system' ? 'Notification' : 'Chat',
      },
    ],
    subject: patient,
    ...(message.serviceRequestGuid ? { basedOn: [{ reference: `ServiceRequest/${message.serviceRequestGuid}` }] } : {}),
    sender: fromPatient ? patient : message.sender === 'care-team' ? careTeam : { display: 'MMD' },
    recipient: [fromPatient ? careTeam : patient],
    sent: message.createdAt,
    // FHIR R5 has no contentString; plain text goes in contentCodeableConcept.text.
    payload: [{ contentCodeableConcept: { text: message.text } }],
  };
}

/** A FHIR message: MessageHeader first, then the Communication it is about. */
export function toMessageBundle(message: ChatMessage) {
  const communication = toCommunication(message);
  const focus = `urn:uuid:mmd-message-${message.id}`;
  return {
    resourceType: 'Bundle',
    type: 'message',
    timestamp: message.createdAt,
    entry: [
      {
        fullUrl: `urn:uuid:mmd-header-${message.id}`,
        resource: {
          resourceType: 'MessageHeader',
          eventCoding: { system: EVENT_SYSTEM, code: message.sender === 'patient' ? 'patient-message' : 'care-team-message' },
          source: { name: 'MMD', endpointUrl: process.env.PUBLIC_URL ?? 'https://mmd.example' },
          focus: [{ reference: focus }],
        },
      },
      { fullUrl: focus, resource: communication },
    ],
  };
}

export type CdrOutcome = { status: 'not-configured' | 'stored' | 'failed'; message: string };

/** Sends one chat message to the configured CDR as a FHIR message Bundle. */
export async function sendToCdr(message: ChatMessage): Promise<CdrOutcome> {
  const base = process.env.CDR_FHIR_URL?.replace(/\/+$/, '');
  if (!base) return { status: 'not-configured', message: 'No CDR configured; kept in MMD.' };
  const headers: Record<string, string> = { 'Content-Type': 'application/fhir+json', Accept: 'application/fhir+json' };
  if (process.env.CDR_SOURCE_SERVICE) headers['X-Source-Service'] = process.env.CDR_SOURCE_SERVICE;
  if (process.env.CDR_SERVICE_KEY) headers['X-Service-Key'] = process.env.CDR_SERVICE_KEY;
  try {
    const response = await fetch(`${base}/Bundle`, {
      method: 'POST',
      headers,
      body: JSON.stringify(toMessageBundle(message)),
      signal: AbortSignal.timeout(15_000),
    });
    if (response.ok) return { status: 'stored', message: `Stored in the CDR (${response.status}).` };
    const detail = (await response.text()).slice(0, 200);
    return { status: 'failed', message: `The CDR answered ${response.status}. ${detail}`.trim() };
  } catch (error) {
    return { status: 'failed', message: error instanceof Error ? `Could not reach the CDR: ${error.message}` : 'Could not reach the CDR.' };
  }
}
