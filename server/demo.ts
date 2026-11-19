import { parseDelivery } from './fhir.ts';
import { activityStops, clearPerformances, getPatientView, logInbound, seedPerformance, storeDelivery } from './store.ts';

// A synthetic delivery shaped like a PDHC push (provider technical manual,
// section 4): a Bundle of type "message" with receipt_token and grant_token in
// meta.tag, and a ServiceRequest with a contained Patient, Goals and CarePlan.
//
// The care plan follows plan.pdhc's "Asthma home monitoring" PlanDefinition,
// including its concept GUIDs, so the activities match what the platform
// actually has. The patient is the Swedish test person Tolvan Tolvansson and
// is entirely fictional. No real patient data, ever.
//
// The activities use two different schedule formats on purpose (FHIR Timing
// and plan.pdhc's flat timing_* fields), so the demo exercises both parsers.

const DAY = 24 * 60 * 60 * 1000;
const PATIENT_GUID = '6f1c2b8e-4d3a-4e5f-9a7b-1c2d3e4f5a60';
const SERVICE_REQUEST_GUID = '9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c61';

function startOfToday() {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

const isoDate = (time: number) => new Date(time).toISOString().slice(0, 10);

function transaction(conceptGuid: string, name: string, requirement: string) {
  return { concept_guid: conceptGuid, concept_name: name, requirement_type: requirement };
}

export function buildDemoBundle() {
  // The plan started five weeks ago and runs for twelve weeks.
  const start = startOfToday() - 35 * DAY;
  const end = start + 12 * 7 * DAY;

  return {
    resourceType: 'Bundle',
    type: 'message',
    meta: {
      tag: [
        { system: 'https://pdhc.se/delivery', code: 'receipt_token', display: 'demo-receipt' },
        { system: 'https://pdhc.se/delivery', code: 'grant_token', display: 'demo-grant' },
      ],
    },
    entry: [
      {
        resource: {
          resourceType: 'ServiceRequest',
          id: SERVICE_REQUEST_GUID,
          status: 'active',
          intent: 'order',
          priority: 'routine',
          code: { text: 'Astma – hemmonitorering' },
          subject: { reference: `Patient/${PATIENT_GUID}`, display: 'Tolvan Tolvansson' },
          authoredOn: new Date(start - 2 * DAY).toISOString(),
          occurrencePeriod: { start: isoDate(start), end: isoDate(end) },
          basedOn: [{ reference: 'Contract/demo-contract' }],
          contained: [
            {
              resourceType: 'Patient',
              id: PATIENT_GUID,
              name: [{ given: ['Tolvan'], family: 'Tolvansson' }],
              gender: 'male',
              birthDate: '1912-12-12',
            },
            {
              resourceType: 'Goal',
              id: 'goal-act',
              lifecycleStatus: 'active',
              description: { text: 'Välkontrollerad astma' },
              target: [{ measure: { text: 'ACT-poäng' }, detailString: 'minst 20' }],
            },
            {
              resourceType: 'Goal',
              id: 'goal-pef',
              lifecycleStatus: 'active',
              description: { text: 'Stabil lungfunktion' },
              target: [{ measure: { text: 'PEF' }, detailString: 'över 80 % av personligt bästa' }],
            },
            {
              resourceType: 'CarePlan',
              id: 'careplan-astma',
              status: 'active',
              intent: 'plan',
              title: 'Astma – hemmonitorering',
              description:
                'Daglig dagbok med symtom och PEF, spirometri varje vecka och uppföljning med astmasjuksköterskan.',
              period: { start: isoDate(start), end: isoDate(end) },
              goal: [{ reference: '#goal-act' }, { reference: '#goal-pef' }],
              activity: [
                {
                  // plan.pdhc's flat format.
                  id: 'inhalationsteknik',
                  title: 'Se filmen om inhalationsteknik',
                  description: 'En kort film om hur inhalatorn används rätt.',
                  performer_type: 'Patient',
                  timing_type: 'once',
                  timing_frequency: 1,
                  timing_period: 2,
                  timing_period_unit: 'd',
                  transactions: [],
                },
                {
                  // FHIR Timing in detail.scheduledTiming.
                  id: 'dagbok',
                  detail: {
                    code: { text: 'Symtomdagbok och PEF' },
                    description: 'Fyll i dagboken och mät PEF (peak flow) varje morgon.',
                    status: 'in-progress',
                    performer: [{ display: 'Patient' }],
                    scheduledTiming: { repeat: { frequency: 1, period: 1, periodUnit: 'd' } },
                  },
                  transactions: [
                    transaction('8baad6ac-486d-4428-ab37-9f971f43fd71', 'asthma-peak-flow', 'required'),
                    transaction('15cedab1-f694-467d-96dc-ad9bbd5794db', 'asthma-daytime-symptoms', 'required'),
                    transaction('6f6fbe8d-4e7e-4989-984a-b6d2b0ebcac4', 'asthma-night-waking', 'required'),
                    transaction('89864ae4-012f-4d62-9cb8-ac15ab66e6c4', 'asthma-reliever-use', 'required'),
                    transaction('0c15ab68-5c79-4a35-a123-60fb69e64cf3', 'asthma-controller-taken', 'required'),
                    transaction('45870f77-ce44-4ebb-85d0-b9af5917504f', 'asthma-wheeze', 'optional'),
                  ],
                },
                {
                  // plan.pdhc's flat format.
                  id: 'spirometri',
                  title: 'Spirometri hemma',
                  description: 'Mät FEV1 med hemspirometern.',
                  performer_type: 'Patient',
                  timing_type: 'repeat',
                  timing_frequency: 1,
                  timing_period: 1,
                  timing_period_unit: 'wk',
                  transactions: [transaction('6521528c-db59-45c5-a492-003c28f27623', 'FEV1', 'optional')],
                },
                {
                  id: 'act',
                  detail: {
                    code: { text: 'Astmakontrolltest (ACT)' },
                    description: 'Fem frågor om hur astman har påverkat dig de senaste fyra veckorna.',
                    status: 'scheduled',
                    performer: [{ display: 'Patient' }],
                    scheduledTiming: { repeat: { frequency: 1, period: 4, periodUnit: 'wk' } },
                  },
                  transactions: [],
                },
                {
                  id: 'uppfoljning',
                  detail: {
                    code: { text: 'Uppföljning hos astmasjuksköterskan' },
                    description: 'Genomgång av dagboken, spirometrin och ACT. Planen justeras vid behov.',
                    status: 'scheduled',
                    performer: [{ display: 'Astmasjuksköterska' }],
                    scheduledTiming: { event: [new Date(end - 3 * DAY + 9 * 60 * 60 * 1000).toISOString()] },
                  },
                  transactions: [],
                },
              ],
            },
          ],
        },
      },
    ],
  };
}

/** Which past stops the demo patient skipped, so the map shows missed stops too. */
function skipped(activityKey: string, index: number) {
  if (activityKey === 'dagbok') return index % 6 === 4 || index === 33;
  if (activityKey === 'spirometri') return index === 2;
  return false;
}

/**
 * Creates (or recreates, with fresh dates) the demo request through the same
 * path as a real push, then marks the past stops as done.
 */
export function createDemo() {
  const parsed = parseDelivery(buildDemoBundle());
  const outcome = storeDelivery(parsed, { channel: 'demo', connectionId: null });
  logInbound('demo', null, parsed.guid, outcome, 'Exempelbeställning (syntetiska data)');

  clearPerformances(parsed.guid);
  const today = startOfToday();
  for (const activity of parsed.carePlan?.activities ?? []) {
    const stops = activityStops(parsed.guid, activity.key) ?? [];
    stops.forEach((due, index) => {
      if (due.getTime() >= today || skipped(activity.key, index)) return;
      seedPerformance(parsed.guid, activity.key, index, new Date(due.getTime() + 8 * 60 * 60 * 1000).toISOString());
    });
  }
  return getPatientView(parsed.patient.guid)!;
}
