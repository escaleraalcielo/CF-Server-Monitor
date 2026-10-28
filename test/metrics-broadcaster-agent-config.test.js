import assert from 'node:assert/strict';
import test from 'node:test';
import { MetricsBroadcaster } from '../src/durable/MetricsBroadcaster.js';
import { getHistoryMetrics, handleUpdateWebSocketUpgrade, handleWebSocketUpgrade } from '../src/handlers/update.js';
import { buildAuthCookie, generateToken } from '../src/middleware/auth.js';
import { buildResourceAlertNotificationPayloads } from '../src/services/notification.js';
import { clearSiteSettingsCache, DEFAULT_NOTIFICATION_TEMPLATE, normalizeNotificationTemplate, normalizeResourceAlertRules } from '../src/utils/settings.js';
import { UPDATE_MAX_REQUEST_BYTES } from '../src/utils/config.js';

globalThis.WebSocketRequestResponsePair = class WebSocketRequestResponsePair {
  constructor(request, response) {
    this.request = request;
    this.response = response;
  }
};

function makeBroadcaster(webSockets = [], env = { DB: {} }) {
  const accepted = webSockets;
  return new MetricsBroadcaster({
    setWebSocketAutoResponse() {},
    getWebSockets() {
      return accepted;
    },
    // Mirrors the runtime: a socket accepted through the hibernation API stays
    // in state.getWebSockets() and survives the object being evicted.
    acceptWebSocket(ws) {
      accepted.push(ws);
    },
    storage: {
      async get() {
        return null;
      },
      async put() {}
    }
  }, env);
}

// A WebSocket mock with the same attachment semantics as the runtime:
// serializeAttachment/deserializeAttachment round-trip through storage, so
// the value handed back is a copy rather than a live reference.
function makeHibernationSocket() {
  let attachment = null;
  return {
    sent: [],
    closed: false,
    send(message) {
      this.sent.push(message);
    },
    close() {
      this.closed = true;
    },
    serializeAttachment(value) {
      attachment = value === undefined || value === null
        ? null
        : JSON.parse(JSON.stringify(value));
    },
    deserializeAttachment() {
      return attachment === null ? null : JSON.parse(JSON.stringify(attachment));
    }
  };
}

function makeSettingsDb(settingsSource) {
  const readSettings = typeof settingsSource === 'function'
    ? settingsSource
    : () => settingsSource;
  return {
    prepare() {
      return {
        bind() {
          return this;
        },
        async first() {
          return {
            value: JSON.stringify({
              jwt_secret: 'x'.repeat(32),
              ...(readSettings() || {})
            })
          };
        },
        async all() {
          return { results: [] };
        },
        async run() {
          return { success: true };
        }
      };
    }
  };
}

function makeDescriptor(md5 = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', schemaVersion = 7) {
  const serialized = schemaVersion >= 7
    ? `collect_interval=2&report_interval=60&reset_day=1&schema_version=${schemaVersion}&custom_ct=&custom_cu=&custom_cm=&custom_bd=&interface=&node_1=&node_2=&node_3=&node_4=&connection_mode=auto&wss_report_interval=2&ping_mode=tcp`
    : schemaVersion >= 6
    ? `collect_interval=2&report_interval=60&reset_day=1&schema_version=${schemaVersion}&custom_ct=&custom_cu=&custom_cm=&custom_bd=&interface=&connection_mode=auto&wss_report_interval=2&ping_mode=tcp`
    : schemaVersion >= 5
    ? `collect_interval=2&report_interval=60&reset_day=1&schema_version=${schemaVersion}&custom_ct=&custom_cu=&custom_cm=&custom_bd=&interface=&connection_mode=auto&wss_report_interval=2`
    : schemaVersion >= 4
      ? `collect_interval=0&report_interval=60&reset_day=1&schema_version=${schemaVersion}&custom_ct=&custom_cu=&custom_cm=&custom_bd=&interface=&connection_mode=auto`
      : `collect_interval=0&report_interval=60&reset_day=1&schema_version=${schemaVersion}&custom_ct=&custom_cu=&custom_cm=&custom_bd=&interface=`;
  const config = {
    collect_interval: schemaVersion >= 5 ? 2 : 0,
    report_interval: 60,
    reset_day: 1,
    schema_version: schemaVersion,
    custom_ct: '',
    custom_cu: '',
    custom_cm: '',
    custom_bd: '',
    interface: ''
  };
  if (schemaVersion >= 4) {
    config.connection_mode = 'auto';
  }
  if (schemaVersion >= 5) {
    config.wss_report_interval = 2;
  }
  if (schemaVersion >= 6) {
    config.ping_mode = 'tcp';
  }
  if (schemaVersion >= 7) {
    config.node_1 = '';
    config.node_2 = '';
    config.node_3 = '';
    config.node_4 = '';
  }
  return {
    serialized,
    md5,
    config,
    correction: null
  };
}

function makeWebSocketUpgradeRequest(url, headers = {}) {
  return new Request(url, {
    headers: {
      Upgrade: 'websocket',
      ...headers
    }
  });
}

function makeWebSocketEnv(settings, onFetch = null) {
  return {
    API_SECRET: 'test-secret',
    DB: makeSettingsDb(settings),
    METRICS_BROADCASTER: {
      idFromName() {
        return 'global';
      },
      get() {
        return {
          async fetch(request) {
            if (onFetch) onFetch(request);
            return { status: 101 };
          }
        };
      }
    }
  };
}

test('private frontend WebSocket rejects unauthenticated clients', async () => {
  let forwarded = false;
  const env = makeWebSocketEnv({ is_public: 'false' }, () => {
    forwarded = true;
  });

  const response = await handleWebSocketUpgrade(
    makeWebSocketUpgradeRequest('https://example.com/api/ws?subscribe=all'),
    env
  );

  assert.equal(response.status, 401);
  assert.equal(forwarded, false);
});

test('Agent WSS upgrade rejects disabled state with fast-switch envelope', async () => {
  clearSiteSettingsCache();
  let forwarded = false;
  const response = await handleUpdateWebSocketUpgrade(
    makeWebSocketUpgradeRequest('https://example.com/update'),
    makeWebSocketEnv({
      wss_report_enabled: 'false'
    }, () => {
      forwarded = true;
    })
  );

  assert.equal(response.status, 409);
  assert.equal(response.headers.get('X-Agent-Wss-Mode'), 'disabled');
  assert.equal(response.headers.get('X-Agent-Wss-Reason'), 'wss_disabled');
  const body = await response.json();
  assert.equal(body.code, 409);
  assert.equal(body.text, 'wss_disabled');
  assert.equal(body.connection_mode, 'http');
  assert.equal(forwarded, false);
});

