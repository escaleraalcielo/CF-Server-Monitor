import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { handleUpdate } from '../src/handlers/update.js';
import { handleAdminAPI } from '../src/handlers/admin.js';
import { generateToken } from '../src/middleware/auth.js';
import { hashPassword } from '../src/utils/common.js';
import { createAgentToken, getSharedSecretUsage, resolveAgentInstallSecret } from '../src/utils/agentTokens.js';
import { clearServerDetailCache } from '../src/utils/cache.js';
import { clearSiteSettingsCache } from '../src/utils/settings.js';

const SHARED_SECRET = 'shared-agent-secret';
const SERVER_A = '11111111-1111-4111-8111-111111111111';
const SERVER_B = '22222222-2222-4222-8222-222222222222';

const normalizeSql = (sql) => String(sql).replace(/\s+/g, ' ').trim();

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

/**
 * 一个够用的 D1 假实现：只覆盖节点令牌与上报路径真正用到的语句，
 * 但每条语句都按真实语义执行（写进去的摘要、计数、令牌行都能读回来）。
 */
function createFakeDb({ servers = [], settings = {}, agentTokens = [], agentTokenTable = true } = {}) {
  const state = {
    servers: new Map(servers.map(server => [server.id, { ...server }])),
    settings: new Map(Object.entries(settings)),
    agentTokens: new Map(agentTokens.map(token => [token.server_id, { ...token }])),
    agentTokenTable,
    historyWrites: 0,
    queries: []
  };

  const requireAgentTokenTable = () => {
    if (!state.agentTokenTable) {
      throw new Error('no such table: agent_tokens');
    }
  };

  function prepare(sql) {
    const text = normalizeSql(sql);
    const params = [];
    state.queries.push(text);

    const statement = {
      bind(...values) {
        params.push(...values);
        return statement;
      },
      async first() {
        if (/^SELECT \* FROM servers WHERE id = \?$/.test(text)) {
          return state.servers.get(params[0]) ? { ...state.servers.get(params[0]) } : null;
        }
        if (/^SELECT id FROM servers WHERE id = \?$/.test(text)) {
          const server = state.servers.get(params[0]);
          return server ? { id: server.id } : null;
        }
        if (/FROM agent_tokens WHERE server_id = \?$/.test(text)) {
          requireAgentTokenTable();
          const row = state.agentTokens.get(params[0]);
          return row ? { ...row } : null;
        }
        if (/^SELECT value FROM settings WHERE key = \?$/.test(text)) {
          const value = state.settings.get(params[0]);
          return value === undefined ? null : { value };
        }
        if (/^SELECT value FROM settings WHERE key = 'site_options'$/.test(text)) {
          const value = state.settings.get('site_options');
          return value === undefined ? null : { value };
        }
        return null;
      },
      async all() {
        if (/FROM agent_tokens WHERE token_prefix = \?$/.test(text)) {
          requireAgentTokenTable();
          return {
            results: [...state.agentTokens.values()]
              .filter(row => row.token_prefix === params[0])
              .map(row => ({ ...row }))
          };
        }
        if (/FROM agent_tokens ORDER BY server_id ASC$/.test(text)) {
          requireAgentTokenTable();
          return {
            results: [...state.agentTokens.values()]
              .sort((a, b) => String(a.server_id).localeCompare(String(b.server_id)))
              .map(row => ({ ...row }))
          };
        }
        if (/FROM servers/.test(text)) {
          return { results: [...state.servers.values()].map(server => ({ ...server })) };
        }
        return { results: [] };
      },
      async run() {
        if (/^CREATE TABLE IF NOT EXISTS agent_tokens/.test(text)) {
          state.agentTokenTable = true;
          return { success: true, meta: { changes: 0 } };
        }
        if (/^CREATE INDEX IF NOT EXISTS idx_agent_tokens_prefix/.test(text)) {
          return { success: true, meta: { changes: 0 } };
        }
        if (/^INSERT INTO agent_tokens/.test(text)) {
          requireAgentTokenTable();
          const [serverId, tokenHash, tokenPrefix, createdAt, rotatedAt] = params;
          const existing = state.agentTokens.get(serverId);
          state.agentTokens.set(serverId, {
            server_id: serverId,
            token_hash: tokenHash,
            token_prefix: tokenPrefix,
            created_at: existing ? existing.created_at : createdAt,
            rotated_at: rotatedAt,
            last_used_at: existing ? existing.last_used_at : 0
          });
          return { success: true, meta: { changes: 1 } };
        }
        if (/^UPDATE agent_tokens SET last_used_at/.test(text)) {
          requireAgentTokenTable();
          const [lastUsedAt, serverId] = params;
          const row = state.agentTokens.get(serverId);
          if (row) row.last_used_at = lastUsedAt;
          return { success: true, meta: { changes: row ? 1 : 0 } };
        }
        if (/^DELETE FROM agent_tokens WHERE server_id = \?$/.test(text)) {
          requireAgentTokenTable();
          const removed = state.agentTokens.delete(params[0]);
          return { success: true, meta: { changes: removed ? 1 : 0 } };
        }
        if (/^INSERT INTO settings \(key, value\) VALUES \(\?, \?\) ON CONFLICT\(key\) DO UPDATE SET value = json_object/.test(text)) {
          // 共享密钥使用次数：按 UTC 小时分桶 + 累计总数
          const key = params[0];
          const hour = params[2];
          const now = params[4];
          let existing = {};
          try {
            existing = JSON.parse(String(state.settings.get(key) || '{}'));
          } catch (_) {
            existing = {};
          }
          state.settings.set(key, JSON.stringify({
            total: Number(existing.total || 0) + 1,
            hour,
            hour_count: existing.hour === hour ? Number(existing.hour_count || 0) + 1 : 1,
            last_used_at: now
          }));
          return { success: true, meta: { changes: 1 } };
        }
        if (/^INSERT INTO metrics_history/.test(text)) {
          state.historyWrites += 1;
          return { success: true, meta: { changes: 1 } };
        }
        if (/^DELETE FROM servers WHERE id = \?$/.test(text)) {
          const removed = state.servers.delete(params[0]);
          return { success: true, meta: { changes: removed ? 1 : 0 } };
        }
        if (/^PRAGMA foreign_key_list/.test(text)) {
          return { results: [] };
        }
        return { success: true, meta: { changes: 0 } };
      }
    };

    return statement;
  }

  return { state, prepare };
}

