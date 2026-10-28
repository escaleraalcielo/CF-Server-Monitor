import test from 'node:test';
import assert from 'node:assert/strict';
import { handleAdminAPI, sanitizeAdminSettings } from '../src/handlers/admin.js';
import {
  maskSecretValue,
  isMaskedSecretValue,
  stripMaskedSecrets,
  saveSiteOptions,
  SECRET_SETTING_FIELDS,
  SECRET_MASK,
  SITE_FIELDS
} from '../src/utils/settings.js';
import { generateToken } from '../src/middleware/auth.js';
import { hashPassword } from '../src/utils/common.js';

// A D1 stub that supports the site_options read/write pair used by
// saveSiteOptions.
function makeSettingsDb(initialSiteOptions = {}) {
  const store = new Map([['site_options', JSON.stringify(initialSiteOptions)]]);
  return {
    store,
    prepare(sql) {
      const statement = {
        params: [],
        bind(...params) {
          statement.params = params;
          return statement;
        },
        async first() {
          if (/FROM settings/.test(sql)) {
            const key = String(sql).includes("'site_options'") ? 'site_options' : '';
            const value = store.get(key);
            return value === undefined ? null : { key, value };
          }
          return null;
        },
        async run() {
          if (/INSERT INTO settings/.test(sql)) {
            store.set(statement.params[0], statement.params[1]);
          }
          return { success: true };
        },
        async all() {
          return { results: [] };
        }
      };
      return statement;
    }
  };
}

function fullSiteOptions(overrides = {}) {
  const options = {};
  for (const field of SITE_FIELDS) options[field] = '';
  return { ...options, ...overrides };
}

const ADMIN_ENV = { API_SECRET: 'shared-agent-secret', JWT_SECRET: 'j'.repeat(32) };

async function adminRequest(action, env, sys, extra = {}) {
  const token = await generateToken(env, sys);
  return new Request('https://example.com/admin/api', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ action, ...extra })
  });
}

test('the settings response never carries the shared ingest secret', async () => {
  const env = { ...ADMIN_ENV };
  const sys = {
    username: 'admin',
    jwt_secret: 'j'.repeat(32),
    password: await hashPassword('admin-password')
  };

  const response = await handleAdminAPI(
    await adminRequest('get_settings', env, sys),
    env,
    sys,
    async () => sys
  );
  const body = await response.json();

  assert.equal(body.success, true);
  assert.equal(body.api_secret, undefined, 'get_settings must not return api_secret');
  assert.ok(
    !JSON.stringify(body).includes('shared-agent-secret'),
    'the shared ingest secret must not appear anywhere in the settings payload'
  );
});

test('the ingest secret is only available through the dedicated on-demand action', async () => {
  const env = { ...ADMIN_ENV };
  const sys = {
    username: 'admin',
    jwt_secret: 'j'.repeat(32),
    password: await hashPassword('admin-password')
  };

  const response = await handleAdminAPI(
    await adminRequest('get_install_secret', env, sys),
    env,
    sys,
    async () => sys
  );
  const body = await response.json();

  assert.equal(body.success, true);
  assert.equal(body.api_secret, 'shared-agent-secret');
});

test('credential settings are masked and reported as configured', () => {
  const sanitized = sanitizeAdminSettings({
    username: 'admin',
    jwt_secret: 'jwt-secret-value',
    password: 'pbkdf2_sha256$50000$salt$hash',
    turnstile_secret_key: 'real-turnstile-secret',
    cloudflare_token: 'real-cloudflare-token',
    tg_bot_token: '123456:telegram-bot-token',
    site_title: 'My panel'
  });

  assert.equal(sanitized.jwt_secret, undefined);
  assert.equal(sanitized.password, undefined);
  assert.equal(sanitized.password_configured, true);
  assert.equal(sanitized.site_title, 'My panel');

  for (const field of SECRET_SETTING_FIELDS) {
    assert.equal(sanitized[field], SECRET_MASK, `${field} must be masked`);
    assert.equal(sanitized[`${field}_configured`], true, `${field}_configured must be true`);
  }

  // The mask must not be empty, otherwise the form reads as "unset".
  assert.notEqual(SECRET_MASK, '');
  assert.equal(maskSecretValue(''), '');
  assert.equal(maskSecretValue('   '), '');
  assert.equal(isMaskedSecretValue(SECRET_MASK), true);
  assert.equal(isMaskedSecretValue('something-else'), false);
});