test('private frontend WebSocket accepts query token auth', async () => {
  let forwardedUrl = '';
  const env = makeWebSocketEnv({ is_public: 'false' }, request => {
    forwardedUrl = request.url;
  });
  const token = await generateToken(env, { jwt_secret: 'x'.repeat(32) });

  const response = await handleWebSocketUpgrade(
    makeWebSocketUpgradeRequest(`https://example.com/api/ws?subscribe=all&token=${encodeURIComponent(token)}`),
    env
  );

  assert.equal(response.status, 101);
  assert.equal(new URL(forwardedUrl).pathname, '/ws');
});

test('private frontend WebSocket accepts auth cookie', async () => {
  let forwarded = false;
  const env = makeWebSocketEnv({ is_public: 'false' }, () => {
    forwarded = true;
  });
  const token = await generateToken(env, { jwt_secret: 'x'.repeat(32) });
  const cookie = buildAuthCookie(new Request('https://example.com/admin'), token);

  const response = await handleWebSocketUpgrade(
    makeWebSocketUpgradeRequest('https://example.com/api/ws?subscribe=all', {
      Cookie: cookie
    }),
    env
  );

  assert.equal(response.status, 101);
  assert.equal(forwarded, true);
});

test('Agent WSS upgrade follows the configured UTC hour schedule', async () => {
  const currentHour = new Date().getUTCHours();
  let forwarded = false;
  clearSiteSettingsCache();
  const enabledResponse = await handleUpdateWebSocketUpgrade(
    makeWebSocketUpgradeRequest('https://example.com/update'),
    makeWebSocketEnv({
      wss_report_enabled: 'true',
      wss_report_hours: [currentHour]
    }, () => {
      forwarded = true;
    })
  );

  assert.equal(enabledResponse.status, 101);
  assert.equal(forwarded, true);

  clearSiteSettingsCache();
  forwarded = false;
  const disabledResponse = await handleUpdateWebSocketUpgrade(
    makeWebSocketUpgradeRequest('https://example.com/update'),
    makeWebSocketEnv({
      wss_report_enabled: 'true',
      wss_report_hours: [(currentHour + 1) % 24]
    }, () => {
      forwarded = true;
    })
  );

  assert.equal(disabledResponse.status, 409);
  assert.equal(disabledResponse.headers.get('X-Agent-Wss-Mode'), 'inactive');
  assert.equal(disabledResponse.headers.get('X-Agent-Wss-Reason'), 'wss_schedule_inactive');
  const disabledBody = await disabledResponse.json();
  assert.equal(disabledBody.text, 'wss_schedule_inactive');
  assert.equal(disabledBody.connection_mode, 'http');
  assert.equal(forwarded, false);
});

test('Durable Object rechecks Agent WSS schedule before accepting a socket', async () => {
  clearSiteSettingsCache();
  const currentHour = new Date().getUTCHours();
  const broadcaster = makeBroadcaster([], {
    DB: makeSettingsDb({
      wss_report_enabled: 'true',
      wss_report_hours: [(currentHour + 1) % 24]
    })
  });

  const response = await broadcaster._handleAgentReportWebSocket(
    makeWebSocketUpgradeRequest('http://internal/update'),
    new URL('http://internal/update')
  );

  assert.equal(response.status, 409);
  assert.equal(response.headers.get('X-Agent-Wss-Mode'), 'inactive');
  assert.equal(response.headers.get('X-Agent-Wss-Reason'), 'wss_schedule_inactive');
  const body = await response.json();
  assert.equal(body.text, 'wss_schedule_inactive');
  assert.equal(body.connection_mode, 'http');
  assert.equal(broadcaster._getAgentReportWebSockets().length, 0);
});

test('Durable Object rejects Agent WSS upgrade when report is disabled', async () => {
  clearSiteSettingsCache();
  const broadcaster = makeBroadcaster([], {
    DB: makeSettingsDb({
      wss_report_enabled: 'false'
    })
  });

  const response = await broadcaster._handleAgentReportWebSocket(
    makeWebSocketUpgradeRequest('http://internal/update'),
    new URL('http://internal/update')
  );

  assert.equal(response.status, 409);
  assert.equal(response.headers.get('X-Agent-Wss-Mode'), 'disabled');
  assert.equal(response.headers.get('X-Agent-Wss-Reason'), 'wss_disabled');
  const body = await response.json();
  assert.equal(body.code, 409);
  assert.equal(body.text, 'wss_disabled');
  assert.equal(body.connection_mode, 'http');
  assert.equal(broadcaster._getAgentReportWebSockets().length, 0);
});

