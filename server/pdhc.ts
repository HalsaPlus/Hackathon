// Calls to PDHC's provider surface, authenticated with the connection's
// Provider Access Token (PAT) in X-Provider-Token.
//
//   GET  {base}/provider/feed?since=&limit=         metadata only, no patient data
//   GET  {base}/provider/download/{sr}              the ServiceRequest + grant_token
//   POST {base}/provider/receipt/{receipt}/ack      acknowledge a push
//
// {base} is https://request.pdhc.se/api/v1 or https://gateway.pdhc.se/api/v1;
// the gateway forwards feed and download to request.pdhc.

const TIMEOUT_MS = 20_000;

export interface Connection {
  base_url: string;
  provider_token: string;
}

export class PdhcError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

/**
 * Accepts "request.pdhc.se", "https://request.pdhc.se", ".../api/v1" or
 * ".../api/v1/" and returns "https://request.pdhc.se/api/v1".
 */
export function normalizeBaseUrl(input: string): string {
  let value = input.trim();
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PdhcError('URL:en går inte att tolka.');
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !local) throw new PdhcError('URL:en måste börja med https://.');
  if (url.username || url.password) throw new PdhcError('Lägg inte inloggningsuppgifter i URL:en.');
  url.search = '';
  url.hash = '';
  let pathname = url.pathname.replace(/\/+$/, '');
  if (!/\/api\/v\d+$/.test(pathname)) pathname = `${pathname}/api/v1`;
  url.pathname = pathname;
  return url.toString().replace(/\/$/, '');
}

function describeStatus(status: number): string {
  switch (status) {
    case 401:
      return 'PDHC godtog inte token (401). Kontrollera att den är rätt och inte har gått ut eller återkallats.';
    case 403:
      return 'Token saknar behörighet för det här (403).';
    case 404:
      return 'Adressen svarar men har inte det PDHC-anrop som behövs (404). Kontrollera URL:en.';
    case 502:
    case 503:
    case 504:
      return `PDHC svarar inte just nu (${status}). Försök igen om en stund.`;
    default:
      return `PDHC svarade med fel ${status}.`;
  }
}

async function call(connection: Connection, method: 'GET' | 'POST', path: string, body?: unknown) {
  const url = `${connection.base_url}${path}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        Accept: 'application/json, application/fhir+json',
        'X-Provider-Token': connection.provider_token,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'error',
    });
  } catch (error) {
    const host = new URL(url).host;
    const reason = error instanceof Error && error.name === 'TimeoutError' ? 'inget svar inom 20 sekunder' : 'nätverksfel';
    throw new PdhcError(`Kunde inte nå ${host} (${reason}).`);
  }
  const textBody = await response.text();
  if (!response.ok) {
    let detail = '';
    try {
      const parsed = JSON.parse(textBody);
      detail = parsed?.message ?? parsed?.error ?? parsed?.issue?.[0]?.diagnostics ?? '';
    } catch {
      // Not JSON; the status says enough.
    }
    throw new PdhcError(`${describeStatus(response.status)}${detail ? ` Svar: ${String(detail).slice(0, 200)}` : ''}`, response.status);
  }
  if (!textBody) return undefined;
  try {
    return JSON.parse(textBody) as unknown;
  } catch {
    throw new PdhcError('PDHC svarade, men inte med JSON. Kontrollera att URL:en pekar på API:t.');
  }
}

export interface FeedItem {
  service_request_guid: string;
  match_guid?: string;
  status?: string;
  title?: string;
  updated_at?: string;
}

function readFeed(body: unknown): { items: FeedItem[]; total: number | undefined } {
  const object = (body ?? {}) as Record<string, unknown>;
  const raw = Array.isArray(body) ? body : Array.isArray(object.items) ? object.items : Array.isArray(object.data) ? object.data : [];
  const items = raw.filter(
    (item): item is FeedItem => typeof item === 'object' && item !== null && typeof (item as FeedItem).service_request_guid === 'string',
  );
  return { items, total: typeof object.total === 'number' ? object.total : undefined };
}

export async function fetchFeed(connection: Connection, since: string | null, limit = 50) {
  const query = new URLSearchParams({ limit: String(limit) });
  if (since) query.set('since', since);
  return readFeed(await call(connection, 'GET', `/provider/feed?${query}`));
}

export interface Download {
  fhir_resource: unknown;
  grant_token?: string;
  service_request_guid?: string;
  patient_guid?: string;
  contract_guid?: string;
  provider_org_guid?: string;
}

export async function download(connection: Connection, serviceRequestGuid: string): Promise<Download> {
  const body = (await call(connection, 'GET', `/provider/download/${encodeURIComponent(serviceRequestGuid)}`)) as Download | undefined;
  if (!body || typeof body !== 'object' || !('fhir_resource' in body)) {
    throw new PdhcError('Nedladdningen saknade fhir_resource.');
  }
  return body;
}

export async function acknowledge(connection: Connection, receiptToken: string) {
  await call(connection, 'POST', `/provider/receipt/${encodeURIComponent(receiptToken)}/ack`, { status: 'acknowledged' });
}

/** Reads one feed item: proves that the URL and the token work, without downloading patient data. */
export async function testConnection(connection: Connection): Promise<string> {
  const feed = await fetchFeed(connection, null, 1);
  const total = feed.total ?? feed.items.length;
  return `Anslutningen fungerar. PDHC har ${total} ${total === 1 ? 'beställning' : 'beställningar'} till er.`;
}
