import assert from 'node:assert/strict';
import test from 'node:test';

import { handleAdminAPI } from '../src/handlers/admin.js';
import { generateToken } from '../src/middleware/auth.js';
import { hashPassword } from '../src/utils/common.js';
import { clearAllCaches } from '../src/utils/cache.js';
import { loadSettings, loadSiteSettings } from '../src/utils/settings.js';

const JWT_SECRET = 'a'.repeat(48);
const PASSWORD_HASH = '$pbkdf2-sha256$iterations=120000$c2FsdA$aGFzaA';

function createEnv(siteOptions) {
  let current = siteOptions;
  const db = {
    prepare(sql) {
      const trimmed = String(sql).trim();
      const isSettingsRead = /from\s+settings/i.test(trimmed);
      const statement = {
        params: [],
        bind(...params) {
          statement.params = params;
          return statement;
        },
        async first() {
          if (isSettingsRead) {
            // The key is either bound as a parameter or inlined in the SQL.
            const key = statement.params[0] !== undefined
              ? statement.params[0]
              : (/site_options/.test(trimmed) ? 'site_options' : null);
            if (key === 'site_options') {
              return { value: JSON.stringify(current) };
            }
            return null;
          }
          return null;
        },
        async run() {
          return { success: true };
        },
        async all() {
          return { results: [] };
        }
      };
      return statement;
    }
  };
  return {
    API_SECRET: 'secret',
    DB: db,
    // Lets a test change what D1 holds without touching the isolate's cache.
    setSiteOptions(next) {
      current = next;
    }
  };
}

async function callSaveSettings(env, sys, settings) {
  const token = await generateToken(env, sys);
  const response = await handleAdminAPI(
    new Request('https://example.com/admin/api', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({ action: 'save_settings', settings })
    }),
    env,
    sys,
    null,
    { waitUntil() {} }
  );
  let body = null;
  try {
    body = await response.json();
  } catch (_) {
    body = null;
  }
  return { status: response.status, body };
}

test('save_settings is not rejected as passwordRequired when the cached settings are stale', async () => {
  clearAllCaches();

  // The password IS configured in D1 ...
  const env = createEnv({ password: PASSWORD_HASH, username: 'admin' });

  // ... but this isolate still holds a cached settings object from before it was set.
  const staleSys = { username: 'admin', password: '', jwt_secret: JWT_SECRET };

  const { status, body } = await callSaveSettings(env, staleSys, { site_title: 'Example' });

  assert.notEqual(
    body && body.error,
    'passwordRequired',
    'a configured password must not be reported as missing just because the cache is stale'
  );
  assert.equal(status, 200);

  clearAllCaches();
});

test('save_settings is still rejected as passwordRequired when no password is configured', async () => {
  clearAllCaches();

  const env = createEnv({ username: 'admin' });
  const sys = { username: 'admin', password: '', jwt_secret: JWT_SECRET };

  const { status, body } = await callSaveSettings(env, sys, { site_title: 'Example' });

  assert.equal(status, 400);
  assert.equal(body && body.error, 'passwordRequired');

  clearAllCaches();
});

async function callLogin(env, sys, username, password) {
  const response = await handleAdminAPI(
    new Request('https://example.com/admin/api', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'login', username, password })
    }),
    env,
    sys,
    null,
    { waitUntil() {} }
  );
  let body = null;
  try {
    body = await response.json();
  } catch (_) {
    body = null;
  }
  return { status: response.status, body };
}

test('login succeeds with a password that the cached settings do not know yet', async () => {
  clearAllCaches();

  const passwordHash = await hashPassword('fresh-password');
  const env = createEnv({ username: 'admin', password: passwordHash });

  // This isolate still holds settings from before the password was configured.
  const staleSys = { username: 'admin', password: '', jwt_secret: JWT_SECRET };

  const { status } = await callLogin(env, staleSys, 'admin', 'fresh-password');

  assert.equal(status, 200, 'a freshly saved password must be accepted');

  clearAllCaches();
});

test('login still fails when the credentials are wrong', async () => {
  clearAllCaches();

  const passwordHash = await hashPassword('fresh-password');
  const env = createEnv({ username: 'admin', password: passwordHash });
  const sys = { username: 'admin', password: passwordHash, jwt_secret: JWT_SECRET };

  const { status, body } = await callLogin(env, sys, 'admin', 'wrong-password');

  assert.equal(status, 401);
  assert.equal(body && body.error, 'invalidCredentials');

  clearAllCaches();
});

test('get_settings with refresh reads the settings from D1 instead of the cache', async () => {
  clearAllCaches();

  const passwordHash = await hashPassword('fresh-password');
  const env = createEnv({ username: 'admin', password: passwordHash });

  // The isolate's cache holds the values from before the change.
  const staleSys = { username: 'admin', password: '', jwt_secret: JWT_SECRET };
  await loadSiteSettings(env.DB);

  // D1 now holds the renamed user and the configured password.
  env.setSiteOptions({ username: 'renamed', password: passwordHash });

  const token = await generateToken(env, staleSys);
  const response = await handleAdminAPI(
    new Request('https://example.com/admin/api', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({ action: 'get_settings', refresh: true })
    }),
    env,
    staleSys,
    async () => loadSettings(env.DB),
    { waitUntil() {} }
  );

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.settings.username, 'renamed');
  assert.equal(body.settings.password_configured, true);

  clearAllCaches();
});

test('get_settings without refresh keeps serving the cached settings', async () => {
  clearAllCaches();

  const passwordHash = await hashPassword('fresh-password');
  const env = createEnv({ username: 'admin', password: passwordHash });

  const staleSys = { username: 'admin', password: '', jwt_secret: JWT_SECRET };
  await loadSiteSettings(env.DB);

  env.setSiteOptions({ username: 'renamed', password: passwordHash });

  const token = await generateToken(env, staleSys);
  const response = await handleAdminAPI(
    new Request('https://example.com/admin/api', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({ action: 'get_settings' })
    }),
    env,
    staleSys,
    async () => loadSettings(env.DB),
    { waitUntil() {} }
  );

  assert.equal(response.status, 200);
  const body = await response.json();
  // Without a refresh the cached copy is used, which is the behaviour the
  // refresh flag exists to opt out of.
  assert.equal(body.settings.username, 'admin');

  clearAllCaches();
});
