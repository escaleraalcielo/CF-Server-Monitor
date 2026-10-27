import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCredentials, generateToken } from '../src/middleware/auth.js';
import { timingSafeEqualString } from '../src/utils/common.js';

test('timingSafeEqualString matches only identical strings', async () => {
  assert.equal(await timingSafeEqualString('secret', 'secret'), true);
  assert.equal(await timingSafeEqualString('secret', 'secreT'), false);
  assert.equal(await timingSafeEqualString('secret', 'secret-longer'), false);
  assert.equal(await timingSafeEqualString('', ''), true);
});

test('timingSafeEqualString rejects non-string values', async () => {
  assert.equal(await timingSafeEqualString(undefined, undefined), false);
  assert.equal(await timingSafeEqualString(null, null), false);
  assert.equal(await timingSafeEqualString('secret', undefined), false);
});

test('admin login is refused when no independent password is configured', async () => {
  const env = { API_SECRET: 'shared-agent-secret' };
  const sys = { username: 'admin' };

  const result = await validateCredentials('admin', 'shared-agent-secret', env, sys);

  assert.equal(result.valid, false);
  assert.equal(result.needsPasswordUpgrade, false);
});

test('admin login accepts a configured password hash and rejects wrong ones', async () => {
  const { hashPassword } = await import('../src/utils/common.js');
  const storedHash = await hashPassword('correct-horse-battery-staple');
  const env = { API_SECRET: 'shared-agent-secret' };
  const sys = { username: 'admin', password: storedHash };

  const ok = await validateCredentials('admin', 'correct-horse-battery-staple', env, sys);
  assert.equal(ok.valid, true);

  const bad = await validateCredentials('admin', 'wrong-password', env, sys);
  assert.equal(bad.valid, false);

  const badUser = await validateCredentials('root', 'correct-horse-battery-staple', env, sys);
  assert.equal(badUser.valid, false);
});

test('JWT signing never falls back to the shared agent secret', async () => {
  const env = { API_SECRET: 'shared-agent-secret' };
  const sys = { username: 'admin' };

  await assert.rejects(
    () => generateToken(env, sys),
    /JWT secret is not configured/
  );
});

test('JWT signing uses the dedicated JWT_SECRET when no stored secret exists', async () => {
  const env = { API_SECRET: 'shared-agent-secret', JWT_SECRET: 'j'.repeat(32) };
  const sys = { username: 'admin' };

  const token = await generateToken(env, sys);
  assert.equal(typeof token, 'string');
  assert.equal(token.split('.').length, 3);
});

test('JWT tokens are base64url encoded and survive a query string round trip', async () => {
  const env = { API_SECRET: 'shared-agent-secret', JWT_SECRET: 'j'.repeat(32) };
  const sys = { username: 'admin' };

  const token = await generateToken(env, sys);
  const [header, payload, signature] = token.split('.');

  assert.match(header, /^[A-Za-z0-9_-]+$/);
  assert.match(payload, /^[A-Za-z0-9_-]+$/);
  assert.match(signature, /^[A-Za-z0-9_-]+$/);

  // 模拟把 token 放进 URL 查询参数再取回：标准 base64 的 '+' / '/' 会被破坏。
  const url = new URL('https://example.com/api/ws');
  url.searchParams.set('token', token);
  const roundTripped = new URL(url.toString()).searchParams.get('token');

  assert.equal(roundTripped, token);
});
