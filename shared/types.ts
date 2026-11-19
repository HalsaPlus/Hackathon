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
  carePlan: {
    title: string | null;
    description: string | null;
    status: string | null;
    goals: Goal[];
  } | null;
  activities: ActivityView[];
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

export interface InboundLogEntry {
  id: number;
  receivedAt: string;
  channel: 'push' | 'poll' | 'demo';
  connectionName: string | null;
  serviceRequestGuid: string | null;
  outcome: 'created' | 'updated' | 'unchanged' | 'rejected' | 'error';
  message: string | null;
}
