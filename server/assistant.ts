import { createHash, randomBytes } from 'node:crypto';
import type { AssistantLinkView, NewAssistantLink } from '../shared/types.ts';
import { all, get, now, run } from './db.ts';

// Secret links that let an AI assistant reach one patient's data over MCP
// (issue #7). The secret goes in the address (`/mcp/<secret>`, for assistants
// that connect without a login) or as `Authorization: Bearer <secret>` (for
// those that take an API key). Only a SHA-256 of it is stored, so a copy of
// the database cannot be used to connect. Demo only: with real patients this
// becomes a proper sign-in (OAuth).

export class AssistantLinkError extends Error {}

interface LinkRow {
  id: number;
  patient_guid: string;
  label: string;
  secret_hash: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

const hash = (secret: string) => createHash('sha256').update(secret).digest('hex');

function toView(row: LinkRow): AssistantLinkView {
  return { id: row.id, label: row.label, createdAt: row.created_at, lastUsedAt: row.last_used_at, revokedAt: row.revoked_at };
}

/** Makes a link for a patient. The secret is returned once and never again. */
export function createAssistantLink(patientGuid: string, label: string, baseUrl: string): NewAssistantLink {
  const name = label.trim() || 'AI assistant';
  if (name.length > 40) throw new AssistantLinkError('The name may be at most 40 characters.');
  const secret = randomBytes(32).toString('base64url');
  const at = now();
  const result = run(
    `INSERT INTO assistant_links (patient_guid, label, secret_hash, created_at) VALUES (:patientGuid, :label, :hash, :at)`,
    { patientGuid, label: name, hash: hash(secret), at },
  );
  const row = get<LinkRow>('SELECT * FROM assistant_links WHERE id = :id', { id: Number(result.lastInsertRowid) })!;
  return { ...toView(row), secret, url: `${baseUrl.replace(/\/+$/, '')}/mcp/${secret}` };
}

export function listAssistantLinks(patientGuid: string): AssistantLinkView[] {
  return all<LinkRow>('SELECT * FROM assistant_links WHERE patient_guid = :patientGuid ORDER BY created_at DESC, id DESC', {
    patientGuid,
  }).map(toView);
}

export function revokeAssistantLink(id: number): boolean {
  return Number(run('UPDATE assistant_links SET revoked_at = :at WHERE id = :id AND revoked_at IS NULL', { id, at: now() }).changes) > 0;
}

/** The patient and label a secret belongs to, or undefined when it is unknown or revoked. Marks it used. */
export function resolveAssistantSecret(secret: string | undefined): { patientGuid: string; label: string } | undefined {
  if (!secret || secret.length < 20 || secret.length > 200) return undefined;
  const row = get<LinkRow>('SELECT * FROM assistant_links WHERE secret_hash = :hash AND revoked_at IS NULL', { hash: hash(secret) });
  if (!row) return undefined;
  run('UPDATE assistant_links SET last_used_at = :at WHERE id = :id', { id: row.id, at: now() });
  return { patientGuid: row.patient_guid, label: row.label };
}
