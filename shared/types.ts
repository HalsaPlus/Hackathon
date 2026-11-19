// Shapes shared by the server and the web app.

export type PeriodUnit = 's' | 'min' | 'h' | 'd' | 'wk' | 'mo' | 'a';

/**
 * When an activity in the care plan should be done, normalised from whichever
 * form PDHC sends: FHIR Timing (`scheduledTiming`, `timingTiming`) or
 * plan.pdhc's flat `timing_*` fields.
 */
export interface Timing {
  kind: 'once' | 'repeat' | 'events' | 'unscheduled';
  /** repeat: times per period. */
  frequency?: number;
  /** repeat: length of the period, in periodUnit. */
  period?: number;
  periodUnit?: PeriodUnit;
  /** repeat: the activity only runs this long from the start of the plan. */
  boundsValue?: number;
  boundsUnit?: PeriodUnit;
  /** repeat: the activity only runs between these dates. */
  boundsStart?: string;
  boundsEnd?: string;
  /** repeat: at most this many times. */
  count?: number;
  /** once: how long after the start of the plan it is due. */
  offsetValue?: number;
  offsetUnit?: PeriodUnit;
  /** events: fixed dates. */
  events?: string[];
}

/** A data point an activity collects, as plan.pdhc calls it. */
export interface Transaction {
  transactionGuid?: string;
  conceptGuid?: string;
  name: string;
  requirement?: string;
  rangeMin?: number;
  rangeMax?: number;
  expected?: string;
  unit?: string;
}

export interface Goal {
  text: string;
  target?: string;
}

export interface Stop {
  index: number;
  dueAt: string;
  performedAt: string | null;
}

export interface ActivityView {
  key: string;
  /** Which care plan in the request the activity belongs to. */
  planId: string;
  planIndex: number;
  title: string;
  description: string | null;
  performerType: string | null;
  status: string | null;
  schedule: string;
  timing: Timing;
  transactions: Transaction[];
  stops: Stop[];
  /** True if there were more occurrences than the server returns. */
  truncated: boolean;
}

export interface ServiceRequestView {
  guid: string;
  title: string | null;
  status: string | null;
  intent: string | null;
  priority: string | null;
  source: 'push' | 'poll' | 'demo';
  connectionName: string | null;
  periodStart: string;
  periodEnd: string;
  /** False when PDHC sent no end date and the app chose one. */
  periodEndGiven: boolean;
  authoredOn: string | null;
  receivedAt: string;
  updatedAt: string;
  ackStatus: string | null;
  hasGrantToken: boolean;
  /** When the patient opened the plan in the app; null = not yet. */
  seenAt: string | null;
  /** One request can carry several longitudinal plans (diabetes, reumatologi …). */
  carePlans: PlanView[];
  activities: ActivityView[];
}

export interface PlanView {
  id: string;
  title: string | null;
  description: string | null;
  status: string | null;
  goals: Goal[];
}

// --- The patient app ------------------------------------------------------------

/** How a reported value went: sent to PDHC, failed, or kept in demo mode. */
export type ReportStatus = 'pending' | 'sent' | 'failed' | 'demo';

export interface ObservationView {
  id: number;
  serviceRequestGuid: string;
  activityKey: string;
  stopIndex: number | null;
  name: string;
  value: string;
  unit: string | null;
  recordedAt: string;
  /** The stamp: patient generated, from which app and device, and where in which plan. */
  patientReported: boolean;
  sourceApp: string;
  device: string | null;
  carePlanRef: string | null;
  planDay: number | null;
  reportStatus: ReportStatus;
  reportMessage: string | null;
  /** True when PDHC answered that it recorded the value (or, in demo mode, simulated). */
  confirmed: boolean;
}

/**
 * The patient's clinical summary as an IPS (International Patient Summary,
 * a FHIR document), fetched through Health Connect, never straight from a CDR.
 */
export interface IpsView {
  fetchedAt: string;
  source: string;
  /** True when the summary is synthetic demo data rather than fetched. */
  synthetic: boolean;
  problems: { name: string; since: string | null }[];
  medications: { name: string; dosage: string | null }[];
  allergies: { name: string; criticality: string | null }[];
  results: { name: string; value: string; unit: string | null; date: string | null }[];
}

export interface MessageView {
  id: number;
  sender: 'patient' | 'care-team' | 'system';
  text: string;
  serviceRequestGuid: string | null;
  createdAt: string;
  /** Whether the FHIR message reached the CDR. */
  cdrStatus: 'not-configured' | 'stored' | 'failed' | null;
}

export interface AppView {
  patient: PatientView['patient'];
  requests: ServiceRequestView[];
  observations: ObservationView[];
  ips: IpsView | null;
  messages: MessageView[];
}

export interface ReportValue {
  name: string;
  value: string;
  unit?: string;
  transactionGuid?: string;
  conceptGuid?: string;
  /** Where the value came from, e.g. "Hälsa (simulerat)". Empty when the patient typed it. */
  device?: string;
}

export interface ReportInput {
  serviceRequestGuid: string;
  activityKey: string;
  stopIndex: number;
  values: ReportValue[];
  note?: string;
}

export interface ReportResult {
  observations: ObservationView[];
  reportStatus: ReportStatus;
  reportMessage: string;
}

export interface PatientSummary {
  guid: string;
  displayName: string | null;
  birthDate: string | null;
  gender: string | null;
  requestCount: number;
  latestRequestTitle: string | null;
  updatedAt: string;
}

export interface PatientView {
  patient: Omit<PatientSummary, 'requestCount' | 'latestRequestTitle'>;
  requests: ServiceRequestView[];
}

export interface ConnectionView {
  id: number;
  name: string;
  baseUrl: string;
  /** Only the last characters, so the user can tell tokens apart. */
  tokenHint: string;
  /** Where reports go (gateway.pdhc). */
  gatewayUrl: string;
  hasPushSecret: boolean;
  pollEnabled: boolean;
  lastTestAt: string | null;
  lastTestOk: boolean | null;
  lastTestMessage: string | null;
  lastSyncAt: string | null;
  lastSyncMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Health Connect, the CDR and this app's address. Secrets only as a hint. */
export interface ServiceSettingsView {
  healthConnectUrl: string | null;
  healthConnectTokenHint: string | null;
  cdrUrl: string | null;
  cdrSourceService: string | null;
  cdrServiceKeyHint: string | null;
  publicUrl: string | null;
}

export interface InboundLogEntry {
  id: number;
  receivedAt: string;
  channel: 'push' | 'poll' | 'demo';
  connectionName: string | null;
  serviceRequestGuid: string | null;
  outcome: 'created' | 'updated' | 'unchanged' | 'rejected' | 'error';
  message: string | null;
}