function createUpdateRequest(body, headers = {}) {
  return new Request('https://example.com/update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body)
  });
}

const testCtx = { waitUntil() {} };

async function createAdminContext(db) {
  const env = { API_SECRET: SHARED_SECRET, JWT_SECRET: 'j'.repeat(32), DB: db };
  const sys = { username: 'admin', password: await hashPassword('admin-password') };
  const token = await generateToken(env, sys);
  return { env, sys, token };
}

async function callAdmin(db, action, payload = {}) {
  const { env, sys, token } = await createAdminContext(db);
  const request = new Request('https://example.com/admin/api', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({ action, ...payload })
  });
  const response = await handleAdminAPI(request, env, sys);
  const data = await response.json().catch(() => ({}));
  return { response, data };
}

function resetCaches() {
  clearServerDetailCache();
  clearSiteSettingsCache();
}

test('a per-node token authenticates a report for its own server', async () => {
  resetCaches();
  const db = createFakeDb({ servers: [serverRow(SERVER_A, 'node-a')] });
  const token = await createAgentToken(db, SERVER_A);

  const response = await handleUpdate(
    createUpdateRequest({ id: SERVER_A, secret: token.plaintext, metrics: { cpu: '1' } }),
    { API_SECRET: SHARED_SECRET, DB: db },
    testCtx
  );

  assert.equal(response.status, 200);
  assert.equal(db.state.historyWrites, 1);
});

test('a per-node token in the X-API-Secret header authenticates its own server', async () => {
  resetCaches();
  const db = createFakeDb({ servers: [serverRow(SERVER_A, 'node-a')] });
  const token = await createAgentToken(db, SERVER_A);

  const response = await handleUpdate(
    createUpdateRequest(
      { id: SERVER_A, secret: 'ignored-in-body', metrics: { cpu: '1' } },
      { 'X-API-Secret': token.plaintext }
    ),
    { API_SECRET: SHARED_SECRET, DB: db },
    testCtx
  );

  assert.equal(response.status, 200);
  assert.equal(db.state.historyWrites, 1);
});

