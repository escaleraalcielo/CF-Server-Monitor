import assert from 'node:assert/strict';
import test from 'node:test';

import { handleUpdate } from '../src/handlers/update.js';
import { handleAdminAPI } from '../src/handlers/admin.js';
import { generateToken } from '../src/middleware/auth.js';
import {
  clearAllCaches,
  getLatestMetricsCache,
  setLatestMetricsCache
} from '../src/utils/cache.js';

const SERVER_ID = '11111111-2222-3333-4444-555555555555';

function createEnv() {
  const saved = [];
  const serverRow = {
    id: SERVER_ID,
    name: 'srv',
    secret: 'secret',
    is_hidden: 0,
    history_partition_id: 1,
    timestamp: 0
  };
  return {
    saved,
    API_SECRET: 'secret',
    DB: {
      prepare(sql) {
        const trimmed = String(sql).trim();
        const isServersSelect = /from\s+servers/i.test(trimmed);
        return {
          bind(...args) {
            saved.push({ sql: trimmed, args });
            return {
              run: async () => ({ success: true }),
              first: async () => (isServersSelect ? serverRow : null),
              all: async () => ({ results: [] })
            };
          },
          run: async () => ({ success: true }),
          first: async () => (isServersSelect ? serverRow : null),
          all: async () => ({ results: [] })
        };
      }
    }
  };
}

function createContext() {
  const waits = [];
  return {
    waits,
    waitUntil(promise) {
      waits.push(promise);
    }
  };
}

test('a report invalidates the cached latest-metrics snapshot', async () => {
  clearAllCaches();

  // Simulate the 30s isolate cache already holding a snapshot from before the
  // server reported: the cached map has no entry for this server.
  setLatestMetricsCache(new Map());

  const env = createEnv();
  const ctx = createContext();

  const response = await handleUpdate(
    new Request('https://example.com/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: SERVER_ID,
        secret: 'secret',
        metrics: { cpu: '12.5', ram_used: '2048', timestamp: 1700000000000 }
      })
    }),
    env,
    ctx
  );

  assert.equal(response.status, 200);

  // The cached snapshot must be gone, otherwise a server that just started
  // reporting stays "offline" until the cache expires.
  const cacheInfo = getLatestMetricsCache();
  assert.equal(cacheInfo.cache, null, 'latest-metrics cache should be cleared after a report');

  clearAllCaches();
});

test('a report with an invalid secret does not clear the cache', async () => {
  clearAllCaches();

  const stale = new Map();
  setLatestMetricsCache(stale);

  const env = createEnv();
  const ctx = createContext();

  const response = await handleUpdate(
    new Request('https://example.com/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: SERVER_ID,
        secret: 'wrong',
        metrics: { cpu: '1' }
      })
    }),
    env,
    ctx
  );

  assert.equal(response.status, 401);
  // An unauthenticated request must not be able to flush the cache.
  assert.equal(getLatestMetricsCache().cache, stale);

  clearAllCaches();
});

test('the admin list refresh clears the cached latest-metrics snapshot', async () => {
  clearAllCaches();

  const stale = new Map();
  setLatestMetricsCache(stale);

  const env = createEnv();
  const sys = { username: 'admin', password: '', jwt_secret: 'b'.repeat(48) };
  const token = await generateToken(env, sys);

  const response = await handleAdminAPI(
    new Request('https://example.com/admin/api', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({ action: 'list', refresh: true })
    }),
    env,
    sys,
    null,
    { waitUntil() {} }
  );

  assert.equal(response.status, 200);
  // "Refresh cache" in the admin panel has to drop the metrics snapshot too,
  // otherwise the refreshed list still shows the previous metrics.
  // The list repopulates the cache with fresh data, so the stale snapshot
  // object must no longer be the cached one.
  assert.notEqual(getLatestMetricsCache().cache, stale);

  clearAllCaches();
});