test('WSS agent config state only requests ack for fields in current report', () => {
  const broadcaster = makeBroadcaster();
  assert.deepEqual(
    broadcaster._getAgentConfigState({}, { configSchema: '3', configMd5: 'none' }),
    { schema: '3', md5: 'none', requested: false }
  );
  assert.deepEqual(
    broadcaster._getAgentConfigState({ config_md5: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }, { configSchema: '3', configMd5: 'none' }),
    { schema: '3', md5: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', requested: true }
  );
});

test('WSS agent socket is accepted through the hibernation API and keeps its attachment', async () => {
  const broadcaster = makeBroadcaster();
  const server = makeHibernationSocket();

  let accepted = false;
  server.accept = () => {
    accepted = true;
  };

  const ws = broadcaster._acceptAgentReportWebSocket(server, {
    kind: 'agent-report',
    authenticated: false,
    serverId: ''
  });

  // The standard WebSocket API keeps the object resident for the lifetime of
  // the connection, which is billed as duration. The hibernation API is what
  // lets the object sleep, so it must be the one used here.
  assert.equal(accepted, false, 'the standard WebSocket API must not be used for agent sockets');
  assert.equal(ws, server);
  assert.equal(broadcaster._getAgentReportWebSockets().length, 1);
  assert.equal(ws.deserializeAttachment().kind, 'agent-report');
  assert.equal(ws.deserializeAttachment().authenticated, false);
});

test('WSS agent socket stays discoverable after the object is re-created', async () => {
  // The runtime re-runs the constructor when a hibernated object is woken.
  // Nothing about the agent connection may live only in memory, so the socket
  // has to be found through state.getWebSockets() alone.
  const accepted = [];
  const server = makeHibernationSocket();
  const first = makeBroadcaster(accepted);
  first._acceptAgentReportWebSocket(server, {
    kind: 'agent-report',
    authenticated: true,
    serverId: 'server-1'
  });

  const second = makeBroadcaster(accepted);
  const found = second._getAgentReportWebSockets();
  assert.equal(found.length, 1);
  assert.equal(found[0], server);
  assert.equal(found[0].deserializeAttachment().serverId, 'server-1');
});

test('WSS agent message updates are persisted on the socket attachment', async () => {
  const broadcaster = makeBroadcaster();
  const server = makeHibernationSocket();
  const ws = broadcaster._acceptAgentReportWebSocket(server, { kind: 'agent-report' });

  // Mirrors what the message handler does: read the attachment, change it,
  // write it back. The runtime keeps the value, so a later wake-up sees it.
  const attachment = ws.deserializeAttachment() || {};
  ws.serializeAttachment({ ...attachment, authenticated: true, serverId: 'server-1' });

  assert.equal(ws.deserializeAttachment().serverId, 'server-1');
  assert.equal(ws.deserializeAttachment().authenticated, true);
});

test('WSS agent keeps working across a hibernation wake-up', async () => {
  // The runtime re-creates the object when a hibernated one is woken, so
  // everything the message path needs has to survive in the socket attachment
  // or in Durable Object storage - never only in instance fields.
  const historyWrites = [];
  const serverRow = {
    id: 'server-hibernate-1',
    name: 'srv',
    secret: 'test-secret',
    is_hidden: 0,
    history_partition_id: 7
  };
  const db = {
    prepare(sql) {
      const trimmed = String(sql).trim();
      const isServerSelect = /from\s+servers/i.test(trimmed);
      return {
        bind(...args) {
          return {
            async run() {
              if (/insert\s+into\s+metrics_history/i.test(trimmed)) {
                historyWrites.push(args);
              }
              return { success: true, meta: { changes: 1 } };
            },
            async first() {
              return isServerSelect ? serverRow : null;
            }
          };
        },
        async first() {
          return isServerSelect ? serverRow : null;
        },
        async run() {
          if (/insert\s+into\s+metrics_history/i.test(trimmed)) {
            historyWrites.push([]);
          }
          return { success: true, meta: { changes: 1 } };
        }
      };
    }
  };

  const env = { DB: db, API_SECRET: 'test-secret' };
  const accepted = [];
  const server = makeHibernationSocket();
  const sent = [];
  server.send = message => sent.push(JSON.parse(message));

  const first = makeBroadcaster(accepted, env);
  first._acceptAgentReportWebSocket(server, {
    kind: 'agent-report',
    authenticated: false,
    serverId: '',
    historyPartitionId: 0,
    reportIntervalMs: 60_000,
    lastD1WriteTs: 0
  });

  const report = JSON.stringify({
    type: 'update',
    payload: {
      id: 'server-hibernate-1',
      secret: 'test-secret',
      timestamp: Date.now(),
      metrics: { cpu: 12, ram_total: 100, ram_used: 40, net_in_speed: 1024 }
    }
  });

  await first.webSocketMessage(server, report);

  // The socket is now authenticated and the write cadence is recorded on it.
  const attachment = server.deserializeAttachment();
  assert.equal(attachment.authenticated, true);
  assert.equal(attachment.serverId, 'server-hibernate-1');
  assert.ok(Number(attachment.lastD1WriteTs) > 0, 'the write timestamp must be on the attachment');
  assert.equal(historyWrites.length, 1, 'the first report writes one history row');

  // The object is evicted and re-created, exactly as the runtime does when a
  // hibernated object is woken.
  const second = makeBroadcaster(accepted, env);
  assert.equal(second.agentHistoryWrites.size, 0, 'instance state starts empty after a wake-up');
  assert.equal(second._getAgentReportWebSockets().length, 1, 'the socket is rediscovered from state');

  // A follow-up report that carries no credentials: the attachment must be
  // enough to keep the connection authenticated.
  await second.webSocketMessage(server, JSON.stringify({
    type: 'update',
    payload: {
      timestamp: Date.now(),
      metrics: { cpu: 14, ram_total: 100, ram_used: 45, net_in_speed: 2048 }
    }
  }));

  assert.equal(historyWrites.length, 1, 'the write cadence survives the wake-up');
  assert.ok(
    sent.some(message => message.type === 'ack'),
    'the agent is still acknowledged after the wake-up'
  );
});

test('WSS agent reconnect does not write an extra history row', async () => {
  // A reconnecting agent gets a fresh attachment that does not carry the last
  // write timestamp, so the timestamp has to come from Durable Object storage
  // - otherwise every reconnect would write one more history row.
  const storageData = new Map();
  const accepted = [];
  const server = makeHibernationSocket();
  const first = makeBroadcaster(accepted, { DB: { prepare: () => ({ bind: () => ({ run: async () => ({ success: true }), first: async () => null }) }) } });
  first.state.storage.get = async key => storageData.get(key) ?? null;
  first.state.storage.put = async (key, value) => { storageData.set(key, value); };

  const ws = first._acceptAgentReportWebSocket(server, {
    kind: 'agent-report',
    authenticated: true,
    serverId: 'server-reconnect-1',
    reportIntervalMs: 60_000
  });

  const persistedAt = Date.now();
  first.agentHistoryWriteState = { 'server-reconnect-1': persistedAt };
  first._persistAgentHistoryWriteState(first.agentHistoryWriteState);
  await new Promise(resolve => setTimeout(resolve, 0));

  assert.ok(storageData.has('agent_history_write_state_v1'));

  // A brand new socket, as after a reconnect: the attachment knows nothing.
  const reconnected = makeHibernationSocket();
  const second = makeBroadcaster(accepted, { DB: { prepare: () => ({ bind: () => ({ run: async () => ({ success: true }), first: async () => null }) }) } });
  second.state.storage.get = async key => storageData.get(key) ?? null;
  second.state.storage.put = async (key, value) => { storageData.set(key, value); };
  await second._loadAgentHistoryWriteState();

  const result = await second._persistAgentHistoryIfDue(reconnected, {
    kind: 'agent-report',
    serverId: 'server-reconnect-1',
    reportIntervalMs: 60_000,
    lastD1WriteTs: 0
  }, {
    serverId: 'server-reconnect-1',
    historyPartitionId: 7,
    metrics: { cpu: 10 },
    regionCode: 'US',
    timestamp: persistedAt + 1_000,
    agentVersion: 'test',
    reportIntervalMs: 60_000
  });

  assert.equal(result.persisted, false, 'the stored write timestamp must suppress a duplicate write');
});

test('resource alert sampling window is restored after a hibernation wake-up', async () => {
  // The window lives in an instance field, which is lost when the object is
  // re-created. If it is not restored, alert samples are never collected again.
  const storageData = new Map();
  const accepted = [];
  const makeState = () => ({
    setWebSocketAutoResponse() {},
    getWebSockets() { return accepted; },
    acceptWebSocket(ws) { accepted.push(ws); },
    storage: {
      async get(key) { return storageData.get(key) ?? null; },
      async put(key, value) { storageData.set(key, value); }
    }
  });

  const cron = new MetricsBroadcaster(makeState(), { DB: {} });
  cron._activateResourceAlertCache(Date.now());
  await new Promise(resolve => setTimeout(resolve, 0));

  assert.ok(storageData.has('resource_alert_cache_state_v1'), 'the window is persisted when the cron activates it');

  // A fresh object, as after a wake-up: the instance field is empty.
  const woken = new MetricsBroadcaster(makeState(), { DB: {} });
  assert.equal(woken._shouldCacheResourceAlertSamples(), false, 'a fresh object has no window');

  await woken._restoreResourceAlertCacheState();
  assert.equal(woken._shouldCacheResourceAlertSamples(), true, 'the window is restored from storage');
});

test('WSS agent ack suggests configured realtime or idle report interval', () => {
  const broadcaster = makeBroadcaster();
  assert.equal(broadcaster._getAgentNextWssReportAfterMs(4000, 60000, true), 4000);
  assert.equal(broadcaster._getAgentNextWssReportAfterMs(4000, 30000, false), 60000);
  assert.equal(broadcaster._getAgentNextWssReportAfterMs(10_000, 120000, false), 120000);
  assert.equal(broadcaster._getAgentNextWssReportAfterMs(1000, 60000, true), 1000);
  assert.equal(broadcaster._getAgentNextWssReportAfterMs(3000, 60000, true), 3000);
  assert.equal(
    broadcaster._getAgentNextWssReportAfterMs(3000, 30000, {
      frontendActive: false,
      resourceAlertActive: true,
      realtimeActive: true
    }),
    60000
  );
  assert.equal(
    broadcaster._getAgentNextWssReportAfterMs(10_000, 120000, {
      frontendActive: false,
      resourceAlertActive: true,
      realtimeActive: true
    }),
    120000
  );
  assert.equal(
    broadcaster._getAgentNextWssReportAfterMs(4000, 120000, {
      frontendActive: true,
      resourceAlertActive: true,
      realtimeActive: true
    }),
    4000
  );
});

test('frontend realtime hint pushes active interval to connected agents', async () => {
  const sent = [];
  const agentWs = {
    deserializeAttachment() {
      return {
        kind: 'agent-report',
        authenticated: true,
        serverId: 'server-1',
        reportIntervalMs: 60000
      };
    },
    send(message) {
      sent.push(JSON.parse(message));
    }
  };
  const broadcaster = makeBroadcaster([agentWs]);
  broadcaster._getAgentHintReportIntervalMs = async () => 30000;

  const hinted = await broadcaster._hintAgentRealtimeIntervals({
    frontendActive: true,
    resourceAlertActive: false,
    realtimeActive: true
  });

  assert.equal(hinted, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'ack');
  assert.equal(sent[0].realtimeHint, true);
  assert.equal(sent[0].nextWssReportAfterMs, 30000);
});

test('WSS agent context uses current report interval from payload', async () => {
  const broadcaster = makeBroadcaster();
  broadcaster.agentServerDetails.set('server-1', {
    data: {
      id: 'server-1',
      history_partition_id: 42,
      report_interval: 60,
      wss_report_interval: 2
    },
    time: Date.now()
  });
  let serialized = null;
  const context = await broadcaster._resolveAgentContext({
    serializeAttachment(value) {
      serialized = value;
    }
  }, {
    kind: 'agent-report',
    authenticated: true,
    serverId: 'server-1',
    historyPartitionId: 42,
    reportIntervalMs: 60000,
    configSchema: '6',
    configMd5: 'none'
  }, {
    id: 'server-1',
    report_interval: 120
  });

  assert.equal(context.reportIntervalMs, 120000);
  assert.equal(context.wssReportIntervalMs, 2000);
  assert.equal(serialized.reportIntervalMs, 120000);
  assert.equal(serialized.wssReportIntervalMs, 2000);
});

test('WSS agent context keeps an authenticated session when server lookup throws', async () => {
  const closed = [];
  const broadcaster = makeBroadcaster([], {
    DB: {
      prepare() {
        return {
          bind() {
            return this;
          },
          async first() {
            throw new Error('D1_ERROR');
          }
        };
      }
    }
  });
  let serialized = null;

  const context = await broadcaster._resolveAgentContext({
    serializeAttachment(value) {
      serialized = value;
    },
    send() {},
    close(code, reason) {
      closed.push({ code, reason });
    }
  }, {
    kind: 'agent-report',
    authenticated: true,
    serverId: 'degraded-server',
    historyPartitionId: 12
  }, {
    id: 'degraded-server'
  });

  assert.ok(context);
  assert.equal(context.historyPartitionId, 12);
  assert.equal(serialized.historyPartitionId, 12);
  assert.equal(closed.length, 0);
});

test('WSS agent context asks the agent to retry when lookup throws before auth', async () => {
  const sent = [];
  const closed = [];
  const broadcaster = makeBroadcaster([], {
    API_SECRET: 'test-secret',
    DB: {
      prepare() {
        return {
          bind() {
            return this;
          },
          async first() {
            throw new Error('D1_ERROR');
          }
        };
      }
    }
  });

  const context = await broadcaster._resolveAgentContext({
    serializeAttachment() {},
    send(message) {
      sent.push(JSON.parse(message));
    },
    close(code, reason) {
      closed.push({ code, reason });
    }
  }, {
    kind: 'agent-report',
    authenticated: false,
    serverId: ''
  }, {
    id: 'degraded-server-2',
    secret: 'test-secret'
  });

  assert.equal(context, null);
  assert.equal(sent[0].code, 503);
  assert.equal(closed[0].code, 1013);
});

test('WSS agent report rejects oversized frames before parsing', async () => {
  const sent = [];
  const closed = [];
  const broadcaster = makeBroadcaster();

  await broadcaster._handleAgentReportMessage({
    send(message) {
      sent.push(JSON.parse(message));
    },
    close(code, reason) {
      closed.push({ code, reason });
    }
  }, 'x'.repeat(UPDATE_MAX_REQUEST_BYTES + 1), {});

  assert.equal(sent[0].code, 413);
  assert.equal(sent[0].text, 'payload_too_large');
  assert.equal(closed[0].code, 1009);
});

test('WSS agent context closes and clears caches when server no longer exists', async () => {
  const sent = [];
  const closed = [];
  const broadcaster = makeBroadcaster([], {
    DB: {
      prepare() {
        return {
          bind() {
            return this;
          },
          async first() {
            return null;
          }
        };
      }
    }
  });
  broadcaster.agentServerDetails.set('deleted-server-test', {
    data: { id: 'deleted-server-test' },
    time: Date.now() - 121 * 1000
  });
  broadcaster.agentHistoryWrites.set('deleted-server-test', {});
  broadcaster.latestReportUpdates.set('deleted-server-test', {});

  const context = await broadcaster._resolveAgentContext({
    serializeAttachment() {
      throw new Error('attachment should not be serialized for a deleted server');
    },
    send(message) {
      sent.push(JSON.parse(message));
    },
    close(code, reason) {
      closed.push({ code, reason });
    }
  }, {
    kind: 'agent-report',
    authenticated: true,
    serverId: 'deleted-server-test'
  }, {
    id: 'deleted-server-test'
  });

  assert.equal(context, null);
  assert.equal(sent[0].type, 'error');
  assert.equal(sent[0].code, 404);
  assert.equal(sent[0].text, 'server_not_found');
  assert.equal(closed[0].code, 1008);
  assert.equal(broadcaster.agentServerDetails.has('deleted-server-test'), false);
  assert.equal(broadcaster.agentHistoryWrites.has('deleted-server-test'), false);
  assert.equal(broadcaster.latestReportUpdates.has('deleted-server-test'), false);
});

test('WSS agent config ack is skipped when report omits config state', async () => {
  const broadcaster = makeBroadcaster();
  let loads = 0;
  broadcaster._loadAgentConfigDescriptor = async () => {
    loads += 1;
    return makeDescriptor();
  };

  const ack = await broadcaster._buildAgentConfigAck({
    attachment: {
      configSchema: '3',
      configMd5: 'none'
    },
    serverId: 'server-1',
    agentConfig: { schema: '6', md5: 'none', requested: false }
  });

  assert.equal(loads, 0);
  assert.equal(ack, null);
});

test('WSS agent config ack is built when report includes config state', async () => {
  const broadcaster = makeBroadcaster();
  let loads = 0;
  broadcaster._loadAgentConfigDescriptor = async () => {
    loads += 1;
    return makeDescriptor();
  };

  const ack = await broadcaster._buildAgentConfigAck({
    attachment: {},
    serverId: 'server-1',
    agentConfig: { schema: '6', md5: 'none', requested: true }
  });

  assert.equal(loads, 1);
  assert.equal(ack.has_config, true);
  assert.equal(ack.config_md5, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
  assert.equal(ack.body, makeDescriptor().serialized);
  assert.equal(ack.config_body, makeDescriptor().serialized);
  assert.equal(ack.payload.report_interval, 60);
  assert.equal(ack.payload.connection_mode, 'auto');
  assert.equal(ack.payload.ping_mode, 'tcp');
  assert.equal(Object.prototype.hasOwnProperty.call(ack, 'config'), false);
});

test('WSS schema 4 agent with matching legacy MD5 does not receive config again', async () => {
  const descriptor = makeDescriptor('dddddddddddddddddddddddddddddddd', 4);
  const broadcaster = makeBroadcaster();
  broadcaster._loadAgentConfigDescriptor = async (_serverId, _forceRefresh, schemaVersion) => {
    assert.equal(schemaVersion, 4);
    return descriptor;
  };

  const ack = await broadcaster._buildAgentConfigAck({
    attachment: {},
    serverId: 'server-1',
    agentConfig: { schema: '4', md5: descriptor.md5, requested: true }
  });

  assert.equal(ack.has_config, false);
  assert.equal(ack.config_md5, descriptor.md5);
  assert.equal(Object.prototype.hasOwnProperty.call(ack, 'body'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(ack, 'payload'), false);
});

test('WSS agent config push uses string body and structured payload', () => {
  const sent = [];
  const ws = {
    deserializeAttachment() {
      return {
        kind: 'agent-report',
        authenticated: true,
        serverId: 'server-1',
        configSchema: '7',
        configMd5: 'none'
      };
    },
    send(message) {
      sent.push(JSON.parse(message));
    }
  };
  const broadcaster = makeBroadcaster([ws]);

  const result = broadcaster._pushAgentConfigFrame('server-1', makeDescriptor());

  assert.deepEqual(result, { matched: 1, delivered: 1 });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'config');
  assert.equal(sent[0].body, makeDescriptor().serialized);
  assert.equal(sent[0].config_body, makeDescriptor().serialized);
  assert.equal(sent[0].payload.report_interval, 60);
  assert.equal(sent[0].payload.connection_mode, 'auto');
  assert.equal(sent[0].payload.ping_mode, 'tcp');
  assert.equal(Object.prototype.hasOwnProperty.call(sent[0], 'config'), false);
});

test('WSS agent config push keeps legacy schema without connection mode', () => {
  const sent = [];
  const ws = {
    deserializeAttachment() {
      return {
        kind: 'agent-report',
        authenticated: true,
        serverId: 'server-1',
        configSchema: '3',
        configMd5: 'none'
      };
    },
    send(message) {
      sent.push(JSON.parse(message));
    }
  };
  const broadcaster = makeBroadcaster([ws]);
  const descriptors = new Map([
    [7, makeDescriptor('eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', 7)],
    [5, makeDescriptor('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 5)],
    [4, makeDescriptor('dddddddddddddddddddddddddddddddd', 4)],
    [3, makeDescriptor('cccccccccccccccccccccccccccccccc', 3)]
  ]);

  const result = broadcaster._pushAgentConfigFrame('server-1', descriptors);

  assert.deepEqual(result, { matched: 1, delivered: 1 });
  assert.equal(sent[0].config_schema, 3);
  assert.equal(sent[0].body, makeDescriptor('cccccccccccccccccccccccccccccccc', 3).serialized);
  assert.equal(Object.prototype.hasOwnProperty.call(sent[0].payload, 'connection_mode'), false);
});

test('WSS agent config descriptor force refreshes site settings', async () => {
  let wssReportEnabled = 'true';
  const broadcaster = makeBroadcaster([], {
    DB: makeSettingsDb(() => ({ wss_report_enabled: wssReportEnabled }))
  });
  broadcaster._getAgentServerDetail = async () => ({
    id: 'server-1',
    collect_interval: 0,
    report_interval: 60,
    reset_day: 1,
    connection_mode: 'auto'
  });

  let descriptor = await broadcaster._loadAgentConfigDescriptor('server-1', true, 4);
  assert.equal(descriptor.config.connection_mode, 'auto');

  wssReportEnabled = 'false';
  descriptor = await broadcaster._loadAgentConfigDescriptor('server-1', true, 4);
  assert.equal(descriptor.config.connection_mode, 'http');
});

test('agent report mode change closes existing Agent WSS when disabled', async () => {
  const sent = [];
  const closed = [];
  const agentWs = {
    deserializeAttachment() {
      return {
        kind: 'agent-report',
        authenticated: true,
        serverId: 'server-1'
      };
    },
    send(message) {
      sent.push(JSON.parse(message));
    },
    close(code, reason) {
      closed.push({ code, reason });
    }
  };
  const frontendWs = {
    deserializeAttachment() {
      return { scope: 'all' };
    },
    send() {
      throw new Error('frontend socket should not receive agent mode messages');
    },
    close() {
      throw new Error('frontend socket should not be closed');
    }
  };
  const broadcaster = makeBroadcaster([agentWs, frontendWs], {
    DB: makeSettingsDb({ wss_report_enabled: 'false' })
  });

  const response = await broadcaster._handleAgentConfigChanged(new Request('http://internal/agent-config-changed', {
    method: 'POST',
    body: JSON.stringify({ agentReportModeChanged: true })
  }));
  const body = await response.json();

  assert.deepEqual(body, {
    ok: true,
    wssReportEnabled: false,
    matched: 1,
    closed: 1
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'error');
  assert.equal(sent[0].code, 409);
  assert.equal(sent[0].text, 'wss_disabled');
  assert.equal(sent[0].connection_mode, 'http');
  assert.deepEqual(closed, [{
    code: 1013,
    reason: 'wss_disabled'
  }]);
});

test('Agent WSS closes on the first report after entering a disabled UTC hour', async () => {
  clearSiteSettingsCache();
  const currentHour = new Date().getUTCHours();
  const sent = [];
  const closed = [];
  let attachment = {
    kind: 'agent-report',
    authenticated: true,
    serverId: 'server-1',
    wssScheduleCheckAfter: Date.now() - 1
  };
  const ws = {
    serializeAttachment(value) {
      attachment = value;
    },
    send(message) {
      sent.push(JSON.parse(message));
    },
    close(code, reason) {
      closed.push({ code, reason });
    }
  };
  const broadcaster = makeBroadcaster([], {
    DB: makeSettingsDb({
      wss_report_enabled: 'true',
      wss_report_hours: [(currentHour + 1) % 24]
    })
  });

  await broadcaster._handleAgentReportMessage(ws, JSON.stringify({ metrics: { cpu: 1 } }), attachment);

  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'error');
  assert.equal(sent[0].code, 409);
  assert.equal(sent[0].text, 'wss_schedule_inactive');
  assert.equal(sent[0].connection_mode, 'http');
  assert.deepEqual(closed, [{
    code: 1013,
    reason: 'wss_schedule_inactive'
  }]);
});

test('batch push latestReportOnly keeps latest report updates without subscribers', async () => {
  const broadcaster = makeBroadcaster([]);
  const response = await broadcaster.fetch(new Request('http://internal/batch-push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      latestReportOnly: true,
      updates: [{
        serverId: 'server-1',
        samples: [
          { ts: 1_000, payload: { cpu: 10, net_in_speed: 100 } },
          { ts: 2_000, payload: { cpu: 20, net_in_speed: 200 } }
        ]
      }]
    })
  }));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.latestReportOnly, true);
  assert.equal(body.subscribers, 0);

  const latestResponse = await broadcaster.fetch(new Request('http://internal/latest-report-updates', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ serverIds: ['server-1'] })
  }));
  const latest = await latestResponse.json();

  assert.equal(latestResponse.status, 200);
  assert.equal(latest.updates.length, 1);
  assert.equal(latest.updates[0].serverId, 'server-1');
  assert.equal(latest.updates[0].samples.length, 2);
  assert.deepEqual(latest.updates[0].samples.map(sample => sample.data.cpu), [10, 20]);
  assert.equal(Number.isFinite(latest.updates[0].reportAgeMs), true);
});

