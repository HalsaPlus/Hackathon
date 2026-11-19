import express from 'express';
import type { Express, Request, Response } from 'express';
import { safeEqual } from './auth.ts';
import { now, run } from './db.ts';
import { createDemo } from './demo.ts';
import { InboundError, parseDelivery } from './fhir.ts';
import { normalizeBaseUrl, PdhcError, testConnection } from './pdhc.ts';
import {
  activityStops,
  getConnection,
  getPatientView,
  listConnections,
  listInboundLog,
  listPatients,
  logInbound,
  setPerformed,
  storeDelivery,
  toConnectionView,
} from './store.ts';
import { acknowledgePush, syncConnection } from './sync.ts';

// FHIR clients send application/fhir+json; bundles with embedded
// questionnaires can be large.
const json = express.json({ type: ['application/json', 'application/fhir+json'], limit: '5mb' });

function operationOutcome(code: string, diagnostics: string) {
  return { resourceType: 'OperationOutcome', issue: [{ severity: 'error', code, diagnostics }] };
}

// --- Push from PDHC (public, authenticated with X-Push-Secret) -------------------------

/**
 * PDHC's push delivery ("Typ 1"): request.pdhc POSTs a FHIR Bundle with the
 * shared secret in X-Push-Secret. The app answers 202 and then acknowledges
 * the receipt with the connection's token.
 *
 * Must be registered before setupAuth(), since PDHC has no login session.
 */
export function setupPushEndpoint(app: Express) {
  app.post('/api/v1/inbound/push', json, (req: Request, res: Response) => {
    const secret = req.get('X-Push-Secret') ?? '';
    const connection = secret
      ? listConnections().find((c) => c.push_secret && safeEqual(secret, c.push_secret))
      : undefined;
    if (!connection) {
      logInbound('push', null, null, 'rejected', secret ? 'Fel X-Push-Secret.' : 'X-Push-Secret saknas.');
      return res.status(401).json(operationOutcome('security', 'Missing or wrong X-Push-Secret.'));
    }

    try {
      const parsed = parseDelivery(req.body);
      const outcome = storeDelivery(parsed, { channel: 'push', connectionId: connection.id });
      logInbound('push', connection.id, parsed.guid, outcome, null);
      res.status(202).json({ status: 'accepted', service_request_guid: parsed.guid, outcome });
      if (parsed.receiptToken) void acknowledgePush(connection, parsed.guid, parsed.receiptToken);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Oväntat fel.';
      const known = error instanceof InboundError;
      logInbound('push', connection.id, null, known ? 'rejected' : 'error', message);
      res.status(known ? 400 : 500).json(operationOutcome(known ? 'invalid' : 'exception', message));
    }
  });
}

// --- The web app's API (requires login) --------------------------------------------------

interface ConnectionInput {
  name: string;
  baseUrl: string;
  providerToken: string | undefined;
  pushSecret: string | null | undefined;
  pollEnabled: boolean;
}

function readConnectionInput(body: unknown, creating: boolean): ConnectionInput {
  const input = (body ?? {}) as Record<string, unknown>;
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name || name.length > 80) throw new PdhcError('Ge anslutningen ett namn (högst 80 tecken).');

  const baseUrl = normalizeBaseUrl(typeof input.baseUrl === 'string' ? input.baseUrl : '');

  const token = typeof input.providerToken === 'string' ? input.providerToken.trim() : '';
  if (creating && !token) throw new PdhcError('Token saknas.');
  if (token && (token.length < 8 || token.length > 4096 || /\s/.test(token))) {
    throw new PdhcError('Token ser inte rätt ut. Klistra in den exakt som du fick den.');
  }

  // undefined = keep the current secret, '' or null = remove it.
  let pushSecret: string | null | undefined;
  if (input.pushSecret === null || input.pushSecret === '') pushSecret = null;
  else if (typeof input.pushSecret === 'string') {
    pushSecret = input.pushSecret.trim();
    if (pushSecret.length < 8) throw new PdhcError('Push-hemligheten är för kort (minst 8 tecken).');
  }

  return { name, baseUrl, providerToken: token || undefined, pushSecret, pollEnabled: input.pollEnabled === true };
}

function sendError(res: Response, error: unknown) {
  if (error instanceof PdhcError || error instanceof InboundError) return res.status(400).json({ error: error.message });
  console.error(error);
  res.status(500).json({ error: 'Något gick fel på servern.' });
}

function connectionId(req: Request) {
  const id = Number(req.params.id);
  return Number.isSafeInteger(id) ? id : -1;
}

