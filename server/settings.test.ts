import assert from 'node:assert/strict';
import { test } from 'node:test';

// Use a throwaway database. Must be set before settings.ts (and db.ts) load.
process.env.DATABASE_PATH = ':memory:';
// Old environment variables must no longer have any effect.
process.env.HEALTH_CONNECT_URL = 'https://from-env.example/fhir';
process.env.CDR_FHIR_URL = 'https://from-env.example/cdr';
const { getSettings, saveSettings, SettingsError, toSettingsView } = await import('./settings.ts');
const { sendToCdr } = await import('./messaging.ts');
const { fetchIpsFromHealthConnect } = await import('./ips.ts');

test('nothing is set until it is saved, whatever the environment says', async () => {
  assert.deepEqual(getSettings(), {
    healthConnectUrl: null,
    healthConnectToken: null,
    cdrUrl: null,
    cdrSourceService: null,
    cdrServiceKey: null,
    publicUrl: null,
  });
  const outcome = await sendToCdr({ id: 1, patientGuid: 'p', sender: 'patient', text: 'Hej', serviceRequestGuid: null, createdAt: new Date().toISOString() });
  assert.equal(outcome.status, 'not-configured');
  await assert.rejects(fetchIpsFromHealthConnect('p'), /not set up/);
});

test('saves, keeps and removes values field by field', () => {
  saveSettings({
    healthConnectUrl: ' https://hc.example/fhir/ ',
    healthConnectToken: 'hc-secret-1234',
    cdrUrl: 'https://cdr.example/fhir',
    cdrSourceService: 'mmd',
    cdrServiceKey: 'cdr-secret-5678',
    publicUrl: 'https://mmd.example',
  });
  assert.equal(getSettings().healthConnectUrl, 'https://hc.example/fhir');

  // Leaving a field out keeps it; that is how the console leaves secrets alone.
  saveSettings({ healthConnectUrl: 'https://hc2.example/fhir', cdrUrl: 'https://cdr.example/fhir' });
  assert.equal(getSettings().healthConnectToken, 'hc-secret-1234');
  assert.equal(getSettings().cdrServiceKey, 'cdr-secret-5678');

  // '' and null remove.
  saveSettings({ healthConnectToken: null, publicUrl: '' });
  assert.equal(getSettings().healthConnectToken, null);
  assert.equal(getSettings().publicUrl, null);
  assert.equal(getSettings().healthConnectUrl, 'https://hc2.example/fhir');
});

test('the browser only ever sees a hint of the secrets', () => {
  saveSettings({ healthConnectToken: 'hc-secret-abcd', cdrServiceKey: 'cdr-secret-wxyz' });
  const view = toSettingsView();
  assert.equal(view.healthConnectTokenHint, '…abcd');
  assert.equal(view.cdrServiceKeyHint, '…wxyz');
  const json = JSON.stringify(view);
  assert.ok(!json.includes('hc-secret'));
  assert.ok(!json.includes('cdr-secret'));
});

test('rejects addresses that are not http(s), carry credentials or are not text', () => {
  assert.throws(() => saveSettings({ cdrUrl: 'ftp://cdr.example' }), SettingsError);
  assert.throws(() => saveSettings({ cdrUrl: 'not a url' }), SettingsError);
  assert.throws(() => saveSettings({ healthConnectUrl: 'https://user:pw@hc.example' }), SettingsError);
  assert.throws(() => saveSettings({ cdrServiceKey: 'has a space' }), SettingsError);
  assert.throws(() => saveSettings({ publicUrl: 42 }), SettingsError);
  // A rejected save changes nothing.
  assert.equal(getSettings().cdrUrl, 'https://cdr.example/fhir');
});
