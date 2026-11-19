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
    throw new PdhcError('The URL cannot be read.');
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !local) throw new PdhcError('The URL must start with https://.');
  if (url.username || url.password) throw new PdhcError('Do not put credentials in the URL.');
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
      return 'PDHC did not accept the token (401). Check that it is correct and has not expired or been revoked.';
    case 403:
      return 'The token is not allowed to do this (403).';
    case 404:
      return 'The address answers but does not have the PDHC call needed (404). Check the URL.';
    case 502:
    case 503:
    case 504:
      return `PDHC is not answering right now (${status}). Try again in a while.`;
    default:
      return `PDHC answered with error ${status}.`;
  }
}

async function call(connection: Connection, method: 'GET' | 'POST', path: string, body?: unknown, base = connection.base_url) {
  const url = `${base}${path}`;
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
    const reason = error instanceof Error && error.name === 'TimeoutError' ? 'no answer within 20 seconds' : 'network error';
    throw new PdhcError(`Could not reach ${host} (${reason}).`);
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
    throw new PdhcError(`${describeStatus(response.status)}${detail ? ` Answer: ${String(detail).slice(0, 200)}` : ''}`, response.status);
  }
  if (!textBody) return undefined;
  try {
    return JSON.parse(textBody) as unknown;
  } catch {
    throw new PdhcError('PDHC answered, but not with JSON. Check that the URL points at the API.');
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
    throw new PdhcError('The download had no fhir_resource.');
  }
  return body;
}

export async function acknowledge(connection: Connection, receiptToken: string) {
  await call(connection, 'POST', `/provider/receipt/${encodeURIComponent(receiptToken)}/ack`, { status: 'acknowledged' });
}

export interface GatewayReport {
  patient_guid: string;
  grant_token: string;
  status: 'in-progress' | 'completed';
  report_payload: {
    observations: { transaction_guid: string; value: string; recorded_at: string; notes?: string }[];
  };
}

/**
 * Sends observations to gateway.pdhc (provider technical manual, section 5).
 * Only transaction_guid, value, recorded_at and notes: the gateway derives
 * concept and unit from the request, and the organisation (the source) from
 * the PAT. Answers `status: "recorded"` when accepted.
 */
export async function reportToGateway(connection: Connection, gatewayUrl: string, serviceRequestGuid: string, report: GatewayReport) {
  const body = (await call(
    connection,
    'POST',
    `/provider/report/${encodeURIComponent(serviceRequestGuid)}`,
    report,
    gatewayUrl,
  )) as { status?: string; match_status?: string } | undefined;
  return { status: body?.status ?? 'unknown', matchStatus: body?.match_status ?? null };
}

/** Reads one feed item: proves that the URL and the token work, without downloading patient data. */
export async function testConnection(connection: Connection): Promise<string> {
  const feed = await fetchFeed(connection, null, 1);
  const total = feed.total ?? feed.items.length;
  return `The connection works. PDHC has ${total} ${total === 1 ? 'request' : 'requests'} for you.`;
}
