import assert from 'node:assert/strict';
import test from 'node:test';
import {
  hashPassword,
  verifyPasswordHash,
  PASSWORD_HASH_ITERATIONS,
  PASSWORD_HASH_ALGORITHM
} from '../src/utils/common.js';

test('the password hash uses the current iteration count', async () => {
  const hash = await hashPassword('a-strong-admin-password');
  assert.ok(hash.startsWith(`${PASSWORD_HASH_ALGORITHM}$${PASSWORD_HASH_ITERATIONS}$`));
  // Pinned literally: comparing against the imported constant would make the
  // assertion follow any change to it, and the strength would never be
  // checked. 600000 is the OWASP figure for PBKDF2-HMAC-SHA256.
  assert.ok(
    hash.startsWith(`${PASSWORD_HASH_ALGORITHM}$600000$`),
    'password hashes must use at least 600000 PBKDF2 iterations'
  );
  assert.ok(PASSWORD_HASH_ITERATIONS >= 600000, 'the iteration floor must not be lowered');
});

test('a password hash verifies against itself and does not need a rehash', async () => {
  const hash = await hashPassword('a-strong-admin-password');
  const result = await verifyPasswordHash('a-strong-admin-password', hash);

  assert.equal(result.valid, true);
  assert.equal(result.needsRehash, false);
  assert.equal(result.algorithm, PASSWORD_HASH_ALGORITHM);
});

test('a wrong password does not verify', async () => {
  const hash = await hashPassword('a-strong-admin-password');
  const result = await verifyPasswordHash('not-the-password', hash);

  assert.equal(result.valid, false);
});

test('a hash made with weaker iterations still logs in, and is flagged for upgrade', async () => {
  // The iteration count is part of the hash string, so a hash written before
  // the count was raised must keep working - and must be re-hashed on the
  // next successful login instead of staying weak forever.
  const weakIterations = 1000;
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode('a-strong-admin-password'),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: weakIterations, hash: 'SHA-256' },
    key,
    256
  );
  const hex = (bytes) => Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  const stored = `${PASSWORD_HASH_ALGORITHM}$${weakIterations}$${hex(salt)}$${hex(new Uint8Array(bits))}`;

  const result = await verifyPasswordHash('a-strong-admin-password', stored);
  assert.equal(result.valid, true, 'a weak hash must still authenticate');
  assert.equal(result.needsRehash, true, 'a weak hash must be flagged for upgrade');

  const wrong = await verifyPasswordHash('not-the-password', stored);
  assert.equal(wrong.valid, false);
  assert.equal(wrong.needsRehash, false);
});

test('a legacy MD5 hash is accepted but always flagged for upgrade', async () => {
  // 32 hex chars, no salt - crackable offline in seconds if the row leaks.
  const { md5Hash } = await import('../src/utils/common.js');
  const stored = await md5Hash('legacy-password');

  const result = await verifyPasswordHash('legacy-password', stored);
  assert.equal(result.valid, true);
  assert.equal(result.needsRehash, true, 'a legacy hash must be re-hashed on the next login');
  assert.equal(result.algorithm, 'md5');
});
