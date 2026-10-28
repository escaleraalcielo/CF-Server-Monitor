import test from 'node:test';
import assert from 'node:assert/strict';

import { MetricsBroadcaster } from '../src/durable/MetricsBroadcaster.js';
import {
  createAgentToken,
  getSharedSecretUsage
} from '../src/utils/agentTokens.js';

const SHARED_SECRET = 'shared-agent-secret';
const SERVER_A = 'server-a';
const SERVER_B = 'server-b';

// The Workers runtime provides this global; Node does not.
globalThis.WebSocketRequestResponsePair = class WebSocketRequestResponsePair {
  constructor(request, response) {
    this.request = request;
    this.response = response;
  }
};

/**
 * 一个够用的 D1 假实现：覆盖节点令牌查询、上报鉴权和共享密钥计数真正用到的语句，
 * 但每条语句都按真实语义执行——写进去的令牌摘要、计数都能读回来。
 */
function createFakeDb({ servers = [], agentTokens = [] } = {}) {
  const state = {
    servers: new Map(servers.map(server => [server.id, { ...server }])),
    settings: new Map(),
    agentTokens: new Map(agentTokens.map(token => [token.server_id, { ...token }])),
    historyWrites: []
  };

  function prepare(sql) {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    const params = [];

    const statement = {
      bind(...values) {
        params.push(...values);
        return statement;
      },
      async first() {
        if (/from servers where id/i.test(text)) {
          return state.servers.get(params[0]) || null;
        }
        if (/from settings where key/i.test(text)) {
          const value = state.settings.get(params[0]);
          return value === undefined ? null : { value };
        }
        if (/from agent_tokens where server_id/i.test(text)) {
          return state.agentTokens.get(params[0]) || null;
        }
        return null;
      },
      async all() {
        if (/from agent_tokens where token_prefix/i.test(text)) {
          const prefix = params[0];
          return {
            results: [...state.agentTokens.values()]
              .filter(row => row.token_prefix === prefix)
              .map(row => ({ ...row }))
          };
        }
        return { results: [] };
      },
      async run() {
        if (/insert into settings/i.test(text)) {
          const key = params[0];
          const previous = state.settings.get(key);
          const previousValue = previous ? JSON.parse(previous) : {};
          const value = JSON.stringify({
            total: Number(previousValue.total || 0) + 1,
            hour: params[2],
            hour_count: previousValue.hour === params[2] ? Number(previousValue.hour_count || 0) + 1 : 1,
            last_used_at: params[4]
          });
          state.settings.set(key, value);
          return { success: true, meta: { changes: 1 } };
        }
        if (/insert into agent_tokens/i.test(text)) {
          state.agentTokens.set(params[0], {
            server_id: params[0],
            token_hash: params[1],
            token_prefix: params[2],
            created_at: params[3],
            rotated_at: params[4],
            last_used_at: params[5]
          });
          return { success: true, meta: { changes: 1 } };
        }
        if (/update agent_tokens set last_used_at/i.test(text)) {
          const row = state.agentTokens.get(params[1]);
          if (row) row.last_used_at = params[0];
          return { success: true, meta: { changes: 1 } };
        }
        if (/insert into metrics_history/i.test(text)) {
          state.historyWrites.push(params);
          return { success: true, meta: { changes: 1 } };
        }
        return { success: true, meta: { changes: 0 } };
      }
    };
    return statement;
  }

  return {
    prepare,
    __state: state
  };
}

function makeBroadcaster(env) {
  const accepted = [];
  return new MetricsBroadcaster({
    setWebSocketAutoResponse() {},
    getWebSockets() {
      return accepted;
    },
    acceptWebSocket(ws) {
      accepted.push(ws);
    },
    waitUntil() {},
    storage: {
      async get() {
        return null;
      },
      async put() {}
    }
  }, env);
}

/** 一个与运行时语义一致的 WebSocket 桩：attachment 在存储里往返，读回来的是副本。 */
function makeHibernationSocket() {
  let attachment = null;
  return {
    sent: [],
    closed: false,
    closeCode: 0,
    closeReason: '',
    serializeAttachment(value) {
      attachment = value;
    },
    deserializeAttachment() {
      return attachment;
    },
    send(message) {
      this.sent.push(message);
    },
    close(code, reason) {
      this.closed = true;
      this.closeCode = code;
      this.closeReason = reason;
    }
  };
}

/** The rejection is reported as an error frame; the socket close code is the policy code. */
function errorFrame(socket) {
  for (let i = socket.sent.length - 1; i >= 0; i--) {
    let message = socket.sent[i];
    try {
      message = typeof message === 'string' ? JSON.parse(message) : message;
    } catch (_) {
      continue;
    }
    if (message && message.type === 'error') return message;
  }
  return null;
}

