import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const notificationSource = readFileSync(
  fileURLToPath(new URL('../src/services/notification.js', import.meta.url)),
  'utf8'
);

test('the webhook URL only accepts http and https', () => {
  const block = notificationSource.slice(
    notificationSource.indexOf('function buildWebhookUrl'),
    notificationSource.indexOf('function buildWebhookBody')
  );
  assert.ok(block.length > 0, 'buildWebhookUrl not found');
  assert.ok(
    /url\.protocol !== 'http:' && url\.protocol !== 'https:'/.test(block),
    'the webhook url must reject any other scheme'
  );
  assert.ok(
    block.indexOf('url.protocol') < block.indexOf('return url.toString()'),
    'the scheme check must happen before the url is returned'
  );
});

test('the OneBot endpoint only accepts http and https', () => {
  const block = notificationSource.slice(
    notificationSource.indexOf('onebot:http'),
    notificationSource.indexOf('OneBot 通知发送失败')
  );
  assert.ok(block.length > 0, 'the OneBot block was not found');
  assert.ok(
    /endpointUrl\.protocol !== 'http:' && endpointUrl\.protocol !== 'https:'/.test(block),
    'the OneBot url must reject any other scheme'
  );
});

test('the OneBot variable is spelled consistently', () => {
  // A case mismatch here would be a ReferenceError at send time, and it
  // would be swallowed by the try/catch into a generic failure message.
  const declared = notificationSource.match(/let (one\w*[Uu]rl) =/);
  assert.ok(declared, 'the OneBot url variable declaration was not found');
  const uses = [...notificationSource.matchAll(/\b(one\w*[Uu]rl)\b/g)].map(m => m[1]);
  const distinct = [...new Set(uses)];
  assert.equal(
    distinct.length, 1,
    `the OneBot url variable is spelled inconsistently: ${distinct.join(', ')}`
  );
});
