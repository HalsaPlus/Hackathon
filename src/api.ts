import type {
  ConnectionView,
  InboundLogEntry,
  PatientSummary,
  PatientView,
  ServiceSettingsView,
  TestReportResult,
} from '../shared/types.ts';

export async function call<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  });
  if (response.status === 401) {
    const here = window.location.pathname + window.location.search + window.location.hash;
    window.location.href = `/login?next=${encodeURIComponent(here)}`;
    throw new Error('You are not signed in.');
  }
  if (response.status === 204) return undefined as T;
  const data = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) throw new Error(data.error ?? `The server answered with error ${response.status}.`);
  return data as T;
}

export interface ConnectionInput {
  name: string;
  baseUrl: string;
  gatewayUrl?: string;
  providerToken?: string;
  pushSecret?: string | null;
  pollEnabled: boolean;
}

/** Per field: leave out to keep, '' or null to remove, a string to replace. */
export interface ServiceSettingsInput {
  healthConnectUrl?: string | null;
  healthConnectToken?: string | null;
  cdrUrl?: string | null;
  cdrSourceService?: string | null;
  cdrServiceKey?: string | null;
  publicUrl?: string | null;
}

export const api = {
  patients: () => call<PatientSummary[]>('GET', '/api/patients'),
  patient: (guid: string) => call<PatientView>('GET', `/api/patients/${encodeURIComponent(guid)}`),
  setPerformed: (requestGuid: string, activityKey: string, index: number, performed: boolean) =>
    call<void>('POST', `/api/service-requests/${encodeURIComponent(requestGuid)}/stops`, { activityKey, index, performed }),
  createDemo: () => call<PatientView>('POST', '/api/demo'),

  connections: () => call<ConnectionView[]>('GET', '/api/connections'),
  createConnection: (input: ConnectionInput) => call<ConnectionView>('POST', '/api/connections', input),
  updateConnection: (id: number, input: ConnectionInput) => call<ConnectionView>('PUT', `/api/connections/${id}`, input),
  deleteConnection: (id: number) => call<void>('DELETE', `/api/connections/${id}`),
  testConnection: (id: number) => call<ConnectionView>('POST', `/api/connections/${id}/test`),
  syncConnection: (id: number) => call<ConnectionView>('POST', `/api/connections/${id}/sync`),
  sendTestReport: (id: number, onePerReport: boolean) =>
    call<TestReportResult[]>('POST', `/api/connections/${id}/test-report`, { onePerReport }),
  inboundLog: () => call<InboundLogEntry[]>('GET', '/api/inbound-log'),

  settings: () => call<ServiceSettingsView>('GET', '/api/settings'),
  saveSettings: (input: ServiceSettingsInput) => call<ServiceSettingsView>('PUT', '/api/settings', input),
};
