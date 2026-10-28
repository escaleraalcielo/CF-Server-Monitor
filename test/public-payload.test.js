import test from 'node:test';
import assert from 'node:assert/strict';
import { handleServerAPI, handleServersAPI } from '../src/handlers/dashboard.js';
import { handleAdminAPI } from '../src/handlers/admin.js';
import { generateToken } from '../src/middleware/auth.js';
import {
  clearServersListCache,
  clearServerDetailCache,
  clearLatestMetricsCache
} from '../src/utils/cache.js';
import { cacheLatestReportUpdate } from '../src/utils/latestReportCache.js';

// 公开响应里允许出现的服务器字段——与 src/utils/publicPayload.js 的白名单一一对应。
// 这里刻意写成字面量：向白名单加字段必须同时改这份期望值，不能悄悄扩大公开面。
const EXPECTED_PUBLIC_KEYS = [
  'arch',
  'boot_time',
  'cpu',
  'cpu_cores',
  'cpu_info',
  'disk',
  'disk_total',
  'disk_used',
  'gpu_info',
  'ip_v4',
  'ip_v6',
  'kernel_version',
  'last_updated',
  'load_avg',
  'loss',
  'loss_bd',
  'loss_cm',
  'loss_cu',
  'loss_ct',
  'loss_node_1',
  'loss_node_2',
  'loss_node_3',
  'loss_node_4',
  'name',
  'net_in_speed',
  'net_out_speed',
  'net_rx',
  'net_rx_monthly',
  'net_tx',
  'net_tx_monthly',
  'os',
  'ping',
  'ping_bd',
  'ping_cm',
  'ping_cu',
  'ping_ct',
  'ping_node_1',
  'ping_node_2',
  'ping_node_3',
  'ping_node_4',
  'processes',
  'ram_total',
  'ram_used',
  'region',
  'server_group',
  'swap_total',
  'swap_used',
  'tcp_conn',
  'traffic_calc_type',
  'traffic_limit',
  'udp_conn'
].sort();

const PUBLIC_ID = '11111111-aaaa-4aaa-8aaa-111111111111';
const HIDDEN_ID = '22222222-bbbb-4bbb-8bbb-222222222222';
// 所有私有字段共用的唯一标记：它出现在响应体的任何位置都算泄漏。
const MARKER = 'canary-marker-9f3a7c1e';
const JWT_SECRET = 'j'.repeat(32);

function buildVisibleRow() {
  return {
    id: PUBLIC_ID,
    name: 'alpha-node',
    server_group: 'Default',
    region: 'us',
    // 私有：note、tags、计费、agent 配置、流量修正
    tags: `tier-one,${MARKER}`,
    note: MARKER,
    price: MARKER,
    currency: MARKER,
    billing_cycle: MARKER,
    auto_renewal: '1',
    expire_date: MARKER,
    traffic_limit: 500,
    traffic_calc_type: 'total',
    traffic_alert_percent: 80,
    traffic_alert_state: MARKER,
    interface: 'eth9',
    reset_day: 3,
    collect_interval: 30,
    report_interval: 60,
    wss_report_interval: 2,
    connection_mode: MARKER,
    ping_mode: MARKER,
    auto_update: '1',
    custom_ct: MARKER,
    custom_cu: 'cn2',
    custom_cm: '',
    custom_bd: '',
    node_1: MARKER,
    node_2: '',
    node_3: '',
    node_4: '',
    rx_correction: 1.5,
    tx_correction: 2.5,
    offline_notify_disabled: '0',
    is_hidden: '0',
    sort_order: 0,
    history_partition_id: 0,
    timestamp: 1730000000000,
    // 历史删除逻辑里的字段 + 未来新增字段：都不在白名单里
    bandwidth: MARKER,
    future_field_added_later: MARKER,
    // 系统信息（公开页展示）
    os: 'Linux',
    arch: 'x64',
    kernel_version: '6.12.0',
    cpu_info: 'Test CPU',
    cpu_cores: 4,
    gpu_info: '',
    // 指标（生产中由 latest metrics 合并；这里作为行字段直接喂给缓存层）
    cpu: 12.5,
    load_avg: '0.50 0.25 0.10',
    ram_total: 8192,
    ram_used: 4096,
    swap_total: 1024,
    swap_used: 0,
    disk_total: 102400,
    disk_used: 51200,
    disk: {
      disk_read_bps: 1000,
      disk_write_bps: 2000,
      disk_read_iops: 10,
      disk_write_iops: 20,
      disk_await_ms: 1.5,
      disk_util: 33
    },
    processes: 120,
    tcp_conn: 45,
    udp_conn: 6,
    net_in_speed: 1048576,
    net_out_speed: 2097152,
    net_rx: 123456789,
    net_tx: 987654321,
    net_rx_monthly: 111111,
    net_tx_monthly: 222222,
    ping_ct: 23,
    ping_cu: 24,
    ping_cm: 25,
    ping_bd: 26,
    loss_ct: 1,
    loss_cu: 0,
    loss_cm: 0,
    loss_bd: 0,
    ping_node_1: 31,
    ping_node_2: 32,
    ping_node_3: 33,
    ping_node_4: 34,
    loss_node_1: 0,
    loss_node_2: 0,
    loss_node_3: 0,
    loss_node_4: 0,
    last_updated: 1730000060000,
    boot_time: '1729990000',
    ping: [1, 2],
    loss: [0, 1],
    ip_v4: '198.51.100.10',
    ip_v6: '0'
  };
}