function serverRow(id, name) {
  return {
    id,
    name: name || id,
    server_group: 'Default',
    region: '',
    is_hidden: '0',
    sort_order: 0,
    history_partition_id: 1,
    timestamp: 1700000000000
  };
}

async function seedToken(db, serverId) {
  // createAgentToken returns the metadata object; the plaintext is shown once.
  const created = await createAgentToken(db, serverId);
  return { plaintext: created.plaintext, row: db.__state.agentTokens.get(serverId) };
}

test('the WebSocket ingest path accepts a per-node token for its own server', async () => {
  const db = createFakeDb({ servers: [serverRow(SERVER_A, 'server a')] });
  const { plaintext } = await seedToken(db, SERVER_A);
  const env = { DB: db, API_SECRET: SHARED_SECRET };
  const broadcaster = makeBroadcaster(env);
  const socket = makeHibernationSocket();

  broadcaster._acceptAgentReportWebSocket(socket, {
    kind: 'agent-report',
    authenticated: false,
    serverId: '',
    historyPartitionId: 0,
    reportIntervalMs: 60_000,
    lastD1WriteTs: 0
  });

  await broadcaster.webSocketMessage(socket, JSON.stringify({
    type: 'update',
    payload: {
      id: SERVER_A,
      secret: plaintext,
      timestamp: Date.now(),
      metrics: { cpu: 12, ram_total: 100, ram_used: 40, net_in_speed: 1024 }
    }
  }));

  const rejection = errorFrame(socket);
  assert.notEqual(rejection?.code, 401, 'a valid node token must not be rejected');
  const attachment = socket.deserializeAttachment();
  assert.equal(attachment.authenticated, true, 'the socket is authenticated');
  assert.equal(attachment.serverId, SERVER_A);
});

test('the WebSocket ingest path rejects a per-node token used for another server', async () => {
  const db = createFakeDb({ servers: [serverRow(SERVER_A), serverRow(SERVER_B)] });
  const { plaintext } = await seedToken(db, SERVER_A);
  const env = { DB: db, API_SECRET: SHARED_SECRET };
  const broadcaster = makeBroadcaster(env);
  const socket = makeHibernationSocket();

  broadcaster._acceptAgentReportWebSocket(socket, {
    kind: 'agent-report',
    authenticated: false,
    serverId: '',
    historyPartitionId: 0,
    reportIntervalMs: 60_000,
    lastD1WriteTs: 0
  });

  await broadcaster.webSocketMessage(socket, JSON.stringify({
    type: 'update',
    payload: {
      id: SERVER_B,
      secret: plaintext,
      timestamp: Date.now(),
      metrics: { cpu: 12, ram_total: 100, ram_used: 40, net_in_speed: 1024 }
    }
  }));

  assert.equal(errorFrame(socket)?.code, 401, "node A's token must not authenticate server B");
});

test('the WebSocket ingest path counts shared-secret use, so it can be retired', async () => {
  const db = createFakeDb({ servers: [serverRow(SERVER_A)] });
  const env = { DB: db, API_SECRET: SHARED_SECRET };
  const broadcaster = makeBroadcaster(env);
  const socket = makeHibernationSocket();

  broadcaster._acceptAgentReportWebSocket(socket, {
    kind: 'agent-report',
    authenticated: false,
    serverId: '',
    historyPartitionId: 0,
    reportIntervalMs: 60_000,
    lastD1WriteTs: 0
  });

  await broadcaster.webSocketMessage(socket, JSON.stringify({
    type: 'update',
    payload: {
      id: SERVER_A,
      secret: SHARED_SECRET,
      timestamp: Date.now(),
      metrics: { cpu: 12, ram_total: 100, ram_used: 40, net_in_speed: 1024 }
    }
  }));

  assert.notEqual(errorFrame(socket)?.code, 401, 'the shared secret still authenticates during the transition');
  const usage = await getSharedSecretUsage(db);
  assert.ok(usage && usage.total >= 1, 'shared-secret use over WSS must move the counter');
});

test('the WebSocket ingest path rejects an unknown credential', async () => {
  const db = createFakeDb({ servers: [serverRow(SERVER_A)] });
  const env = { DB: db, API_SECRET: SHARED_SECRET };
  const broadcaster = makeBroadcaster(env);
  const socket = makeHibernationSocket();

  broadcaster._acceptAgentReportWebSocket(socket, {
    kind: 'agent-report',
    authenticated: false,
    serverId: '',
    historyPartitionId: 0,
    reportIntervalMs: 60_000,
    lastD1WriteTs: 0
  });

  await broadcaster.webSocketMessage(socket, JSON.stringify({
    type: 'update',
    payload: {
      id: SERVER_A,
      secret: 'cfsat_not-a-real-token',
      timestamp: Date.now(),
      metrics: { cpu: 12, ram_total: 100, ram_used: 40, net_in_speed: 1024 }
    }
  }));

  assert.equal(errorFrame(socket)?.code, 401, 'an unknown credential is rejected');
});