test('Agent WSS batches all-scope subscribers while single-server subscribers stay realtime', async () => {
  const allMessages = [];
  const singleMessages = [];
  const makeFrontendSocket = (attachment, messages) => ({
    deserializeAttachment() {
      return attachment;
    },
    send(message) {
      messages.push(JSON.parse(message));
    }
  });
  const broadcaster = makeBroadcaster([
    makeFrontendSocket({ scope: 'all', serverIds: ['server-1', 'server-2'] }, allMessages),
    makeFrontendSocket({ scope: 'server-1', serverIds: [] }, singleMessages)
  ]);

  await broadcaster._ingestRealtimeUpdates([{
    serverId: 'server-1',
    samples: [{ ts: 2_000, data: { cpu: 20 } }]
  }], 10_000, { batchFrontend: true });
  await broadcaster._ingestRealtimeUpdates([{
    serverId: 'server-1',
    samples: [{ ts: 1_000, data: { cpu: 10 } }]
  }, {
    serverId: 'server-2',
    samples: [{ ts: 3_000, data: { cpu: 30 } }]
  }], 20_000, { batchFrontend: true });

  assert.equal(allMessages.length, 0);
  assert.equal(singleMessages.length, 2);
  assert.deepEqual(singleMessages.map(message => message.updates[0].samples[0].data.cpu), [20, 10]);
  assert.equal(singleMessages.every(message => message.updates.length === 1), true);
  assert.notEqual(broadcaster.frontendBroadcastTimer, null);

  broadcaster._flushFrontendBroadcastBatch();

  assert.equal(allMessages.length, 1);
  assert.equal(allMessages[0].type, 'batchUpdate');
  assert.equal(allMessages[0].ts, 20_000);
  assert.deepEqual(allMessages[0].updates.map(update => update.serverId), ['server-1', 'server-2']);
  assert.deepEqual(allMessages[0].updates[0].samples.map(sample => sample.ts), [1_000, 2_000]);
  assert.deepEqual(allMessages[0].updates[0].samples.map(sample => sample.data.cpu), [10, 20]);

  assert.equal(singleMessages.length, 2);
  assert.equal(broadcaster.pendingFrontendBroadcasts.size, 0);
  assert.equal(broadcaster.frontendBroadcastTimer, null);
});

