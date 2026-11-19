import type { Goal, PeriodUnit, Timing, Transaction } from '../shared/types.ts';

// Reads what PDHC delivers to a provider and turns it into the app's own model.
//
// PDHC's manuals only show the outline (provider technical manual, section 6):
// a FHIR R5 ServiceRequest with `contained` CarePlan, Patient and Goals, where
// the CarePlan has `goal[]` and `activity[].detail`. How the schedule of an
// activity is written is not documented, so this parser accepts every form
// seen on the platform:
//
//   1. FHIR Timing in `activity[].detail.scheduledTiming` (FHIR R4 style, which
//      the PDHC manual's `detail` element suggests),
//   2. FHIR Timing in `timingTiming` (PlanDefinition.action),
//   3. plan.pdhc's own flat fields `timing_type`, `timing_frequency`,
//      `timing_period`, `timing_period_unit`, `timing_bounds_*` (as served by
//      GET https://plan.pdhc.se/api/v1/PlanDefinition),
//   4. FHIR R5 `plannedActivityReference` to a contained resource with
//      `occurrenceTiming`, `occurrencePeriod` or `occurrenceDateTime`.
//
// If the ServiceRequest carries no CarePlan but a PlanDefinition, the plan's
// actions are used as activities.

type Json = Record<string, any>;

const DELIVERY_TAG_SYSTEM = 'https://pdhc.se/delivery';

export class InboundError extends Error {}

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

