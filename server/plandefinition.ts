import type { Transaction } from '../shared/types.ts';
import { type ParsedActivity, type ParsedDelivery, parseTransactions, timingFromPdhcFields } from './fhir.ts';

// The CarePlan that request.pdhc delivers only says which concepts each
// activity measures. Title, schedule, performer, ranges, units and transaction
// GUIDs are in the plan template the CarePlan instantiates
// (`instantiatesCanonical`), served by plan.pdhc without a token:
//
//   GET https://plan.pdhc.se/api/v1/plandefinitions/{guid}
//
// Its `activities[]` carry plan.pdhc's flat `timing_*` fields and
// `transactions[]`, in `sort_order`. Each delivered activity is matched to a
// template activity by the concepts it measures, or failing that by position.
// What the delivery says always wins; the template only fills in what is missing.

type Json = Record<string, any>;

const PLAN_HOST = 'plan.pdhc.se';
const TIMEOUT_MS = 8000;
const MAX_BYTES = 2 * 1024 * 1024;
const CACHE_MS = 10 * 60 * 1000;
const cache = new Map<string, { at: number; template: Json }>();

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The URL to fetch for a canonical reference, or undefined if it is not a
 * plan.pdhc template. The reference comes from inbound data, so nothing else
 * is ever fetched.
 */
export function planDefinitionUrl(canonical: string): string | undefined {
  try {
    const url = new URL(canonical.split('|')[0]); // canonical|version
    if (url.protocol !== 'https:' || url.hostname !== PLAN_HOST || url.port) return undefined;
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return undefined;
  }
}

export type TemplateLoader = (url: string) => Promise<Json>;

export const fetchPlanDefinition: TemplateLoader = async (url) => {
  const cached = cache.get(url);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.template;

  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`plan.pdhc answered ${response.status}.`);
  const body = await response.text();
  if (body.length > MAX_BYTES) throw new Error('The plan template is too large.');
  const template = JSON.parse(body) as unknown;
  if (!isObject(template)) throw new Error('The plan template is not a JSON object.');
  cache.set(url, { at: Date.now(), template });
  return template;
};

/** The template's activities in order: `activities[]`, or the older `action` (an array or a JSON string). */
function templateActivities(template: Json): Json[] {
  let raw: unknown = template.activities;
  if (!Array.isArray(raw) || raw.length === 0) raw = template.action ?? template.fhir_data?.action;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      raw = [];
    }
  }
  const activities = (Array.isArray(raw) ? raw : []).filter(isObject);
  return activities
    .map((activity, index) => ({ activity, order: typeof activity.sort_order === 'number' ? activity.sort_order : index }))
    .sort((a, b) => a.order - b.order)
    .map((entry) => entry.activity);
}

const conceptsOf = (transactions: Transaction[]) =>
  new Set(transactions.map((t) => t.conceptGuid).filter((guid): guid is string => !!guid));

/** For each delivered activity, the template activity it was made from. */
function matchActivities(activities: ParsedActivity[], template: Json[]) {
  const templateTransactions = template.map((t) => parseTransactions(t.transactions));
  const used = new Set<number>();
  return activities.map((activity, position) => {
    const wanted = conceptsOf(activity.transactions);
    let best = -1;
    let bestOverlap = 0;
    if (wanted.size) {
      templateTransactions.forEach((transactions, index) => {
        if (used.has(index)) return;
        const overlap = [...conceptsOf(transactions)].filter((guid) => wanted.has(guid)).length;
        if (overlap > bestOverlap) [best, bestOverlap] = [index, overlap];
      });
    }
    if (best === -1 && position < template.length && !used.has(position)) best = position;
    if (best === -1) return undefined;
    used.add(best);
    return { template: template[best], transactions: templateTransactions[best] };
  });
}

/** Template values first, then every value the delivery itself gives. */
function mergeTransaction(fromTemplate: Transaction, delivered: Transaction): Transaction {
  const given = Object.fromEntries(Object.entries(delivered).filter(([, value]) => value !== undefined));
  return { ...fromTemplate, ...given } as Transaction;
}

function fillIn(activity: ParsedActivity, template: Json, templateTransactions: Transaction[]) {
  const title = typeof template.title === 'string' ? template.title.trim() : '';
  if (activity.derivedTitle && title) {
    activity.title = title;
    delete activity.derivedTitle;
  }
  const description = typeof template.description === 'string' ? template.description.trim() : '';
  if (!activity.description && description && description !== activity.title) activity.description = description;
  if (!activity.performerType && typeof template.performer_type === 'string') activity.performerType = template.performer_type;
  if (activity.timing.kind === 'unscheduled') activity.timing = timingFromPdhcFields(template) ?? activity.timing;

  if (!activity.transactions.length) {
    activity.transactions = templateTransactions;
    return;
  }
  activity.transactions = activity.transactions.map((delivered) => {
    const match = templateTransactions.find((t) => t.conceptGuid && t.conceptGuid === delivered.conceptGuid);
    return match ? mergeTransaction(match, delivered) : delivered;
  });
}

/**
 * Fills in each care plan's activities from its plan template on plan.pdhc.
 * Changes `parsed` in place. Returns what could not be done, for the inbound
 * log; the delivery is still stored as delivered.
 */
export async function applyPlanTemplates(parsed: ParsedDelivery, load: TemplateLoader = fetchPlanDefinition): Promise<string[]> {
  const problems: string[] = [];
  for (const plan of parsed.carePlans) {
    const url = plan.instantiates.map(planDefinitionUrl).find((u): u is string => !!u);
    if (!url || !plan.activities.length) continue;
    try {
      const template = templateActivities(await load(url));
      matchActivities(plan.activities, template).forEach((match, index) => {
        if (match) fillIn(plan.activities[index], match.template, match.transactions);
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'unknown error';
      problems.push(`The plan template for "${plan.title ?? 'the care plan'}" could not be read from plan.pdhc (${reason}).`);
    }
  }
  return problems;
}
