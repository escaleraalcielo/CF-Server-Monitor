import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The install-command builders live inside the admin single-file component,
// so these invariants are asserted against the component source. They guard a
// user-visible failure: an install command that carries -secret='' gets
// pasted onto a real host and silently fails to authenticate.
const adminViewPath = fileURLToPath(new URL('../src/frontend/views/admin/index.vue', import.meta.url));
const source = readFileSync(adminViewPath, 'utf8');

function bodyOf(name) {
  const start = source.indexOf(`const ${name} = `);
  assert.notEqual(start, -1, `${name} not found`);
  const next = source.indexOf('\nconst ', start + 1);
  return source.slice(start, next === -1 ? source.length : next);
}

test('the install-command builders refuse to run without the ingest secret', () => {
  for (const builder of ['getCustomInstallCommand', 'buildAutoDiscoveryCommand']) {
    const body = bodyOf(builder);
    const guard = body.indexOf('if (!apiSecret.value) return \'\'');
    assert.notEqual(guard, -1, `${builder} must bail out when the secret is empty`);
    // The guard has to come before the first use of the secret, otherwise the
    // command can still be assembled with an empty value.
    const firstUse = body.indexOf('apiSecret.value');
    assert.ok(guard < firstUse, `${builder}: the empty-secret guard must precede the secret use`);
  }
});

test('the install dialogs wait for the secret before they open', () => {
  for (const opener of ['copyCmd', 'openAutoDiscoveryModal']) {
    const body = bodyOf(opener);
    const fetch = body.indexOf('await fetchInstallSecret()');
    const show = body.search(/show(Copy|AutoDiscovery)Modal\.value = true/);
    assert.notEqual(fetch, -1, `${opener} must await the secret fetch`);
    assert.notEqual(show, -1, `${opener} must open the modal`);
    assert.ok(fetch < show, `${opener}: the secret must be fetched before the modal opens`);
  }
});

test('the copy actions refuse a command that has no secret in it', () => {
  for (const copier of ['copyCustomCmd', 'copyAutoDiscoveryCmd']) {
    const body = bodyOf(copier);
    assert.ok(
      /if \(!cmd\) \{/.test(body),
      `${copier} must refuse to copy an empty command`
    );
    assert.ok(
      body.indexOf('if (!cmd)') < body.indexOf('copyTextToClipboard'),
      `${copier}: the empty-command check must precede the copy`
    );
  }
});

test('the ingest secret is dropped whenever the install dialog is left', () => {
  for (const closer of ['closeCopyModal', 'closeAutoDiscoveryModal', 'openEditModalFromCopy']) {
    const body = bodyOf(closer);
    assert.ok(
      body.includes('clearInstallSecret()'),
      `${closer} must clear the ingest secret`
    );
  }
});

test('the shared ingest secret is never part of the settings payload', () => {
  const handler = readFileSync(
    fileURLToPath(new URL('../src/handlers/admin.js', import.meta.url)),
    'utf8'
  );
  const getSettings = handler.slice(
    handler.indexOf('async function handleGetSettingsAction'),
    handler.indexOf('async function handleGetInstallSecretAction')
  );
  assert.ok(getSettings.length > 0, 'handleGetSettingsAction not found');
  assert.ok(
    !/api_secret\s*:/.test(getSettings),
    'get_settings must not return api_secret'
  );
});