test('Agent WSS frontend batch queue stays idle without frontend subscribers', () => {
  const broadcaster = makeBroadcaster([]);

  broadcaster._queueFrontendBroadcastBatch([{
    serverId: 'server-1',
    samples: [{ ts: 1_000, data: { cpu: 10 } }]
  }], 10_000);

  assert.equal(broadcaster.pendingFrontendBroadcasts.size, 0);
  assert.equal(broadcaster.frontendBroadcastTimer, null);
});

test('resource alert rule batches are capped at 20 rules', () => {
  const broadcaster = makeBroadcaster();
  const makeRule = index => ({
    ruleId: `rule-${index}`,
    serverIds: ['server-1'],
    mode: 'average',
    windowMinutes: 5,
    thresholds: { cpuPercent: 80 }
  });

  assert.equal(
    broadcaster._normalizeResourceAlertEvaluationRules(Array.from({ length: 20 }, (_, index) => makeRule(index))).ok,
    true
  );
  assert.equal(
    broadcaster._normalizeResourceAlertEvaluationRules(Array.from({ length: 21 }, (_, index) => makeRule(index))).ok,
    false
  );
});

test('resource alert batch evaluation returns results per rule', async () => {
  const broadcaster = makeBroadcaster();
  const now = Date.now();
  const currentMinute = Math.floor(now / 60_000) * 60_000;
  const samples = [];
  for (let index = 4; index >= 0; index--) {
    const ts = currentMinute - index * 60_000;
    samples.push({
      ts,
      minuteTs: ts,
      cpu: 90,
      ram: 30,
      disk: 40,
      netIn: 0,
      netOut: 0,
      netTotal: 0
    });
  }
  broadcaster.resourceAlertWindows.set('server-1', { samples });

  const result = await broadcaster._evaluateResourceAlertRules([
    {
      ruleId: 'cpu-rule',
      serverIds: ['server-1'],
      mode: 'average',
      windowMinutes: 5,
      thresholds: { cpuPercent: 80 }
    },
    {
      ruleId: 'ram-rule',
      serverIds: ['server-1'],
      mode: 'average',
      windowMinutes: 5,
      thresholds: { ramPercent: 80 }
    }
  ]);

  const byRule = new Map(result.results.map(item => [item.ruleId, item]));
  assert.equal(byRule.get('cpu-rule').alerts.length, 1);
  assert.deepEqual(byRule.get('cpu-rule').evaluatedServerIds, ['server-1']);
  assert.equal(byRule.get('ram-rule').alerts.length, 0);
  assert.deepEqual(byRule.get('ram-rule').evaluatedServerIds, ['server-1']);
});

