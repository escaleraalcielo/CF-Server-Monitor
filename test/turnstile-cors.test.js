import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare } from 'miniflare';

import worker from '../src/index.js';
import { initDatabase } from '../src/database/schema.js';

const ALLOWED_ORIGIN = 'https://panel.example';
const FOREIGN_ORIGIN = 'https://evil.example';

// One environment for both cases: initDatabase() caches "the schema is ready"
// in module state, so a second database would never get its tables created.
let miniflare = null;
let env = null;
let originalFetch = null;

before(async () => {
  miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("OK"); } }',
    d1Databases: { DB: 'turnstile-cors-test' }
  });

  const db = await miniflare.getD1Database('DB');
  await initDatabase(db);
  await db.prepare(
    `INSERT INTO settings (key, value) VALUES ('site_options', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).bind(JSON.stringify({
    turnstile_enabled: 'true',
    turnstile_secret_key: 'test-turnstile-secret'
  })).run();

  env = {
    DB: db,
    API_SECRET: 'shared-secret',
    CORS_ALLOWED_ORIGINS: ALLOWED_ORIGIN
  };

  // The Turnstile verification goes out to Cloudflare; answer it locally.
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : String(input?.url || '');
    if (url.includes('challenges.cloudflare.com/turnstile')) {
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    return originalFetch(input, init);
  };
});

after(async () => {
  if (originalFetch) globalThis.fetch = originalFetch;
  if (miniflare) await miniflare.dispose();
});

async function configRequest(origin) {
  return worker.fetch(
    new Request('https://panel.example/api/config', {
      method: 'GET',
      headers: {
        'X-Turnstile-Token': 'a-valid-token',
        'Origin': origin
      }
    }),
    env,
    { waitUntil() {} }
  );
}

test('a turnstile-verified response does not reflect a foreign origin', async () => {
  const response = await configRequest(FOREIGN_ORIGIN);

  // If the turnstile gate had not run, this request would have taken the same
  // path as any other response and the assertions below would prove nothing.
  const body = await response.clone().json();
  assert.ok(body?.turnstile_verified, 'the turnstile gate must have run');

  assert.equal(
    response.headers.get('Access-Control-Allow-Origin'),
    null,
    'a foreign origin must not be reflected back'
  );
  assert.equal(
    response.headers.get('Access-Control-Allow-Credentials'),
    null,
    'a foreign origin must not be allowed to send credentials'
  );
});

test('a turnstile-verified response still allows a configured origin', async () => {
  const response = await configRequest(ALLOWED_ORIGIN);

  const body = await response.clone().json();
  assert.ok(body?.turnstile_verified, 'the turnstile gate must have run');

  assert.equal(response.headers.get('Access-Control-Allow-Origin'), ALLOWED_ORIGIN);
  assert.equal(response.headers.get('Access-Control-Allow-Credentials'), 'true');
});
