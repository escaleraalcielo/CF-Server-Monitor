import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const notificationSource = readFileSync(
  fileURLToPath(new URL('../src/services/notification.js', import.meta.url)),
  'utf8'
);

test('every outbound notification URL is scheme-checked in one place', () => {
  // The check lives in fetchWithRetry, the helper all the HTTP channels
  // go through. A per-channel check would drift: new channels would not
  // get one, and the ones that had would drift apart.
  const block = notificationSource.slice(
    notificationSource.indexOf('async function fetchWithRetry'),
    notificationSource.indexOf('function stripMarkdown')
  );
  assert.ok(block.length > 0, 'fetchWithRetry not found');
  assert.ok(
    /parsed\.protocol !== 'http:' && parsed\.protocol !== 'https:'/.test(block),
    'fetchWithRetry must reject any scheme other than http/https'
  );
  assert.ok(
    block.indexOf('parsed.protocol') < block.indexOf('await fetch('),
    'the scheme check must happen before the request is made'
  );
});

test('no channel checks the scheme on its own any more', () => {
  // Exactly one scheme check, in the shared helper.
  const checks = [...notificationSource.matchAll(/protocol !== 'http:'/g)];
  assert.equal(
    checks.length, 1,
    `expected one scheme check in fetchWithRetry, found ${checks.length}`
  );
});

test('the SMTP channel is not affected by the http/https check', () => {
  // SMTP goes through the cloudflare-smtp package (cloudflare:sockets),
  // not through fetchWithRetry - so the scheme check cannot break it.
  assert.ok(
    notificationSource.includes("await import('cloudflare-smtp')"),
    'the SMTP channel must still use the cloudflare-smtp package'
  );
  const smtpBlock = notificationSource.slice(
    notificationSource.indexOf('async function sendSmtpNotification'),
    notificationSource.indexOf('export async function sendNotification')
  );
  assert.ok(
    !smtpBlock.includes('fetchWithRetry('),
    'the SMTP channel must not go through the http/https scheme check'
  );
});

test('the OneBot url variable is spelled consistently', () => {
  // A case mismatch would be a ReferenceError at send time, swallowed by
  // the try/catch into a generic failure message.
  const declared = notificationSource.match(/let (one\w*[Uu]rl) =/);
  assert.ok(declared, 'the OneBot url variable declaration was not found');
  const uses = [...notificationSource.matchAll(/\b(one\w*[Uu]rl)\b/g)].map(m => m[1]);
  const distinct = [...new Set(uses)];
  assert.equal(
    distinct.length, 1,
    `the OneBot url variable is spelled inconsistently: ${distinct.join(', ')}`
  );
});