test('resource alert notification payloads group metrics by server and split long batches', () => {
  const alertNodes = [];
  alertNodes.push({
    rule: { name: 'CPU Alert', intervalMinutes: '5' },
    server: { name: 'shared-server' },
    alert: {
      mode: 'average',
      metrics: [{ metric: 'cpu', mode: 'average', threshold: 1, current: 1.05, triggerValue: 1.05 }]
    }
  });
  alertNodes.push({
    rule: { name: 'RAM Alert', intervalMinutes: '5' },
    server: { name: 'shared-server' },
    alert: {
      mode: 'average',
      metrics: [{ metric: 'ram', mode: 'average', threshold: 1, current: 42.7, triggerValue: 42.7 }]
    }
  });
  for (let index = 0; index < 180; index++) {
    alertNodes.push({
      rule: { name: 'RAM Alert', intervalMinutes: '5' },
      server: { name: `ram-server-${String(index).padStart(2, '0')}` },
      alert: {
        mode: 'average',
        metrics: [{ metric: 'ram', mode: 'average', threshold: 1, current: 80, triggerValue: 80 }]
      }
    });
  }
  alertNodes.push({
    rule: { name: 'CPU Alert', intervalMinutes: '5' },
    server: { name: 'cpu-server' },
    alert: {
      mode: 'average',
      metrics: [{ metric: 'cpu', mode: 'average', threshold: 1, current: 90, triggerValue: 90 }]
    }
  });

  const payloads = buildResourceAlertNotificationPayloads(alertNodes, [], '2026/08/20 12:00:00');

  assert.equal(payloads.length > 1, true);
  assert.equal(payloads.some(payload => payload.msg.includes('shared-server  CPU 1.05%  RAM 42.7%')), true);
  assert.equal(payloads.some(payload => payload.msg.includes('cpu-server  CPU 90.0%')), true);
  assert.equal(payloads.every(payload => payload.msg.length <= 3200), true);
});