test('a per-node token presented for a different server id is rejected with 401', async () => {
  resetCaches();
  const db = createFakeDb({ servers: [serverRow(SERVER_A, 'node-a'), serverRow(SERVER_B, 'node-b')] });
  const token = await createAgentToken(db, SERVER_A);

  const response = await handleUpdate(
    createUpdateRequest({ id: SERVER_B, secret: token.plaintext, metrics: { cpu: '1' } }),
    { API_SECRET: SHARED_SECRET, DB: db },
    testCtx
  );

  assert.equal(response.status, 401);
  assert.equal(db.state.historyWrites, 0);
});

test('a per-node token without a server id reports for the node it belongs to', async () => {
  resetCaches();
  const db = createFakeDb({ servers: [serverRow(SERVER_A, 'node-a')] });
  const token = await createAgentToken(db, SERVER_A);

  const response = await handleUpdate(
    createUpdateRequest({ secret: token.plaintext, metrics: { cpu: '1' } }),
    { API_SECRET: SHARED_SECRET, DB: db },
    testCtx
  );

  assert.equal(response.status, 200);
  assert.equal(db.state.historyWrites, 1);
});

test('unknown and malformed tokens are rejected with 401 and never with 500', async () => {
  resetCaches();
  const db = createFakeDb({ servers: [serverRow(SERVER_A, 'node-a')] });
  const unknownToken = await createAgentToken(db, SERVER_A);

  const malformed = [
    '',
    '   ',
    'not-a-token',
    'cfsat_',
    'cfsat_totally-unknown-token-value',
    'cfsat_' + 'x'.repeat(600),
    null,
    undefined,
    12345,
    { token: 'nope' },
    ['cfsat_list']
  ];

  for (const credential of malformed) {
    const response = await handleUpdate(
      createUpdateRequest({ id: SERVER_A, secret: credential, metrics: { cpu: '1' } }),
      { API_SECRET: SHARED_SECRET, DB: db },
      testCtx
    );
    assert.equal(response.status, 401, `credential ${JSON.stringify(credential)} must be rejected with 401`);
  }

  // 已知格式但库里没有的令牌同样 401
  const rotatedAway = await createAgentToken(db, SERVER_A);
  db.state.agentTokens.clear();
  const unknownResponse = await handleUpdate(
    createUpdateRequest({ id: SERVER_A, secret: rotatedAway.plaintext, metrics: { cpu: '1' } }),
    { API_SECRET: SHARED_SECRET, DB: db },
    testCtx
  );
  assert.equal(unknownResponse.status, 401);
  assert.equal(unknownToken.plaintext.startsWith('cfsat_'), true);
});

test('a deployment without the token table rejects node tokens with 401 instead of 500', async () => {
  resetCaches();
  const db = createFakeDb({ servers: [serverRow(SERVER_A, 'node-a')] });
  const token = await createAgentToken(db, SERVER_A);
  // 模拟存量部署还没建表的情况。
  db.state.agentTokenTable = false;

  const response = await handleUpdate(
    createUpdateRequest({ id: SERVER_A, secret: token.plaintext, metrics: { cpu: '1' } }),
    { API_SECRET: SHARED_SECRET, DB: db },
    testCtx
  );

  assert.equal(response.status, 401);
});

test('the shared secret still authenticates a report and the usage counter increments', async () => {
  resetCaches();
  const db = createFakeDb({ servers: [serverRow(SERVER_A, 'node-a')] });

  const first = await handleUpdate(
    createUpdateRequest({ id: SERVER_A, secret: SHARED_SECRET, metrics: { cpu: '1' } }),
    { API_SECRET: SHARED_SECRET, DB: db },
    testCtx
  );
  assert.equal(first.status, 200);

  const second = await handleUpdate(
    createUpdateRequest({ id: SERVER_A, secret: SHARED_SECRET, metrics: { cpu: '1' } }),
    { API_SECRET: SHARED_SECRET, DB: db },
    testCtx
  );
  assert.equal(second.status, 200);

  const status = await callAdmin(db, 'get_agent_token_status');
  assert.equal(status.response.status, 200);
  assert.equal(status.data.shared_secret_usage_count, 2);
  assert.equal(status.data.shared_secret_usage_total, 2);
  assert.ok(status.data.shared_secret_usage_last_used_at > 0);
});

