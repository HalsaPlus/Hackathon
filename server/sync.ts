import { run, now } from './db.ts';
import { InboundError, parseDelivery } from './fhir.ts';
import { acknowledge, download, fetchFeed, PdhcError } from './pdhc.ts';
import { applyDeliveredCarePlan, applyPlanTemplates } from './plandefinition.ts';
import {
  type ConnectionRow,
  getConnection,
  listConnections,
  logInbound,
  openRequestGuids,
  serviceRequestPdhcUpdatedAt,
  setAckStatus,
  setPdhcState,
  storeDelivery,
} from './store.ts';

// Fetching from PDHC (poll, "Typ 2") and acknowledging pushes ("Typ 1").

const PAGE_SIZE = 50;
const MAX_PAGES = 20;
/** The feed's own maximum. */
const FULL_FEED_LIMIT = 200;
/** How often a request missing from the feed but still open is downloaded again. */
const RECHECK_MS = 15 * 60 * 1000;
const lastVanishedCheck = new Map<string, number>();
const running = new Set<number>();

function errorMessage(error: unknown) {
  if (error instanceof PdhcError || error instanceof InboundError) return error.message;
  return error instanceof Error ? `Unexpected error: ${error.message}` : 'Unexpected error.';
}

/**
 * Reads the feed and downloads every ServiceRequest that is new or changed
 * since last time. Unchanged ones are skipped, since every download is logged
 * as an access to patient data at PDHC.
 */
export async function syncConnection(id: number): Promise<{ ok: boolean; message: string }> {
  const connection = getConnection(id);
  if (!connection) return { ok: false, message: 'The connection does not exist.' };
  if (running.has(id)) return { ok: false, message: 'A fetch is already running.' };
  running.add(id);

  const counts = { created: 0, updated: 0, unchanged: 0, closed: 0, failed: 0 };
  let since = connection.feed_since;
  let newestSeen = since;
  let ok = true;
  let message: string;

  try {
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const feed = await fetchFeed(connection, since, PAGE_SIZE);
      for (const item of feed.items) {
        if (item.updated_at && (!newestSeen || item.updated_at > newestSeen)) newestSeen = item.updated_at;
        if (item.updated_at && serviceRequestPdhcUpdatedAt(item.service_request_guid) === item.updated_at) {
          counts.unchanged += 1;
          continue;
        }
        try {
          const body = await download(connection, item.service_request_guid);
          const parsed = parseDelivery(body.fhir_resource, {
            grantToken: body.grant_token,
            patientGuid: body.patient_guid,
            contractGuid: body.contract_guid,
            providerOrgGuid: body.provider_org_guid,
            pdhcStatus: body.sr_status ?? item.sr_status,
            isOpen: typeof body.is_open === 'boolean' ? body.is_open : undefined,
            carePlanGuid: body.care_plan_guid,
          });
          const problems = applyDeliveredCarePlan(parsed, body.care_plan) ? [] : await applyPlanTemplates(parsed);
          const outcome = storeDelivery(parsed, {
            channel: 'poll',
            connectionId: connection.id,
            matchGuid: item.match_guid,
            pdhcUpdatedAt: item.updated_at,
          });
          counts[outcome] += 1;
          logInbound('poll', connection.id, parsed.guid, outcome, problems.join(' ') || null);
        } catch (error) {
          counts.failed += 1;
          logInbound('poll', connection.id, item.service_request_guid, 'error', errorMessage(error));
        }
      }
      if (feed.items.length < PAGE_SIZE || newestSeen === since) break;
      since = newestSeen;
    }
    counts.closed = await closeVanished(connection);
    const parts = [
      counts.created && `${counts.created} new`,
      counts.updated && `${counts.updated} changed`,
      counts.unchanged && `${counts.unchanged} unchanged`,
      counts.closed && `${counts.closed} closed in PDHC`,
      counts.failed && `${counts.failed} failed`,
    ].filter(Boolean);
    message = parts.length ? `Fetched: ${parts.join(', ')}.` : 'No new requests.';
    ok = counts.failed === 0;
  } catch (error) {
    ok = false;
    message = errorMessage(error);
  } finally {
    running.delete(id);
  }

  // Only move the feed cursor forward when everything went through, so a
  // failed download is retried next time.
  run(
    `UPDATE connections SET last_sync_at = :at, last_sync_message = :message,
       feed_since = CASE WHEN :ok = 1 THEN :since ELSE feed_since END WHERE id = :id`,
    { at: now(), message, ok, since: newestSeen, id },
  );
  return { ok, message };
}

/**
 * The feed only lists open requests: one PDHC archives or revokes just stops
 * appearing, while its FHIR resource still says "active". So every request
 * MMD still treats as open but that is missing from the full feed is
 * downloaded once more to read sr_status and is_open. Returns how many were
 * found closed. Skipped when the feed is longer than one page, since then a
 * missing request may just be on another page.
 */
async function closeVanished(connection: ConnectionRow): Promise<number> {
  const stillOpen = openRequestGuids(connection.id);
  if (!stillOpen.length) return 0;
  const feed = await fetchFeed(connection, null, FULL_FEED_LIMIT);
  if (feed.total === undefined || feed.total > feed.items.length) return 0;
  const listed = new Set(feed.items.map((item) => item.service_request_guid));

  let closed = 0;
  for (const guid of stillOpen.filter((g) => !listed.has(g))) {
    // Every download is logged at PDHC as an access to patient data, so a
    // request that is missing but still open is not asked about every minute.
    const checkedAt = lastVanishedCheck.get(guid);
    if (checkedAt && Date.now() - checkedAt < RECHECK_MS) continue;
    lastVanishedCheck.set(guid, Date.now());
    try {
      const body = await download(connection, guid);
      const isOpen = typeof body.is_open === 'boolean' ? body.is_open : null;
      if (setPdhcState(guid, { status: body.sr_status ?? null, isOpen, carePlanGuid: body.care_plan_guid })) {
        closed += 1;
        logInbound('poll', connection.id, guid, 'updated', `Closed in PDHC (${body.sr_status ?? 'is_open false'}). Hidden from the patient.`);
      }
    } catch (error) {
      // Gone altogether: PDHC no longer lets this provider read it.
      if (error instanceof PdhcError && (error.status === 403 || error.status === 404 || error.status === 410)) {
        setPdhcState(guid, { status: 'unavailable', isOpen: false });
        closed += 1;
        logInbound('poll', connection.id, guid, 'updated', `PDHC no longer gives access (${error.status}). Hidden from the patient.`);
      } else {
        logInbound('poll', connection.id, guid, 'error', `Could not check whether it is still open: ${errorMessage(error)}`);
      }
    }
  }
  return closed;
}

/** Polls every connection that has automatic fetching turned on. */
export function startPolling(intervalMs: number) {
  const timer = setInterval(() => {
    for (const connection of listConnections()) {
      if (connection.poll_enabled === 1) void syncConnection(connection.id);
    }
  }, intervalMs);
  timer.unref();
  return timer;
}

/** Tells PDHC that a push arrived. Runs after the 202 has been sent. */
export async function acknowledgePush(connection: ConnectionRow, serviceRequestGuid: string, receiptToken: string) {
  try {
    await acknowledge(connection, receiptToken);
    setAckStatus(serviceRequestGuid, `Acknowledged ${now()}`);
  } catch (error) {
    setAckStatus(serviceRequestGuid, `Acknowledgement failed: ${errorMessage(error)}`);
  }
}
