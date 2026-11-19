import { run, now } from './db.ts';
import { InboundError, parseDelivery } from './fhir.ts';
import { acknowledge, download, fetchFeed, PdhcError } from './pdhc.ts';
import {
  type ConnectionRow,
  getConnection,
  listConnections,
  logInbound,
  serviceRequestPdhcUpdatedAt,
  setAckStatus,
  storeDelivery,
} from './store.ts';

// Fetching from PDHC (poll, "Typ 2") and acknowledging pushes ("Typ 1").

const PAGE_SIZE = 50;
const MAX_PAGES = 20;
const running = new Set<number>();

function errorMessage(error: unknown) {
  if (error instanceof PdhcError || error instanceof InboundError) return error.message;
  return error instanceof Error ? `Oväntat fel: ${error.message}` : 'Oväntat fel.';
}

/**
 * Reads the feed and downloads every ServiceRequest that is new or changed
 * since last time. Unchanged ones are skipped, since every download is logged
 * as an access to patient data at PDHC.
 */
export async function syncConnection(id: number): Promise<{ ok: boolean; message: string }> {
  const connection = getConnection(id);
  if (!connection) return { ok: false, message: 'Anslutningen finns inte.' };
  if (running.has(id)) return { ok: false, message: 'En hämtning pågår redan.' };
  running.add(id);

  const counts = { created: 0, updated: 0, unchanged: 0, failed: 0 };
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
          });
          const outcome = storeDelivery(parsed, {
            channel: 'poll',
            connectionId: connection.id,
            matchGuid: item.match_guid,
            pdhcUpdatedAt: item.updated_at,
          });
          counts[outcome] += 1;
          logInbound('poll', connection.id, parsed.guid, outcome, null);
        } catch (error) {
          counts.failed += 1;
          logInbound('poll', connection.id, item.service_request_guid, 'error', errorMessage(error));
        }
      }
      if (feed.items.length < PAGE_SIZE || newestSeen === since) break;
      since = newestSeen;
    }
    const parts = [
      counts.created && `${counts.created} nya`,
      counts.updated && `${counts.updated} ändrade`,
      counts.unchanged && `${counts.unchanged} oförändrade`,
      counts.failed && `${counts.failed} misslyckades`,
    ].filter(Boolean);
    message = parts.length ? `Hämtat: ${parts.join(', ')}.` : 'Inga nya beställningar.';
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
    setAckStatus(serviceRequestGuid, `Kvitterad ${now()}`);
  } catch (error) {
    setAckStatus(serviceRequestGuid, `Kvittensen misslyckades: ${errorMessage(error)}`);
  }
}