export function setupApi(app: Express) {
  app.use('/api', json);

  // Connections ---------------------------------------------------------------

  app.get('/api/connections', (_req, res) => {
    res.json(listConnections().map(toConnectionView));
  });

  app.post('/api/connections', (req, res) => {
    try {
      const input = readConnectionInput(req.body, true);
      const at = now();
      const result = run(
        `INSERT INTO connections (name, base_url, provider_token, push_secret, poll_enabled, created_at, updated_at)
         VALUES (:name, :baseUrl, :token, :pushSecret, :pollEnabled, :at, :at)`,
        {
          name: input.name,
          baseUrl: input.baseUrl,
          token: input.providerToken,
          pushSecret: input.pushSecret ?? null,
          pollEnabled: input.pollEnabled,
          at,
        },
      );
      res.status(201).json(toConnectionView(getConnection(Number(result.lastInsertRowid))!));
    } catch (error) {
      sendError(res, error);
    }
  });

  app.put('/api/connections/:id', (req, res) => {
    const existing = getConnection(connectionId(req));
    if (!existing) return res.status(404).json({ error: 'Anslutningen finns inte.' });
    try {
      const input = readConnectionInput(req.body, false);
      const changedTarget = input.baseUrl !== existing.base_url || (input.providerToken && input.providerToken !== existing.provider_token);
      run(
        `UPDATE connections SET name = :name, base_url = :baseUrl, provider_token = :token, push_secret = :pushSecret,
           poll_enabled = :pollEnabled, updated_at = :at,
           feed_since = CASE WHEN :reset = 1 THEN NULL ELSE feed_since END,
           last_test_at = CASE WHEN :reset = 1 THEN NULL ELSE last_test_at END,
           last_test_ok = CASE WHEN :reset = 1 THEN NULL ELSE last_test_ok END,
           last_test_message = CASE WHEN :reset = 1 THEN NULL ELSE last_test_message END
         WHERE id = :id`,
        {
          id: existing.id,
          name: input.name,
          baseUrl: input.baseUrl,
          token: input.providerToken ?? existing.provider_token,
          pushSecret: input.pushSecret === undefined ? existing.push_secret : input.pushSecret,
          pollEnabled: input.pollEnabled,
          reset: !!changedTarget,
          at: now(),
        },
      );
      res.json(toConnectionView(getConnection(existing.id)!));
    } catch (error) {
      sendError(res, error);
    }
  });

  app.delete('/api/connections/:id', (req, res) => {
    run('DELETE FROM connections WHERE id = :id', { id: connectionId(req) });
    res.status(204).end();
  });

  app.post('/api/connections/:id/test', async (req, res) => {
    const connection = getConnection(connectionId(req));
    if (!connection) return res.status(404).json({ error: 'Anslutningen finns inte.' });
    let ok = true;
    let message: string;
    try {
      message = await testConnection(connection);
    } catch (error) {
      ok = false;
      message = error instanceof Error ? error.message : 'Oväntat fel.';
    }
    run('UPDATE connections SET last_test_at = :at, last_test_ok = :ok, last_test_message = :message WHERE id = :id', {
      at: now(),
      ok,
      message,
      id: connection.id,
    });
    res.json(toConnectionView(getConnection(connection.id)!));
  });

  app.post('/api/connections/:id/sync', async (req, res) => {
    const connection = getConnection(connectionId(req));
    if (!connection) return res.status(404).json({ error: 'Anslutningen finns inte.' });
    await syncConnection(connection.id);
    res.json(toConnectionView(getConnection(connection.id)!));
  });

  app.get('/api/inbound-log', (_req, res) => {
    res.json(listInboundLog());
  });

  // Patients and their plans ------------------------------------------------------

  app.get('/api/patients', (_req, res) => {
    res.json(listPatients());
  });

  app.get('/api/patients/:guid', (req, res) => {
    const view = getPatientView(req.params.guid);
    if (!view) return res.status(404).json({ error: 'Patienten finns inte.' });
    res.json(view);
  });

  /** Marks a stop as done or not done. Body: { activityKey, index, performed }. */
  app.post('/api/service-requests/:guid/stops', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const activityKey = typeof body.activityKey === 'string' ? body.activityKey : '';
    const index = Number(body.index);
    const stops = activityStops(req.params.guid, activityKey);
    if (!stops) return res.status(404).json({ error: 'Aktiviteten finns inte.' });
    if (!Number.isSafeInteger(index) || index < 0 || index >= stops.length) {
      return res.status(400).json({ error: 'Hållplatsen finns inte på linjen.' });
    }
    setPerformed(req.params.guid, activityKey, index, body.performed === true);
    res.status(204).end();
  });

  // Demo ----------------------------------------------------------------------------

  /** Creates a synthetic request through the same path as a real push. */
  app.post('/api/demo', (_req, res) => {
    try {
      res.status(201).json(createDemo());
    } catch (error) {
      sendError(res, error);
    }
  });
}