function text(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function number(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

/** "Patient/abc", "#abc", "urn:uuid:abc" → "abc". */
export function referenceId(reference: unknown): string | undefined {
  const value = text(reference);
  if (!value) return undefined;
  if (value.startsWith('#')) return value.slice(1);
  if (value.startsWith('urn:uuid:')) return value.slice('urn:uuid:'.length);
  return value.split('/').filter(Boolean).at(-1);
}

/** Text of a CodeableConcept, or the display of its first coding. */
function conceptText(value: unknown): string | undefined {
  if (!isObject(value)) return text(value);
  if (text(value.text)) return text(value.text);
  for (const coding of list(value.coding)) {
    if (isObject(coding) && text(coding.display)) return text(coding.display);
  }
  if (isObject(value.concept)) return conceptText(value.concept); // CodeableReference
  return undefined;
}

const UNIT_ALIASES: Record<string, PeriodUnit> = {
  s: 's', sec: 's', second: 's', seconds: 's',
  min: 'min', minute: 'min', minutes: 'min',
  h: 'h', hr: 'h', hour: 'h', hours: 'h',
  d: 'd', day: 'd', days: 'd',
  wk: 'wk', w: 'wk', week: 'wk', weeks: 'wk',
  mo: 'mo', month: 'mo', months: 'mo',
  a: 'a', y: 'a', yr: 'a', year: 'a', years: 'a',
};

function periodUnit(value: unknown): PeriodUnit | undefined {
  const key = text(value)?.toLowerCase();
  return key ? UNIT_ALIASES[key] : undefined;
}

// --- Timing -------------------------------------------------------------------

/** FHIR Timing (event[] or repeat). */
export function timingFromFhir(timing: unknown): Timing | undefined {
  if (!isObject(timing)) return undefined;

  const events = list(timing.event).map(text).filter((v): v is string => !!v);
  if (events.length) return { kind: 'events', events };

  const repeat = timing.repeat;
  if (!isObject(repeat)) return undefined;

  const result: Timing = {
    kind: 'repeat',
    frequency: number(repeat.frequency) ?? 1,
    period: number(repeat.period) ?? 1,
    periodUnit: periodUnit(repeat.periodUnit) ?? 'd',
  };
  if (isObject(repeat.boundsDuration)) {
    result.boundsValue = number(repeat.boundsDuration.value);
    result.boundsUnit = periodUnit(repeat.boundsDuration.code ?? repeat.boundsDuration.unit) ?? 'd';
  }
  if (isObject(repeat.boundsPeriod)) {
    result.boundsStart = text(repeat.boundsPeriod.start);
    result.boundsEnd = text(repeat.boundsPeriod.end);
  }
  const count = number(repeat.count);
  if (count !== undefined) {
    if (count === 1 && repeat.period === undefined) return { kind: 'once' };
    result.count = count;
  }
  return result;
}

/** plan.pdhc's flat timing fields on a PlanDefinition action. */
export function timingFromPdhcFields(action: Json): Timing | undefined {
  const type = text(action.timing_type)?.toLowerCase();
  if (!type && action.timing_frequency === undefined && action.timing_period === undefined) return undefined;

  const unit = periodUnit(action.timing_period_unit) ?? 'd';
  if (type === 'once') {
    // A single occasion. The period is read as "within this long from the
    // start" (interpretation: the manuals do not say).
    const within = number(action.timing_period);
    return within ? { kind: 'once', offsetValue: within, offsetUnit: unit } : { kind: 'once' };
  }

  const result: Timing = {
    kind: 'repeat',
    frequency: number(action.timing_frequency) ?? 1,
    period: number(action.timing_period) ?? 1,
    periodUnit: unit,
  };
  const boundsValue = number(action.timing_bounds_duration_value);
  if (boundsValue && text(action.timing_bounds_mode) !== 'count') {
    result.boundsValue = boundsValue;
    result.boundsUnit = periodUnit(action.timing_bounds_duration_unit) ?? 'd';
  }
  const count = number(action.timing_bounds_count);
  if (count) result.count = count;
  return result;
}

function timingFromOccurrence(resource: Json): Timing | undefined {
  const fromTiming = timingFromFhir(resource.occurrenceTiming);
  if (fromTiming) return fromTiming;
  const dateTime = text(resource.occurrenceDateTime) ?? text(resource.start);
  if (dateTime) return { kind: 'events', events: [dateTime] };
  if (isObject(resource.occurrencePeriod) && text(resource.occurrencePeriod.start)) {
    return { kind: 'events', events: [text(resource.occurrencePeriod.start)!] };
  }
  return undefined;
}

// --- Activities ---------------------------------------------------------------

export interface ParsedActivity {
  key: string;
  title: string;
  description: string | null;
  performerType: string | null;
  status: string | null;
  timing: Timing;
  transactions: Transaction[];
}

function parseTransactions(value: unknown): Transaction[] {
  const result: Transaction[] = [];
  for (const item of list(value)) {
    if (!isObject(item)) continue;
    const name = text(item.concept_name) ?? text(item.name) ?? text(item.title) ?? conceptText(item.code);
    if (!name) continue;
    result.push({
      transactionGuid: text(item.transaction_guid) ?? text(item.guid),
      conceptGuid: text(item.concept_guid),
      name,
      requirement: text(item.requirement_type),
      rangeMin: number(item.range_min),
      rangeMax: number(item.range_max),
      expected: text(item.expected_value),
      unit: text(item.unit_name) ?? text(item.unit),
    });
  }
  return result;
}

function slug(value: string) {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // å → a, ö → o
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}

/**
 * One CarePlan.activity or PlanDefinition.action → the app's activity.
 * `contained` resolves R5 plannedActivityReference ("#id").
 */
export function parseActivity(raw: unknown, position: number, contained: Map<string, Json>): ParsedActivity | undefined {
  if (!isObject(raw)) return undefined;
  const detail = isObject(raw.detail) ? raw.detail : undefined;
  const plannedId = referenceId(raw.plannedActivityReference?.reference);
  const planned = plannedId ? contained.get(plannedId) : undefined;

  const codeText = conceptText(detail?.code) ?? conceptText(raw.code) ?? conceptText(planned?.code);
  const description =
    text(detail?.description) ?? text(raw.description) ?? text(planned?.description) ?? text(raw.textEquivalent);
  const title =
    text(raw.title) ??
    codeText ??
    text(raw.plannedActivityReference?.display) ??
    description ??
    `Activity ${position + 1}`;

  const timing =
    timingFromFhir(detail?.scheduledTiming) ??
    timingFromFhir(raw.timingTiming) ??
    timingFromPdhcFields(raw) ??
    (planned ? timingFromOccurrence(planned) : undefined) ??
    (text(detail?.scheduledString) || text(raw.timingString) ? { kind: 'unscheduled' as const } : undefined) ??
    (isObject(detail?.scheduledPeriod) && text(detail.scheduledPeriod.start)
      ? { kind: 'events' as const, events: [text(detail.scheduledPeriod.start)!] }
      : undefined) ??
    ({ kind: 'unscheduled' } satisfies Timing);

  const performerType =
    text(raw.performer_type) ??
    conceptText(list(detail?.performer)[0]) ??
    text((list(detail?.performer)[0] as Json | undefined)?.display) ??
    conceptText((list(raw.participant)[0] as Json | undefined)?.type) ??
    text((list(raw.participant)[0] as Json | undefined)?.type) ??
    null;

  const id = text(raw.id) ?? text(detail?.id) ?? text(raw.linkId) ?? plannedId;
  return {
    key: id ?? `${position + 1}-${slug(title)}`,
    title,
    description: description && description !== title ? description : null,
    performerType,
    status: text(detail?.status) ?? text(raw.status) ?? text(planned?.status) ?? null,
    timing,
    transactions: parseTransactions(raw.transactions ?? detail?.transactions ?? raw.transaction),
  };
}

// --- Goals ------------------------------------------------------------------

function parseGoal(raw: unknown, contained: Map<string, Json>): Goal | undefined {
  if (!isObject(raw)) return undefined;
  // A CarePlan points at contained Goals: { reference: "#goal-1" }.
  const resolved = raw.reference ? contained.get(referenceId(raw.reference) ?? '') : raw;
  if (!isObject(resolved)) return text(raw.display) ? { text: text(raw.display)! } : undefined;

  // plan.pdhc's flat goal fields.
  if (text(resolved.concept_name)) {
    const operator = text(resolved.target_operator);
    const quantity = text(resolved.target_quantity) ?? text(resolved.target_value);
    const unit = text(resolved.target_unit_name);
    const target = quantity ? [operator && !/^\d/.test(operator) ? operator : undefined, quantity, unit].filter(Boolean).join(' ') : undefined;
    return { text: text(resolved.description) ?? text(resolved.concept_name)!, target };
  }

  const description = conceptText(resolved.description) ?? text(resolved.description);
  if (!description) return undefined;
  const targets = list(resolved.target)
    .map((target) => {
      if (!isObject(target)) return undefined;
      const measure = conceptText(target.measure);
      const detail =
        text(target.detailString) ??
        (isObject(target.detailQuantity)
          ? [text(target.detailQuantity.comparator), text(target.detailQuantity.value), text(target.detailQuantity.unit)].filter(Boolean).join(' ')
          : undefined) ??
        (isObject(target.detailRange)
          ? `${text(target.detailRange.low?.value) ?? ''}–${text(target.detailRange.high?.value) ?? ''} ${text(target.detailRange.high?.unit) ?? ''}`.trim()
          : undefined);
      return [measure, detail].filter(Boolean).join(': ') || undefined;
    })
    .filter((v): v is string => !!v);
  return { text: description, target: targets.length ? targets.join('; ') : undefined };
}

// --- The whole delivery ---------------------------------------------------------

export interface ParsedDelivery {
  serviceRequest: Json;
  guid: string;
  status: string | null;
  intent: string | null;
  priority: string | null;
  title: string | null;
  authoredOn: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  patient: {
    guid: string;
    displayName: string | null;
    birthDate: string | null;
    gender: string | null;
    fhir: Json | null;
  };
  contractGuid: string | null;
  providerOrgGuid: string | null;
  receiptToken: string | null;
  grantToken: string | null;
  /** Every care plan in the request; several when it covers several conditions. */
  carePlans: ParsedCarePlan[];
}

export interface ParsedCarePlan {
  fhirId: string | null;
  title: string | null;
  description: string | null;
  status: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  goals: Goal[];
  activities: ParsedActivity[];
  fhir: Json;
}

/** Values PDHC puts in Bundle.meta.tag (system https://pdhc.se/delivery). */
export function deliveryTags(bundle: Json): Record<string, string> {
  const tags: Record<string, string> = {};
  for (const tag of list(bundle.meta?.tag)) {
    if (!isObject(tag) || tag.system !== DELIVERY_TAG_SYSTEM) continue;
    const name = text(tag.code);
    // The manual puts the value in `display`.
    const value = text(tag.display) ?? text(tag.value);
    if (name && value) tags[name] = value;
  }
  return tags;
}

function patientName(patient: Json | undefined, subject: Json | undefined): string | null {
  for (const name of list(patient?.name)) {
    if (!isObject(name)) continue;
    const full = text(name.text) ?? [...list(name.given).map(text), text(name.family)].filter(Boolean).join(' ');
    if (full) return full;
  }
  return text(subject?.display) ?? null;
}

export interface DeliveryContext {
  /** From the download response or the push. They win over what is in the resource. */
  grantToken?: string;
  receiptToken?: string;
  patientGuid?: string;
  contractGuid?: string;
  providerOrgGuid?: string;
}

/**
 * Accepts a push Bundle (type message), a Bundle from download, or a bare
 * ServiceRequest, and returns everything the app stores.
 */
export function parseDelivery(resource: unknown, context: DeliveryContext = {}): ParsedDelivery {
  if (!isObject(resource)) throw new InboundError('The body is not a JSON object.');

  // Everything the ServiceRequest may refer to: bundle entries and contained.
  const resources: Json[] = [];
  let serviceRequest: Json | undefined;
  let tags: Record<string, string> = {};

  if (resource.resourceType === 'Bundle') {
    tags = deliveryTags(resource);
    for (const entry of list(resource.entry)) {
      const entryResource = isObject(entry) ? entry.resource : undefined;
      if (!isObject(entryResource)) continue;
      if (entryResource.resourceType === 'ServiceRequest' && !serviceRequest) serviceRequest = entryResource;
      else resources.push(entryResource);
    }
  } else if (resource.resourceType === 'ServiceRequest') {
    serviceRequest = resource;
  }
  if (!serviceRequest) throw new InboundError('No ServiceRequest was found in what was sent.');

  for (const item of list(serviceRequest.contained)) if (isObject(item)) resources.push(item);

  const byId = new Map<string, Json>();
  for (const item of resources) {
    const id = text(item.id);
    if (id) byId.set(id, item);
  }
  // Resources contained in the CarePlans themselves (R5 planned activities, goals).
  const carePlanResources = resources.filter((r) => r.resourceType === 'CarePlan');
  for (const carePlan of carePlanResources) {
    for (const item of list(carePlan.contained)) {
      if (isObject(item) && text(item.id)) byId.set(text(item.id)!, item);
    }
  }

  const guid = referenceId(serviceRequest.id);
  if (!guid) throw new InboundError('The ServiceRequest has no id.');

  const subject = isObject(serviceRequest.subject) ? serviceRequest.subject : undefined;
  const subjectId = referenceId(subject?.reference);
  const patientFhir =
    (subjectId ? byId.get(subjectId) : undefined) ?? resources.find((r) => r.resourceType === 'Patient');
  const patientGuid =
    context.patientGuid ?? (subject?.reference?.startsWith('#') ? undefined : subjectId) ?? text(patientFhir?.id);
  if (!patientGuid) throw new InboundError('It is not clear which patient the request is for.');

  const contractGuid =
    context.contractGuid ??
    tags.contract_guid ??
    list(serviceRequest.basedOn)
      .map((ref) => (isObject(ref) ? text(ref.reference) : undefined))
      .find((ref) => ref?.startsWith('Contract/'))
      ?.slice('Contract/'.length);

  // The plans: every CarePlan, or failing that every PlanDefinition.
  const planSources = carePlanResources.length
    ? carePlanResources
    : resources.filter((r) => r.resourceType === 'PlanDefinition');
  const several = planSources.length > 1;
  const seen = new Set<string>();
  const carePlans: ParsedCarePlan[] = planSources.map((planSource, planIndex) => {
    const isCarePlan = planSource.resourceType === 'CarePlan';
    const planId = text(planSource.id) ?? `plan-${planIndex + 1}`;
    const activities: ParsedActivity[] = [];
    list(isCarePlan ? planSource.activity : planSource.action).forEach((raw, position) => {
      const activity = parseActivity(raw, position, byId);
      if (!activity) return;
      // Keys must be unique within the request, since done stops are stored
      // per request and key. With several plans the plan's id comes first.
      if (several) activity.key = `${planId}:${activity.key}`;
      if (seen.has(activity.key)) activity.key = `${activity.key}-${position + 1}`;
      seen.add(activity.key);
      activities.push(activity);
    });
    const period = isObject(planSource.period) ? planSource.period : undefined;
    return {
      fhirId: text(planSource.id) ?? null,
      title: text(planSource.title) ?? null,
      description: text(planSource.description) ?? null,
      status: text(planSource.status) ?? null,
      periodStart: text(period?.start) ?? null,
      periodEnd: text(period?.end) ?? null,
      goals: list(planSource.goal)
        .map((goal) => parseGoal(goal, byId))
        .filter((goal): goal is Goal => !!goal),
      activities,
      fhir: planSource,
    };
  });
  const firstPlan = carePlans[0];

  const occurrence = isObject(serviceRequest.occurrencePeriod) ? serviceRequest.occurrencePeriod : undefined;
  return {
    serviceRequest,
    guid,
    status: text(serviceRequest.status) ?? null,
    intent: text(serviceRequest.intent) ?? null,
    priority: text(serviceRequest.priority) ?? null,
    title: conceptText(serviceRequest.code) ?? text(serviceRequest.title) ?? (several ? null : firstPlan?.title) ?? null,
    authoredOn: text(serviceRequest.authoredOn) ?? null,
    periodStart: text(occurrence?.start) ?? firstPlan?.periodStart ?? null,
    periodEnd: text(occurrence?.end) ?? firstPlan?.periodEnd ?? null,
    patient: {
      guid: patientGuid,
      displayName: patientName(patientFhir, subject),
      birthDate: text(patientFhir?.birthDate) ?? null,
      gender: text(patientFhir?.gender) ?? null,
      fhir: patientFhir ?? null,
    },
    contractGuid: contractGuid ?? null,
    providerOrgGuid: context.providerOrgGuid ?? tags.organisation_guid ?? null,
    receiptToken: context.receiptToken ?? tags.receipt_token ?? null,
    grantToken: context.grantToken ?? tags.grant_token ?? null,
    carePlans,
  };
}