test('legacy default notification template normalizes to concise default', () => {
  const legacy = '{{emoji}}【CF Server Monitor】{{event}}\n服务器: {{client}}\n详情:\n{{message}}\n时间: {{time}}';
  const previousConcise = '{{emoji}}【CF Server Monitor】{{event}}\n\n{{message}}\n\n时间: {{time}}';
  assert.equal(normalizeNotificationTemplate(legacy), DEFAULT_NOTIFICATION_TEMPLATE);
  assert.equal(normalizeNotificationTemplate(previousConcise), DEFAULT_NOTIFICATION_TEMPLATE);
  assert.equal(DEFAULT_NOTIFICATION_TEMPLATE.includes('服务器:'), false);
  assert.equal(DEFAULT_NOTIFICATION_TEMPLATE.includes('时间:'), false);
  assert.equal(DEFAULT_NOTIFICATION_TEMPLATE.includes('{{message}}'), true);
});

test('resource alert rule ids remain unique when duplicate ids are already max length', () => {
  const id = 'a'.repeat(64);
  const rules = normalizeResourceAlertRules([
    { id, metric: 'cpu', threshold: 80, servers: ['server-1'], intervalMinutes: 5 },
    { id, metric: 'ram', threshold: 80, servers: ['server-1'], intervalMinutes: 5 }
  ]);

  assert.equal(rules.length, 2);
  assert.notEqual(rules[0].id, rules[1].id);
  assert.equal(rules.every(rule => rule.id.length <= 64), true);
});

test('resource alert cache accepts payload samples from WSS broadcasts', async () => {
  const broadcaster = makeBroadcaster();
  const now = Date.now();
  const currentMinute = Math.floor(now / 60_000) * 60_000;

  await broadcaster._cacheResourceAlertSamples([{
    serverId: 'server-1',
    samples: [
      {
        ts: currentMinute - 60_000,
        payload: {
          cpu: 90,
          ram_total: 100,
          ram_used: 90,
          disk_total: 100,
          disk_used: 40,
          net_in_speed: 0,
          net_out_speed: 0
        }
      },
      {
        ts: currentMinute,
        payload: {
          cpu: 92,
          ram_total: 100,
          ram_used: 91,
          disk_total: 100,
          disk_used: 40,
          net_in_speed: 0,
          net_out_speed: 0
        }
      }
    ]
  }], now);

  const result = broadcaster._evaluateResourceAlertRule({
    ruleId: 'cpu-ram-rule',
    serverIds: ['server-1'],
    mode: 'average',
    windowMinutes: 5,
    thresholds: {
      cpuPercent: 80,
      ramPercent: 80
    }
  }, now);

  assert.deepEqual(result.evaluatedServerIds, ['server-1']);
  assert.equal(result.alerts.length, 1);
  assert.deepEqual(result.alerts[0].metrics.map(metric => metric.metric), ['cpu', 'ram']);
});