function buildHiddenRow() {
  return {
    ...buildVisibleRow(),
    id: HIDDEN_ID,
    name: 'hidden-node',
    is_hidden: '1'
  };
}

// 只实现被测路径真正用到的查询；metrics_history 查询不会执行（分区 id 为 0）。
function createDb(rows) {
  return {
    prepare(sql) {
      const text = String(sql).replace(/\s+/g, ' ').trim();
      if (text.startsWith('SELECT * FROM servers ORDER BY sort_order ASC')) {
        return { all: async () => ({ results: rows.map(row => ({ ...row })) }) };
      }
      if (text.startsWith('SELECT * FROM servers WHERE id = ?')) {
        return {
          bind: (id) => ({
            first: async () => {
              const row = rows.find(item => item.id === id);
              return row ? { ...row } : null;
            }
          })
        };
      }
      return {
        all: async () => ({ results: [] }),
        first: async () => null,
        run: async () => ({}),
        bind: () => ({
          all: async () => ({ results: [] }),
          first: async () => null,
          run: async () => ({})
        })
      };
    },
    batch: async () => []
  };
}

function resetCaches() {
  clearServersListCache();
  clearServerDetailCache();
  clearLatestMetricsCache();
}

function publicListRequest() {
  return new Request('https://example.com/api/servers');
}

function publicDetailRequest(id) {
  return new Request(`https://example.com/api/server?id=${encodeURIComponent(id)}`);
}

async function authedRequest(env, path) {
  const token = await generateToken(env, { is_public: 'true', username: 'admin' });
  return new Request(path, { headers: { Authorization: `Bearer ${token}` } });
}

async function adminApiRequest(env, action) {
  const token = await generateToken(env, { is_public: 'true', username: 'admin' });
  return new Request('https://example.com/admin/api', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({ action })
  });
}

test('public responses never contain private row fields (canary)', async () => {
  resetCaches();
  const env = { DB: createDb([buildVisibleRow()]) };
  const sys = { is_public: 'true' };

  const listResponse = await handleServersAPI(publicListRequest(), env, sys);
  assert.equal(listResponse.status, 200);
  const listBody = await listResponse.text();
  assert.ok(!listBody.includes(MARKER), 'list response leaked a private marker');
  assert.ok(!listBody.includes(PUBLIC_ID), 'list response leaked a server id');

  const detailResponse = await handleServerAPI(publicDetailRequest(PUBLIC_ID), env, sys);
  assert.equal(detailResponse.status, 200);
  const detailBody = await detailResponse.text();
  assert.ok(!detailBody.includes(MARKER), 'detail response leaked a private marker');
});

test('fields not on the allowlist never reach the public payload', async () => {
  resetCaches();
  const env = { DB: createDb([buildVisibleRow()]) };
  const sys = { is_public: 'true' };

  const list = await (await handleServersAPI(publicListRequest(), env, sys)).json();
  assert.equal(list.servers.length, 1);
  assert.deepEqual(Object.keys(list.servers[0]).sort(), EXPECTED_PUBLIC_KEYS);
  assert.ok(!('future_field_added_later' in list.servers[0]));
  assert.ok(!('id' in list.servers[0]));

  const detail = await (await handleServerAPI(publicDetailRequest(PUBLIC_ID), env, sys)).json();
  assert.deepEqual(
    Object.keys(detail).sort(),
    [...EXPECTED_PUBLIC_KEYS, 'latestReportUpdates', 'sysConfig'].sort()
  );
});

test('a server marked hidden never appears in a public response', async () => {
  resetCaches();
  const env = { DB: createDb([buildVisibleRow(), buildHiddenRow()]), JWT_SECRET };
  const sys = { is_public: 'true' };

  const list = await (await handleServersAPI(publicListRequest(), env, sys)).json();
  assert.deepEqual(list.servers.map(server => server.name), ['alpha-node']);
  assert.ok(
    !JSON.stringify(list).includes(HIDDEN_ID),
    'hidden server id leaked into the public list'
  );

  const detailResponse = await handleServerAPI(publicDetailRequest(HIDDEN_ID), env, sys);
  assert.equal(detailResponse.status, 404);

  // 管理端登录会话仍能看到隐藏服务器。
  const adminList = await (await handleAdminAPI(
    await adminApiRequest(env, 'list'),
    env,
    sys
  )).json();
  const adminNames = (adminList.servers || []).map(server => server.name);
  assert.ok(adminNames.includes('hidden-node'), 'admin lost sight of the hidden server');
});