test('the shared secret usage count falls back to zero once the hour rolls over', async () => {
  resetCaches();
  const db = createFakeDb();

  // 上一次使用发生在很久以前的那个小时桶里。
  db.state.settings.set('api_secret_usage', JSON.stringify({
    total: 9,
    hour: '2020-01-01T00',
    hour_count: 7,
    last_used_at: 1577836800000
  }));

  const usage = await getSharedSecretUsage(db);
  assert.equal(usage.count, 0);
  assert.equal(usage.total, 9);

  const status = await callAdmin(db, 'get_agent_token_status');
  assert.equal(status.data.shared_secret_usage_count, 0);
  assert.equal(status.data.shared_secret_usage_total, 9);
});

test('the shared secret keeps working for the auto-discovery bootstrap path', async () => {
  resetCaches();
  const db = createFakeDb();

  const response = await handleUpdate(
    createUpdateRequest({ secret: SHARED_SECRET, name: 'discovered-node', metrics: { cpu: '1' } }),
    { API_SECRET: SHARED_SECRET, DB: db },
    testCtx
  );

  // 自动发现开关默认关闭：不建号，但认证必须通过（走到 404 而不是 401）。
  assert.equal(response.status, 404);
  assert.equal(response.status, 404);
});

test('rotating a node token invalidates the old one and the new one works', async () => {
  resetCaches();
  const db = createFakeDb({ servers: [serverRow(SERVER_A, 'node-a')] });
  const created = await createAgentToken(db, SERVER_A);

  const rotated = await callAdmin(db, 'rotate_agent_token', { server_id: SERVER_A });
  assert.equal(rotated.response.status, 200);
  assert.equal(typeof rotated.data.agent_token, 'string');
  assert.notEqual(rotated.data.agent_token, created.plaintext);

  const withOldToken = await handleUpdate(
    createUpdateRequest({ id: SERVER_A, secret: created.plaintext, metrics: { cpu: '1' } }),
    { API_SECRET: SHARED_SECRET, DB: db },
    testCtx
  );
  assert.equal(withOldToken.status, 401);

  const withNewToken = await handleUpdate(
    createUpdateRequest({ id: SERVER_A, secret: rotated.data.agent_token, metrics: { cpu: '1' } }),
    { API_SECRET: SHARED_SECRET, DB: db },
    testCtx
  );
  assert.equal(withNewToken.status, 200);
});

test('revoking a node token makes the next report fail with 401', async () => {
  resetCaches();
  const db = createFakeDb({ servers: [serverRow(SERVER_A, 'node-a')] });
  const token = await createAgentToken(db, SERVER_A);

  const before = await handleUpdate(
    createUpdateRequest({ id: SERVER_A, secret: token.plaintext, metrics: { cpu: '1' } }),
    { API_SECRET: SHARED_SECRET, DB: db },
    testCtx
  );
  assert.equal(before.status, 200);

  const revoked = await callAdmin(db, 'revoke_agent_token', { server_id: SERVER_A });
  assert.equal(revoked.response.status, 200);
  assert.equal(revoked.data.revoked, true);

  const after = await handleUpdate(
    createUpdateRequest({ id: SERVER_A, secret: token.plaintext, metrics: { cpu: '1' } }),
    { API_SECRET: SHARED_SECRET, DB: db },
    testCtx
  );
  assert.equal(after.status, 401);
});

