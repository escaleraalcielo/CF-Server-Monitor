import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { readBodyWithLimit, getDeclaredContentLength, readJsonBodyWithLimit } from '../src/utils/requestBody.js';
import { handleAdminAPI } from '../src/handlers/admin.js';

const indexSource = readFileSync(
  fileURLToPath(new URL('../src/index.js', import.meta.url)),
  'utf8'
);

test('a body over the limit is rejected instead of parsed', async () => {
  const oversized = new Request('https://example.com/admin/api', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'login', pad: 'x'.repeat(600 * 1024) })
  });

  const response = await handleAdminAPI(oversized, { API_SECRET: 'secret' }, {}, null, null);
  assert.equal(response.status, 413);
  const body = await response.json();
  assert.equal(body.code, 413);
});

test('a normal admin request still reaches the action handlers', async () => {
  const request = new Request('https://example.com/admin/api', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'get_settings' })
  });

  // No auth -> the handler must answer with an auth failure, not a 413 and
  // not a crash. Any non-413 status proves the body was parsed.
  const response = await handleAdminAPI(request, { API_SECRET: 'secret' }, {}, null, null);
  assert.notEqual(response.status, 413);
});

test('the shared body helpers behave', async () => {
  // Node's Request does not add a Content-Length header the way a real
  // request would, so the declared-length path is exercised explicitly.
  assert.equal(
    getDeclaredContentLength(new Request('https://e.com/', {
      method: 'POST', headers: { 'Content-Length': '3' }, body: 'abc'
    })),
    3
  );
  assert.equal(getDeclaredContentLength(new Request('https://e.com/', { method: 'POST' })), null);

  const tooBig = new Request('https://e.com/', { method: 'POST', body: 'x'.repeat(200000) });
  assert.equal(await readBodyWithLimit(tooBig, 65536), null);

  const small = new Request('https://e.com/', { method: 'POST', body: '{"a":1}' });
  assert.deepEqual(await readJsonBodyWithLimit(small, 65536), { ok: true, data: { a: 1 } });

  const broken = new Request('https://e.com/', { method: 'POST', body: 'not json' });
  assert.deepEqual(await readJsonBodyWithLimit(broken, 65536), { ok: false, reason: 'invalid' });
});

test('the admin handler caps the body before parsing it', () => {
  const handler = readFileSync(
    fileURLToPath(new URL('../src/handlers/admin.js', import.meta.url)),
    'utf8'
  );
  const start = handler.indexOf('export async function handleAdminAPI');
  const end = handler.indexOf('\nexport ', start + 1);
  const body = handler.slice(start, end === -1 ? handler.length : end);
  assert.ok(body.length > 0, 'handleAdminAPI not found');
  assert.ok(
    !body.includes('await request.json()'),
    'the admin handler must not parse an unbounded body'
  );
  assert.ok(
    body.includes('readJsonBodyWithLimit(request, ADMIN_MAX_REQUEST_BYTES)'),
    'the admin handler must read the body under a limit'
  );
  assert.ok(
    body.indexOf('readJsonBodyWithLimit') < body.indexOf('checkAuth'),
    'the body must be size-checked before the auth decision'
  );
});

test('the health endpoint does not disclose counts without an admin session', () => {
  const block = indexSource.slice(
    indexSource.indexOf("path: '/__do/health'"),
    indexSource.indexOf("path: '/api/config'")
  );
  assert.ok(block.length > 0, 'the health route was not found');
  assert.ok(
    block.includes('checkAuth(request, env, sys)'),
    'the health route must check the admin session itself'
  );
  assert.ok(
    !/stub\.fetch\('http:\/\/internal\/health'\);\s*\}\s*catch/.test(block),
    'the health route must not relay the DO payload unauthenticated'
  );
  // The variable it checks has to be defined in the same scope - a
  // reference to an outer function's local would be a ReferenceError.
  const checked = block.match(/const (\w+) = await checkAuth\(request, env, sys\)/);
  assert.ok(checked, 'the admin check result must be assigned to a local');
  assert.ok(
    block.includes(`if (!${checked[1]})`),
    'the route must use the local it just assigned'
  );
});