test('the public payload keeps the fields a visitor is supposed to see', async () => {
  resetCaches();
  const env = { DB: createDb([buildVisibleRow()]) };
  const sys = { is_public: 'true' };

  const list = await (await handleServersAPI(publicListRequest(), env, sys)).json();
  const server = list.servers[0];
  assert.equal(server.name, 'alpha-node');
  assert.equal(server.region, 'us');
  assert.equal(server.cpu, 12.5);
  assert.equal(server.load_avg, '0.50 0.25 0.10');
  assert.equal(server.ram_total, 8192);
  assert.equal(server.ram_used, 4096);
  assert.equal(server.disk_total, 102400);
  assert.equal(server.disk_used, 51200);
  assert.equal(server.boot_time, '1729990000');
  assert.equal(server.last_updated, 1730000060000);
  assert.equal(server.ping_ct, 23);
  assert.equal(server.loss_ct, 1);
  // 列表接口的 ping/loss 是延迟窗口抽样（show_three_net_details 未开启时为空数组）。
  assert.deepEqual(server.ping, []);
  assert.deepEqual(server.loss, []);
  assert.equal(server.net_in_speed, 1048576);
  assert.equal(server.net_out_speed, 2097152);
  assert.equal(server.traffic_limit, 500);
  // IP 只以可达性形式出现，原始地址不公开。
  assert.equal(server.ip_v4, '1');
  assert.equal(server.ip_v6, '0');
  assert.ok(list.stats && typeof list.stats.total === 'number');
});

test('the authenticated admin responses keep the private fields', async () => {
  resetCaches();
  const env = { DB: createDb([buildVisibleRow()]), JWT_SECRET };
  const sys = { is_public: 'true' };

  // 后台面板自己的数据源（/admin API）返回完整行。
  const adminList = await (await handleAdminAPI(
    await adminApiRequest(env, 'list'),
    env,
    sys
  )).json();
  const adminServer = adminList.servers.find(server => server.id === PUBLIC_ID);
  assert.ok(adminServer, 'admin list lost the server');
  assert.equal(adminServer.note, MARKER);
  assert.equal(adminServer.price, MARKER);
  assert.equal(adminServer.expire_date, MARKER);
  assert.equal(adminServer.connection_mode, MARKER);

  // 仪表盘接口的登录会话保留既有响应形状（白名单只作用于未登录请求）：
  // tags/custom_* 等字段保留，历史上一直删除的 note/bandwidth/auto_update 仍不出现。
  const authedList = await (await handleServersAPI(
    await authedRequest(env, 'https://example.com/api/servers'),
    env,
    sys
  )).json();
  const authedServer = authedList.servers[0];
  assert.equal(authedServer.price, MARKER);
  assert.equal(authedServer.expire_date, MARKER);
  assert.equal(authedServer.connection_mode, MARKER);
  assert.equal(authedServer.tags, `tier-one,${MARKER}`);
  assert.equal(authedServer.custom_ct, MARKER);
  assert.ok(!('note' in authedServer));
  assert.ok(!('bandwidth' in authedServer));
  assert.ok(!('auto_update' in authedServer));

  const authedDetail = await (await handleServerAPI(
    await authedRequest(env, `https://example.com/api/server?id=${PUBLIC_ID}`),
    env,
    sys
  )).json();
  assert.equal(authedDetail.price, MARKER);
  assert.equal(authedDetail.expire_date, MARKER);
  assert.equal(authedDetail.connection_mode, MARKER);
  assert.equal(authedDetail.tags, `tier-one,${MARKER}`);
  assert.equal(authedDetail.custom_ct, MARKER);
  assert.ok(!('note' in authedDetail));
  assert.ok(!('bandwidth' in authedDetail));
  assert.ok(!('auto_update' in authedDetail));
});

test('public realtime updates drop the server id; admin updates keep it', async () => {
  resetCaches();
  const env = { DB: createDb([buildVisibleRow()]), JWT_SECRET };
  const sys = { is_public: 'true' };
  cacheLatestReportUpdate(
    PUBLIC_ID,
    [{ ts: Date.now(), data: { cpu: 42, ip_v4: '203.0.113.9' } }],
    Date.now()
  );

  const publicListResponse = await handleServersAPI(publicListRequest(), env, sys);
  const publicListBody = await publicListResponse.text();
  const publicList = JSON.parse(publicListBody);
  assert.equal(publicList.latestReportUpdates.length, 1);
  assert.ok(!('serverId' in publicList.latestReportUpdates[0]));
  assert.ok(!publicListBody.includes(PUBLIC_ID));
  assert.ok(!publicListBody.includes('203.0.113.9'), 'raw IP leaked through updates');
  assert.equal(publicList.latestReportUpdates[0].samples[0].data.ip_v4, '1');

  const publicDetailBody = await (await handleServerAPI(
    publicDetailRequest(PUBLIC_ID),
    env,
    sys
  )).text();
  const publicDetail = JSON.parse(publicDetailBody);
  assert.equal(publicDetail.latestReportUpdates.length, 1);
  assert.ok(!('serverId' in publicDetail.latestReportUpdates[0]));

  const adminList = await (await handleServersAPI(
    await authedRequest(env, 'https://example.com/api/servers'),
    env,
    sys
  )).json();
  assert.equal(adminList.latestReportUpdates[0].serverId, PUBLIC_ID);
});
