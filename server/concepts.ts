// What plan.pdhc says about a concept (GET https://plan.pdhc.se/api/v1/concepts/{guid},
// no token): its allowed scale (range_low/range_high, e.g. stress 1–7), its
// response type (numerical, Integer, Slider …), its unit, and the term it is
// bound to (canonical_lib + canonical_refnumber, e.g. SNOMED CT 271649006).
// The plan's own range on a transaction is the care team's target; the
// concept's range is what a value may be at all.

type Json = Record<string, any>;

export interface ConceptInfo {
  guid: string;
  name: string | null;
  rangeLow?: number;
  rangeHigh?: number;
  /** e.g. "numerical", "Integer", "Slider". */
  responseType?: string;
  unit?: string;
  /** Absent when the concept is only in plan.pdhc's local code system without a code. */
  term?: { system: string; code: string; display?: string };
}

const PLAN_API = 'https://plan.pdhc.se/api/v1';
const TIMEOUT_MS = 8000;
const CACHE_MS = 60 * 60 * 1000;
const cache = new Map<string, { at: number; body: Json | null }>();

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
const str = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined);

/** GETs a plan.pdhc URL. URLs come from plan.pdhc's own answers, so nothing else is fetched. */
async function planJson(url: string | undefined): Promise<Json | null> {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'plan.pdhc.se' || parsed.port) return null;
  } catch {
    return null;
  }
  const cached = cache.get(url);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.body;
  let body: Json | null = null;
  try {
    const response = await fetch(url, { headers: { Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (response.ok) {
      const parsed = (await response.json()) as unknown;
      body = isObject(parsed) ? parsed : null;
    }
  } catch {
    body = null;
  }
  cache.set(url, { at: Date.now(), body });
  return body;
}

/** The concept as plan.pdhc describes it, or undefined when it cannot be read. */
export async function conceptInfo(conceptGuid: string | undefined): Promise<ConceptInfo | undefined> {
  if (!conceptGuid) return undefined;
  const concept = await planJson(`${PLAN_API}/concepts/${encodeURIComponent(conceptGuid)}`);
  if (!concept) return undefined;

  const [responseType, unit, library] = await Promise.all([
    planJson(str(concept.response_type_url)),
    planJson(str(concept.unit_url)),
    planJson(str(concept.canonical_lib_url)),
  ]);
  const system = str(library?.canonical_lib_url);
  const code = str(concept.canonical_refnumber);
  return {
    guid: conceptGuid,
    name: str(concept.concept_name) ?? null,
    rangeLow: num(concept.range_low),
    rangeHigh: num(concept.range_high),
    responseType: str(responseType?.response_type_name) ?? str(responseType?.name),
    unit: str(unit?.unit_name) ?? str(unit?.name),
    term: system && code ? { system, code, display: str(concept.concept_display_text) } : undefined,
  };
}