test('the Telegram/SMTP token mask keeps the smtp: prefix so the channel is still detected', () => {
  const sanitized = sanitizeAdminSettings({
    tg_bot_token: 'smtp://user:mailpass@smtp.example.com:587?secure=starttls'
  });

  // The frontend detects the SMTP channel with a "smtp:" prefix check, so the
  // mask has to keep it - otherwise the panel would show the wrong channel.
  assert.ok(
    sanitized.tg_bot_token.startsWith('smtp:'),
    'the SMTP mask must keep the smtp: prefix'
  );
  assert.ok(
    sanitized.tg_bot_token.endsWith(SECRET_MASK),
    'the SMTP mask must end with the mask'
  );
  assert.ok(
    !sanitized.tg_bot_token.includes('mailpass'),
    'the SMTP password must not survive masking'
  );
  assert.ok(
    !sanitized.tg_bot_token.includes('smtp.example.com'),
    'the SMTP host must not survive masking'
  );
  assert.equal(isMaskedSecretValue(sanitized.tg_bot_token), true);
  assert.equal(sanitized.tg_bot_token_configured, true);
});

test('a no-op settings save preserves the stored credential', async () => {
  const stored = {
    turnstile_secret_key: 'real-turnstile-secret',
    cloudflare_token: 'real-cloudflare-token',
    tg_bot_token: 'smtp://user:mailpass@smtp.example.com:587'
  };
  const db = makeSettingsDb(fullSiteOptions(stored));

  // This is what the admin UI sends back when nothing was edited: the mask.
  const saved = await saveSiteOptions(db, {
    turnstile_secret_key: SECRET_MASK,
    cloudflare_token: SECRET_MASK,
    tg_bot_token: 'smtp://' + SECRET_MASK,
    is_public: 'false'
  });

  assert.equal(saved.turnstile_secret_key, 'real-turnstile-secret');
  assert.equal(saved.cloudflare_token, 'real-cloudflare-token');
  assert.equal(saved.tg_bot_token, 'smtp://user:mailpass@smtp.example.com:587');
  assert.equal(saved.is_public, 'false');
});

test('an explicitly cleared Telegram token still clears the stored one', async () => {
  const db = makeSettingsDb(fullSiteOptions({
    tg_bot_token: 'smtp://user:mailpass@smtp.example.com:587'
  }));

  // Switching the notification channel back to the built-in one sends an
  // empty string, which is a deliberate clear - not an unchanged value.
  const saved = await saveSiteOptions(db, { tg_bot_token: '' });

  assert.equal(saved.tg_bot_token, '');
});

test('an explicitly changed credential replaces the stored one', async () => {
  const db = makeSettingsDb(fullSiteOptions({
    turnstile_secret_key: 'real-turnstile-secret',
    cloudflare_token: 'real-cloudflare-token'
  }));

  const saved = await saveSiteOptions(db, {
    turnstile_secret_key: 'brand-new-secret',
    cloudflare_token: SECRET_MASK
  });

  assert.equal(saved.turnstile_secret_key, 'brand-new-secret');
  assert.equal(saved.cloudflare_token, 'real-cloudflare-token');
});

test('stripMaskedSecrets removes only the masked fields', () => {
  const stripped = stripMaskedSecrets({
    turnstile_secret_key: SECRET_MASK,
    cloudflare_token: 'a-real-value',
    site_title: 'kept'
  });

  assert.equal('turnstile_secret_key' in stripped, false);
  assert.equal(stripped.cloudflare_token, 'a-real-value');
  assert.equal(stripped.site_title, 'kept');
});