test('history metrics apply configured aggregation policies to batched POST samples', () => {
  const samples = [
    {
      ts: 1,
      metrics: {
        cpu: 20,
        ping_ct: 10,
        net_in_speed: 1024,
        net_out_speed: 2048,
        tcp_conn: 10,
        net_rx: 1000,
        disk: { read_bps: 1024 }
      }
    },
    {
      ts: 2,
      metrics: {
        cpu: 30,
        ping_ct: 20,
        net_in_speed: 40 * 1024 * 1024,
        net_out_speed: 4096,
        tcp_conn: 30,
        net_rx: 2000,
        disk: { read_bps: 80 * 1024 * 1024 }
      }
    },
    {
      ts: 3,
      metrics: {
        cpu: 40,
        ping_ct: 30,
        net_in_speed: 8192,
        net_out_speed: 8 * 1024 * 1024,
        tcp_conn: 20,
        net_rx: 3000,
        disk: { read_bps: 4 * 1024 * 1024 }
      }
    }
  ];

  const metrics = getHistoryMetrics({
    metrics: {
      cpu: 10,
      net_in_speed: 512,
      net_out_speed: 512
    }
  }, samples, samples[samples.length - 1]);

  assert.equal(metrics.cpu, 30);
  assert.equal(metrics.ping_ct, 20);
  assert.equal(metrics.net_in_speed, 40 * 1024 * 1024);
  assert.equal(metrics.net_out_speed, 8 * 1024 * 1024);
  assert.equal(metrics.tcp_conn, 30);
  assert.equal(metrics.net_rx, 3000);
  assert.equal(metrics.disk_read_bps, 80 * 1024 * 1024);
  assert.equal(metrics.disk.read_bps, 80 * 1024 * 1024);
});

test('WSS history persistence carries pending history aggregates into next D1 write', async () => {
  const savedRows = [];
  const db = {
    prepare() {
      return {
        bind(...args) {
          return {
            async run() {
              savedRows.push(args);
              return { meta: { changes: 1 } };
            }
          };
        }
      };
    }
  };
  const broadcaster = makeBroadcaster([], { DB: db });
  const originalNow = Date.now;
  let now = Date.UTC(2026, 0, 1, 0, 0, 0);
  let attachment = {
    reportIntervalMs: 60_000,
    lastD1WriteTs: now
  };
  const ws = {
    deserializeAttachment() {
      return attachment;
    },
    serializeAttachment(value) {
      attachment = value;
    }
  };

  try {
    Date.now = () => now;
    const skipped = await broadcaster._persistAgentHistoryIfDue(ws, attachment, {
      serverId: 'server-1',
      historyPartitionId: 42,
      metrics: {
        cpu: 10,
        net_in_speed: 40 * 1024 * 1024,
        net_out_speed: 3 * 1024 * 1024
      },
      regionCode: 'US',
      timestamp: now,
      agentVersion: 'test',
      reportIntervalMs: 60_000
    });

    assert.equal(skipped.persisted, false);
    assert.equal(savedRows.length, 0);

    now += 61_000;
    const persisted = await broadcaster._persistAgentHistoryIfDue(ws, attachment, {
      serverId: 'server-1',
      historyPartitionId: 42,
      metrics: {
        cpu: 12,
        net_in_speed: 128 * 1024,
        net_out_speed: 9 * 1024 * 1024
      },
      regionCode: 'US',
      timestamp: now,
      agentVersion: 'test',
      reportIntervalMs: 60_000
    });

    assert.equal(persisted.persisted, true);
    assert.equal(savedRows.length, 1);
    assert.equal(savedRows[0][4], 11);
    assert.equal(savedRows[0][6], 40 * 1024 * 1024);
    assert.equal(savedRows[0][7], 9 * 1024 * 1024);
    assert.equal(
      Object.prototype.hasOwnProperty.call(
        broadcaster.agentHistoryWrites.get('server-1'),
        'pendingHistoryAggregate'
      ),
      false
    );
  } finally {
    Date.now = originalNow;
  }
});

test('WSS history persistence keeps samples received during a D1 flush for the next write', async () => {
  const savedRows = [];
  let releaseFirstRun = null;
  let holdNextRun = true;
  const db = {
    prepare() {
      return {
        bind(...args) {
          return {
            async run() {
              savedRows.push(args);
              if (holdNextRun) {
                holdNextRun = false;
                return new Promise(resolve => {
                  releaseFirstRun = () => resolve({ meta: { changes: 1 } });
                });
              }
              return { meta: { changes: 1 } };
            }
          };
        }
      };
    }
  };
  const broadcaster = makeBroadcaster([], { DB: db });
  const originalNow = Date.now;
  let now = Date.UTC(2026, 0, 1, 0, 0, 0);
  let attachment = {
    reportIntervalMs: 30_000,
    lastD1WriteTs: now - 31_000
  };
  const ws = {
    deserializeAttachment() {
      return attachment;
    },
    serializeAttachment(value) {
      attachment = value;
    }
  };

  try {
    Date.now = () => now;
    const firstWrite = broadcaster._persistAgentHistoryIfDue(ws, attachment, {
      serverId: 'server-1',
      historyPartitionId: 42,
      metrics: {
        cpu: 10,
        net_in_speed: 10 * 1024,
        net_out_speed: 1024
      },
      regionCode: 'US',
      timestamp: now,
      agentVersion: 'test',
      reportIntervalMs: 30_000
    });

    await Promise.resolve();
    assert.equal(savedRows.length, 1);
    assert.equal(broadcaster.agentHistoryWrites.get('server-1').flushing, true);

    now += 1_000;
    const skippedDuringFlush = await broadcaster._persistAgentHistoryIfDue(ws, attachment, {
      serverId: 'server-1',
      historyPartitionId: 42,
      metrics: {
        cpu: 12,
        net_in_speed: 5 * 1024 * 1024,
        net_out_speed: 1024
      },
      regionCode: 'US',
      timestamp: now,
      agentVersion: 'test',
      reportIntervalMs: 30_000
    });

    assert.equal(skippedDuringFlush.persisted, false);
    assert.equal(savedRows.length, 1);
    assert.equal(
      broadcaster.agentHistoryWrites.get('server-1').pendingHistoryAggregate.max.net_in_speed,
      5 * 1024 * 1024
    );

    releaseFirstRun();
    const firstResult = await firstWrite;
    assert.equal(firstResult.persisted, true);
    assert.equal(savedRows[0][6], 10 * 1024);

    now += 31_000;
    const secondResult = await broadcaster._persistAgentHistoryIfDue(ws, attachment, {
      serverId: 'server-1',
      historyPartitionId: 42,
      metrics: {
        cpu: 14,
        net_in_speed: 10 * 1024,
        net_out_speed: 2048
      },
      regionCode: 'US',
      timestamp: now,
      agentVersion: 'test',
      reportIntervalMs: 30_000
    });

    assert.equal(secondResult.persisted, true);
    assert.equal(savedRows.length, 2);
    assert.equal(savedRows[1][6], 5 * 1024 * 1024);
  } finally {
    Date.now = originalNow;
  }
});