test('the plaintext token is stored hashed and cannot be read back through any admin action', async () => {
  resetCaches();
  const db = createFakeDb({ servers: [serverRow(SERVER_A, 'node-a')] });

  const created = await callAdmin(db, 'create_agent_token', { server_id: SERVER_A });
  assert.equal(created.response.status, 200);
  const plaintext = created.data.agent_token;
  assert.equal(typeof plaintext, 'string');
  assert.ok(plaintext.length > 0);

  // 库里只有摘要，没有明文
  const stored = db.state.agentTokens.get(SERVER_A);
  assert.ok(stored);
  assert.notEqual(stored.token_hash, plaintext);
  assert.equal(stored.token_hash.includes(plaintext), false);
  assert.equal(JSON.stringify([...db.state.agentTokens.values()]).includes(plaintext), false);

  // 任何一个 admin action 都取不回明文
  for (const action of ['get_agent_token_status', 'get_settings', 'get_install_secret', 'list']) {
    const result = await callAdmin(db, action);
    assert.equal(JSON.stringify(result.data).includes(plaintext), false, `${action} must not leak the token`);
  }

  // 再创建一次也不会把旧明文带回来
  const second = await callAdmin(db, 'create_agent_token', { server_id: SERVER_A });
  assert.equal(second.response.status, 400);
  assert.equal(second.data.error, 'agentTokenAlreadyExists');
});

test('an admin token action refuses an unknown server', async () => {
  resetCaches();
  const db = createFakeDb({ servers: [serverRow(SERVER_A, 'node-a')] });

  const missing = await callAdmin(db, 'create_agent_token', { server_id: SERVER_B });
  assert.equal(missing.response.status, 400);
  assert.equal(missing.data.error, 'serverNotFound');

  const malformed = await callAdmin(db, 'create_agent_token', { server_id: 'not-a-uuid' });
  assert.equal(malformed.response.status, 400);
  assert.equal(malformed.data.error, 'invalidServerId');
});

test('agent token actions require an authenticated admin session', async () => {
  resetCaches();
  const db = createFakeDb({ servers: [serverRow(SERVER_A, 'node-a')] });

  const request = new Request('https://example.com/admin/api', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'create_agent_token', server_id: SERVER_A })
  });
  const response = await handleAdminAPI(request, { API_SECRET: SHARED_SECRET, DB: db }, { username: 'admin' });

  assert.equal(response.status, 401);
  assert.equal(db.state.agentTokens.size, 0);
});

test('resolveAgentInstallSecret prefers the node token and never returns a broken secret', () => {
  assert.equal(
    resolveAgentInstallSecret({ nodeToken: 'cfsat_abc', hasNodeToken: true, sharedSecret: 'shared' }),
    'cfsat_abc'
  );
  assert.equal(
    resolveAgentInstallSecret({ nodeToken: '', hasNodeToken: false, sharedSecret: 'shared' }),
    'shared'
  );
  // 节点有令牌但明文取不回来：宁可不生成命令，也不要写空密钥。
  assert.equal(
    resolveAgentInstallSecret({ nodeToken: '', hasNodeToken: true, sharedSecret: 'shared' }),
    ''
  );
  assert.equal(
    resolveAgentInstallSecret({ nodeToken: '', hasNodeToken: false, sharedSecret: '' }),
    ''
  );
});

// ── 安装命令 ───────────────────────────────────────────────
// 安装命令是在浏览器里由这个单文件组件生成的，所以这里把组件里真正执行的
// 那几段代码取出来跑：断言的是真实行为，不是源码里有没有某个字符串。

const adminViewPath = fileURLToPath(new URL('../src/frontend/views/admin/index.vue', import.meta.url));
const adminViewSource = readFileSync(adminViewPath, 'utf8');

function extractConst(source, name) {
  const start = source.indexOf(`const ${name} = `);
  assert.notEqual(start, -1, `${name} not found in the admin view`);
  const next = source.indexOf('\nconst ', start + 1);
  return source.slice(start, next === -1 ? source.length : next);
}

