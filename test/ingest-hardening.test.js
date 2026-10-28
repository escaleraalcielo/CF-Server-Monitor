import test from 'node:test';
import assert from 'node:assert/strict';

import { handleUpdate } from '../src/handlers/update.js';
import { timingSafeEqualString } from '../src/utils/common.js';
import { UPDATE_MAX_REQUEST_BYTES } from '../src/utils/config.js';

const API_SECRET = 'shared-secret';

function createRequest(body, headers = {}) {
  return new Request('https://example.com/update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body
  });
}

function makeEnv(overrides = {}) {
  return {
    API_SECRET,
    DB: {
      prepare() {
        return {
          bind(id) {
            return { first: async () => null };
          }
        };
      }
    },
    ...overrides
  };
}

test('the shared secret is compared in constant time', async () => {
  assert.equal(await timingSafeEqualString('secret', 'secret'), true);
  assert.equal(await timingSafeEqualString('secret', 'secrez'), false);
  assert.equal(await timingSafeEqualString('secret', 'secret-longer'), false);
  assert.equal(await timingSafeEqualString('', ''), true);
  assert.equal(await timingSafeEqualString(undefined, ''), true);
  assert.equal(await timingSafeEqualString(undefined, 'x'), false);
});

test('handleUpdate rejects a body that lies about its Content-Length', async () => {
  // Content-Length 只是声明：chunked 请求可以不带它，也可以写一个更小的值。
  // 真正的上限必须建立在“读了多少字节”上。
  const oversized = 'x'.repeat(UPDATE_MAX_REQUEST_BYTES + 1024);
  let dbTouched = false;
  const env = makeEnv({
    DB: {
      prepare() {
        dbTouched = true;
        throw new Error('D1 should not be touched');
      }
    }
  });

  const response = await handleUpdate(
    createRequest(oversized, { 'Content-Length': '10' }),
    env,
    { waitUntil() {} }
  );

  assert.equal(response.status, 413);
  assert.equal(response.headers.get('X-CFSM-Agent-Status'), 'payload_too_large');
  assert.equal(dbTouched, false, 'an oversized body must not reach D1');
});

test('handleUpdate rejects an oversized body that declares no length at all', async () => {
  const oversized = 'x'.repeat(UPDATE_MAX_REQUEST_BYTES + 1024);
  const env = makeEnv();

  const response = await handleUpdate(
    createRequest(oversized),
    env,
    { waitUntil() {} }
  );

  assert.equal(response.status, 413);
  assert.equal(response.headers.get('X-CFSM-Agent-Status'), 'payload_too_large');
});

test('handleUpdate accepts the secret in the body', async () => {
  const response = await handleUpdate(
    createRequest(JSON.stringify({ id: 'server-1', secret: API_SECRET })),
    makeEnv(),
    { waitUntil() {} }
  );

  assert.equal(response.status, 404, 'the secret is accepted; the server id is simply unknown');
});

test('handleUpdate rejects a wrong secret in the body', async () => {
  const response = await handleUpdate(
    createRequest(JSON.stringify({ id: 'server-1', secret: 'wrong-secret' })),
    makeEnv(),
    { waitUntil() {} }
  );

  assert.equal(response.status, 401);
});

test('handleUpdate rejects a malformed body with 400, not 500', async () => {
  const response = await handleUpdate(
    createRequest('{not json'),
    makeEnv(),
    { waitUntil() {} }
  );

  assert.equal(response.status, 400);
});
