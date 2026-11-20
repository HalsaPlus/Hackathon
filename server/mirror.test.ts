import assert from 'node:assert/strict';
import { test } from 'node:test';

// Mirror mode's starting role and the D key (src/app/mirror.ts).
const { roleFrom, togglesOnKey } = await import('../src/app/mirror.ts');

const phone = (search = '') => ({ search, pathname: '/phone' });

test('?role= works as before, from the app or from the /phone page', () => {
  assert.equal(roleFrom('?role=drive', null), 'drive');
  assert.equal(roleFrom('?role=follow', null), 'follow');
  assert.equal(roleFrom('', phone('?role=drive')), 'drive');
  assert.equal(roleFrom('', phone('?role=follow')), 'follow');
  // The app's own address wins.
  assert.equal(roleFrom('?role=drive', phone('?role=follow')), 'drive');
});

test('plain /phone starts as a follower; /app/ on its own does not start mirror mode', () => {
  assert.equal(roleFrom('', phone()), 'follow');
  assert.equal(roleFrom('', { search: '', pathname: '/phone/' }), 'follow');
  assert.equal(roleFrom('?patient=28a29239-6424-48e7-a123-9d9e863670b8', phone()), 'follow');
  assert.equal(roleFrom('', null), null, '/app/ not in a frame');
  assert.equal(roleFrom('?patient=x', null), null);
  assert.equal(roleFrom('', { search: '', pathname: '/' }), null, 'in a frame on the start page');
  assert.equal(roleFrom('', { search: '', pathname: '/phones' }), null);
  assert.equal(roleFrom('?role=other', phone('?role=nonsense')), 'follow');
});

test('D switches the role, but never while typing in a field, and not with modifiers', () => {
  const key = (k: string, mods: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean }> = {}) => ({ key: k, metaKey: false, ctrlKey: false, altKey: false, ...mods });
  assert.equal(togglesOnKey(key('d'), false), true);
  assert.equal(togglesOnKey(key('D'), false), true);
  assert.equal(togglesOnKey(key('d'), true), false, 'typing "d" in the chat');
  assert.equal(togglesOnKey(key('D'), true), false);
  assert.equal(togglesOnKey(key('d', { ctrlKey: true }), false), false);
  assert.equal(togglesOnKey(key('d', { metaKey: true }), false), false);
  assert.equal(togglesOnKey(key('d', { altKey: true }), false), false);
  assert.equal(togglesOnKey(key('f'), false), false);
});
