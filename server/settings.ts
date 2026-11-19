import type { ServiceSettingsView } from '../shared/types.ts';
import { all, now, run, transaction } from './db.ts';

// Where the other services are and how to authenticate, stored in the
// database and edited in the admin console. PDHC has its own table
// (connections), since there can be several.

export class SettingsError extends Error {}

export interface ServiceSettings {
  /** Health Connect's FHIR base, for `GET {url}/Patient/{id}/$summary`. */
  healthConnectUrl: string | null;
  healthConnectToken: string | null;
  /** The CDR's FHIR base; each chat message is POSTed to `{url}/Bundle`. */
  cdrUrl: string | null;
  cdrSourceService: string | null;
  cdrServiceKey: string | null;
  /** This app's public address, written as the source of FHIR messages. */
  publicUrl: string | null;
}

const KEYS = {
  healthConnectUrl: 'health_connect_url',
  healthConnectToken: 'health_connect_token',
  cdrUrl: 'cdr_url',
  cdrSourceService: 'cdr_source_service',
  cdrServiceKey: 'cdr_service_key',
  publicUrl: 'public_url',
} as const satisfies Record<keyof ServiceSettings, string>;

type Field = keyof ServiceSettings;
const SECRETS = new Set<Field>(['healthConnectToken', 'cdrServiceKey']);
const URLS = new Set<Field>(['healthConnectUrl', 'cdrUrl', 'publicUrl']);

const LABELS: Record<Field, string> = {
  healthConnectUrl: 'The Health Connect URL',
  healthConnectToken: 'The Health Connect token',
  cdrUrl: 'The CDR URL',
  cdrSourceService: 'The CDR source service',
  cdrServiceKey: 'The CDR service key',
  publicUrl: "This app's address",
};

export function getSettings(): ServiceSettings {
  const stored = new Map(all<{ key: string; value: string }>('SELECT key, value FROM settings').map((r) => [r.key, r.value]));
  const settings = {} as ServiceSettings;
  for (const [field, key] of Object.entries(KEYS) as [Field, string][]) settings[field] = stored.get(key) ?? null;
  return settings;
}

function hint(secret: string | null) {
  return secret ? `…${secret.slice(-4)}` : null;
}

/** What the browser may see: URLs and names, and only a hint of each secret. */
export function toSettingsView(settings: ServiceSettings = getSettings()): ServiceSettingsView {
  return {
    healthConnectUrl: settings.healthConnectUrl,
    healthConnectTokenHint: hint(settings.healthConnectToken),
    cdrUrl: settings.cdrUrl,
    cdrSourceService: settings.cdrSourceService,
    cdrServiceKeyHint: hint(settings.cdrServiceKey),
    publicUrl: settings.publicUrl,
  };
}

function cleanUrl(field: Field, value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SettingsError(`${LABELS[field]} is not a valid address.`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new SettingsError(`${LABELS[field]} must start with https:// (or http:// for a local service).`);
  }
  if (url.username || url.password) throw new SettingsError(`${LABELS[field]} must not contain a user name or password.`);
  url.hash = '';
  return url.toString().replace(/\/+$/, '');
}

/**
 * Saves what the admin console sends. For every field: undefined keeps the
 * current value, '' or null removes it, and a string replaces it. Secrets are
 * therefore only touched when the user types a new one or removes it.
 */
export function saveSettings(body: unknown): ServiceSettings {
  const input = (body ?? {}) as Record<string, unknown>;
  const changes = new Map<Field, string | null>();
  for (const field of Object.keys(KEYS) as Field[]) {
    const raw = input[field];
    if (raw === undefined) continue;
    if (raw !== null && typeof raw !== 'string') throw new SettingsError(`${LABELS[field]} must be text.`);
    const value = raw?.trim() ?? '';
    if (!value) {
      changes.set(field, null);
      continue;
    }
    if (value.length > 2048) throw new SettingsError(`${LABELS[field]} is too long.`);
    if (SECRETS.has(field) && /\s/.test(value)) throw new SettingsError(`${LABELS[field]} must not contain spaces.`);
    changes.set(field, URLS.has(field) ? cleanUrl(field, value) : value);
  }

  const at = now();
  transaction(() => {
    for (const [field, value] of changes) {
      if (value === null) run('DELETE FROM settings WHERE key = :key', { key: KEYS[field] });
      else
        run(
          `INSERT INTO settings (key, value, updated_at) VALUES (:key, :value, :at)
           ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
          { key: KEYS[field], value, at },
        );
    }
  });
  return getSettings();
}