function loadInstallCommand(overrides = {}) {
  const parts = [
    'quotePosixShellArg',
    'quotePowerShellArg',
    'quotePosixDoubleShellArg',
    'buildGhRawUrl',
    'buildInstallAsCfsmCommand',
    'resolveInstallSecret',
    'getCustomInstallCommand'
  ].map(name => extractConst(adminViewSource, name));

  const deps = {
    trans: { value: new Proxy({}, { get: () => 'x' }) },
    copyServerId: { value: SERVER_A },
    selectedApiBase: { value: 'https://panel.example' },
    autoUpdate: { value: false },
    installGhProxy: { value: '' },
    installVersion: { value: '' },
    targetOs: { value: 'linux' },
    installMode: { value: 'current-user' },
    apiSecret: { value: '' },
    sharedApiSecret: { value: '' },
    agentTokenSecrets: { value: {} },
    agentTokenStatus: { value: {} },
    installSecretTargetId: { value: '' },
    resolveAgentInstallSecret,
    ...overrides
  };

  const factory = new Function(
    ...Object.keys(deps),
    `${parts.join('\n')}\nreturn { getCustomInstallCommand, resolveInstallSecret };`
  );
  return factory(...Object.values(deps));
}

test('the install command of a server with a token carries that token and not the shared secret', () => {
  const nodeToken = 'cfsat_node_token_value';
  const { getCustomInstallCommand, resolveInstallSecret } = loadInstallCommand({
    apiSecret: { value: '' },
    sharedApiSecret: { value: SHARED_SECRET },
    agentTokenSecrets: { value: { [SERVER_A]: nodeToken } },
    agentTokenStatus: { value: { [SERVER_A]: { has_token: true } } },
    installSecretTargetId: { value: SERVER_A },
    copyServerId: { value: SERVER_A }
  });

  resolveInstallSecret();
  const command = getCustomInstallCommand();

  assert.ok(command.length > 0);
  assert.ok(command.includes(nodeToken), 'the install command must carry the node token');
  assert.equal(command.includes(SHARED_SECRET), false, 'the install command must not carry the shared secret');
});

test('the install command of a server without a token still carries the shared secret', () => {
  const { getCustomInstallCommand, resolveInstallSecret } = loadInstallCommand({
    apiSecret: { value: '' },
    sharedApiSecret: { value: SHARED_SECRET },
    agentTokenSecrets: { value: {} },
    agentTokenStatus: { value: {} },
    installSecretTargetId: { value: SERVER_A },
    copyServerId: { value: SERVER_A }
  });

  resolveInstallSecret();
  const command = getCustomInstallCommand();

  assert.ok(command.length > 0);
  assert.ok(command.includes(SHARED_SECRET));
});

test('the install command is never generated with an empty secret', () => {
  const { getCustomInstallCommand, resolveInstallSecret } = loadInstallCommand({
    apiSecret: { value: '' },
    sharedApiSecret: { value: SHARED_SECRET },
    agentTokenSecrets: { value: {} },
    // 服务器有令牌，但明文取不回来：只能拒绝生成命令。
    agentTokenStatus: { value: { [SERVER_A]: { has_token: true } } },
    installSecretTargetId: { value: SERVER_A },
    copyServerId: { value: SERVER_A }
  });

  resolveInstallSecret();
  const command = getCustomInstallCommand();

  assert.equal(command, '');
  assert.equal(command.includes('-secret='), false);
});

test('the install command of every platform carries the node token', () => {
  for (const targetOs of ['linux', 'windows', 'docker']) {
    const nodeToken = 'cfsat_node_token_value';
    const { getCustomInstallCommand, resolveInstallSecret } = loadInstallCommand({
      apiSecret: { value: '' },
      sharedApiSecret: { value: SHARED_SECRET },
      agentTokenSecrets: { value: { [SERVER_A]: nodeToken } },
      agentTokenStatus: { value: { [SERVER_A]: { has_token: true } } },
      installSecretTargetId: { value: SERVER_A },
      copyServerId: { value: SERVER_A },
      targetOs: { value: targetOs }
    });

    resolveInstallSecret();
    const command = getCustomInstallCommand();

    assert.ok(command.includes(nodeToken), `${targetOs}: the install command must carry the node token`);
    assert.equal(command.includes(SHARED_SECRET), false, `${targetOs}: the shared secret must not leak`);
    assert.equal(command.includes("-secret=''"), false);
    assert.equal(command.includes('SECRET= '), false);
  }
});
