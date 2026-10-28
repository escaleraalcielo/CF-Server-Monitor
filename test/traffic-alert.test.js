import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GB,
  getTrafficUsageBytes,
  normalizePct,
  normalizePctOrNull,
  normalizeTrafficLimitGb
} from '../src/utils/traffic.js';
import {
  BOOT_ID_FIELD,
  INTERFACE_DIGEST_FIELD,
  REBASELINE_REASON_BOOT_ID,
  REBASELINE_REASON_COUNTER_REGRESSION,
  REBASELINE_REASON_INTERFACE_DIGEST,
  REBASELINE_REASON_RESET_DAY,
  loadTrafficBaseline,
  parseTrafficBaseline
} from '../src/utils/trafficBaseline.js';
import { handleUpdate } from '../src/handlers/update.js';
import { clearServerDetailCache } from '../src/utils/cache.js';
import { evaluateTrafficAlert } from '../src/services/notification.js';
import { clearSiteSettingsCache } from '../src/utils/settings.js';

// ---- test doubles -------------------------------------------------------

function makeSiteSettings(overrides = {}) {
  return {
    // 合法 jwt_secret 以跳过 loadSiteSettings 的补写路径
    jwt_secret: 'a'.repeat(64),
    notification_webhook_enabled: 'true',
    notification_webhook_url: 'https://example.com/hook',
    notification_webhook_method: 'POST',
    notification_webhook_format: 'json',
    ...overrides
  };
}

function makeEnv(siteSettings, { changes = 1 } = {}) {
  const writes = [];
  const env = {
    DB: {
      prepare(sql) {
        return {
          _sql: sql,
          bind(...args) { this._args = args; return this; },
          async first() {
            if (sql.includes("key = 'site_options'")) return { value: JSON.stringify(siteSettings) };
            return null;
          },
          async all() { return { results: [] }; },
          async run() {
            writes.push({ sql, args: this._args || [] });
            return { success: true, meta: { changes } };
          }
        };
      }
    }
  };
  return { env, writes };
}

function makeServer(overrides = {}) {
  return {
    id: 'srv-1',
    name: 'Box',
    traffic_limit: '1000',
    traffic_calc_type: 'total',
    // null = 跟随全局阈值（新语义）；显式 0 表示该服务器关闭告警
    traffic_alert_percent: null,
    traffic_alert_state: null,
    ...overrides
  };
}

let fetchCalls = 0;
globalThis.fetch = async () => {
  fetchCalls += 1;
  return { ok: true, async text() { return ''; }, async json() { return {}; } };
};

async function run(server, metrics, siteSettings, opts) {
  clearSiteSettingsCache();
  fetchCalls = 0;
  const { env, writes } = makeEnv(siteSettings, opts);
  const patches = [];
  await evaluateTrafficAlert(env, server, metrics, {
    patchCache: (id, value) => patches.push({ id, value })
  });
  return { writes, patches, fetchCalls };
}

// ---- pure utils ---------------------------------------------------------

test('normalizeTrafficLimitGb / normalizePct 消除格式差异', () => {
  assert.equal(normalizeTrafficLimitGb('1000'), 1000);
  assert.equal(normalizeTrafficLimitGb('1000.00'), 1000);
  assert.equal(normalizeTrafficLimitGb(1000), 1000);
  assert.equal(normalizeTrafficLimitGb(''), 0);
  assert.equal(normalizeTrafficLimitGb('abc'), 0);
  assert.equal(normalizePct('80'), 80);
  assert.equal(normalizePct(150), 100);
  assert.equal(normalizePct(-5), 0);
  assert.equal(normalizePct('x'), 0);
  // 三态：空值 → null（跟随全局），数字含 0 → 夹取整数
  assert.equal(normalizePctOrNull(null), null);
  assert.equal(normalizePctOrNull(undefined), null);
  assert.equal(normalizePctOrNull(''), null);
  assert.equal(normalizePctOrNull('x'), null);
  assert.equal(normalizePctOrNull(0), 0);
  assert.equal(normalizePctOrNull('70'), 70);
  assert.equal(normalizePctOrNull(150), 100);
  assert.equal(normalizePctOrNull(-5), 0);
});

test('getTrafficUsageBytes 与前端算法逐模式对齐', () => {
  const ref = (rxM, txM, calcType) => {
    const rx = parseFloat(rxM) || 0;
    const tx = parseFloat(txM) || 0;
    const t = calcType || 'total';
    if (t === 'dl') return rx;
    if (t === 'ul') return tx;
    if (t === 'max') return Math.max(rx, tx);
    return rx + tx;
  };
  const cases = [['300', '200'], ['0', '999'], ['12.5', '7.5']];
  for (const [rx, tx] of cases) {
    for (const t of ['total', 'ul', 'dl', 'max', undefined]) {
      assert.equal(getTrafficUsageBytes(rx, tx, t), ref(rx, tx, t), `case ${rx}/${tx}/${t}`);
    }
  }
});

// ---- evaluateTrafficAlert ----------------------------------------------

test('未设流量限制：不发送、不写', async () => {
  const { writes, fetchCalls: f } = await run(
    makeServer({ traffic_limit: '' }),
    { net_rx_monthly: 900 * GB, net_tx_monthly: 0 },
    makeSiteSettings({ traffic_alert_threshold: '80' })
  );
  assert.equal(f, 0);
  assert.equal(writes.length, 0);
});

test('未达阈值：不发送、不写', async () => {
  const { writes, fetchCalls: f } = await run(
    makeServer(),
    { net_rx_monthly: 500 * GB, net_tx_monthly: 0 },
    makeSiteSettings({ traffic_alert_threshold: '80' })
  );
  assert.equal(f, 0);
  assert.equal(writes.length, 0);
});

test('首次跨阈值：发一条通知并写入 {u,th,lim}', async () => {
  const used = 820 * GB;
  const { writes, patches, fetchCalls: f } = await run(
    makeServer(),
    { net_rx_monthly: used, net_tx_monthly: 0 },
    makeSiteSettings({ traffic_alert_threshold: '80' })
  );
  assert.equal(f, 1, '应发送一次');
  assert.equal(writes.length, 1);
  assert.match(writes[0].sql, /SET traffic_alert_state = \?/);
  const stored = JSON.parse(writes[0].args[0]);
  assert.equal(stored.u, used);
  assert.equal(stored.th, 80);
  assert.equal(stored.lim, 1000);
  assert.equal(patches.length, 1);
  assert.equal(patches[0].value, writes[0].args[0]);
});

test('同账期已发（th/lim 一致且未回落）：抑制', async () => {
  const used = 820 * GB;
  const state = JSON.stringify({ u: used, th: 80, lim: 1000 });
  const { writes, fetchCalls: f } = await run(
    makeServer({ traffic_alert_state: state }),
    { net_rx_monthly: used, net_tx_monthly: 0 },
    makeSiteSettings({ traffic_alert_threshold: '80' })
  );
  assert.equal(f, 0);
  assert.equal(writes.length, 0);
});

test('阈值变更（th 失配）：重新可发', async () => {
  const used = 820 * GB;
  const state = JSON.stringify({ u: used, th: 70, lim: 1000 });
  const { fetchCalls: f } = await run(
    makeServer({ traffic_alert_state: state }),
    { net_rx_monthly: used, net_tx_monthly: 0 },
    makeSiteSettings({ traffic_alert_threshold: '80' })
  );
  assert.equal(f, 1);
});

test('限额变更（lim 失配）：重新可发', async () => {
  const used = 820 * GB;
  const state = JSON.stringify({ u: used, th: 80, lim: 900 });
  const { fetchCalls: f } = await run(
    makeServer({ traffic_alert_state: state }),
    { net_rx_monthly: used, net_tx_monthly: 0 },
    makeSiteSettings({ traffic_alert_threshold: '80' })
  );
  assert.equal(f, 1);
});

test('回落 < 0.5u：持久清零写且不发送，刷新缓存为 null', async () => {
  const state = JSON.stringify({ u: 820 * GB, th: 80, lim: 1000 });
  const { writes, patches, fetchCalls: f } = await run(
    makeServer({ traffic_alert_state: state }),
    { net_rx_monthly: 100 * GB, net_tx_monthly: 0 },
    makeSiteSettings({ traffic_alert_threshold: '80' })
  );
  assert.equal(f, 0, '回落不应发送');
  assert.equal(writes.length, 1);
  assert.match(writes[0].sql, /SET traffic_alert_state = NULL/);
  assert.equal(patches.length, 1);
  assert.equal(patches[0].value, null);
});

test('逐台阈值优先于全局', async () => {
  const used = 750 * GB; // 75%
  const { fetchCalls: f } = await run(
    makeServer({ traffic_alert_percent: 70 }), // 逐台 70 → 应触发
    { net_rx_monthly: used, net_tx_monthly: 0 },
    makeSiteSettings({ traffic_alert_threshold: '80' }) // 全局 80 不触发
  );
  assert.equal(f, 1);
});

test('逐台留空（null）跟随全局阈值', async () => {
  const used = 820 * GB; // 82% ≥ 全局 80
  const { fetchCalls: f } = await run(
    makeServer({ traffic_alert_percent: null }),
    { net_rx_monthly: used, net_tx_monthly: 0 },
    makeSiteSettings({ traffic_alert_threshold: '80' })
  );
  assert.equal(f, 1);
});

test('逐台显式 0：超过全局阈值也不触发（该服务器关闭告警）', async () => {
  const used = 900 * GB; // 90%
  const { writes, fetchCalls: f } = await run(
    makeServer({ traffic_alert_percent: 0 }),
    { net_rx_monthly: used, net_tx_monthly: 0 },
    makeSiteSettings({ traffic_alert_threshold: '80' })
  );
  assert.equal(f, 0);
  assert.equal(writes.length, 0);
});

test('未配置通知渠道：不发也不写', async () => {
  const { writes, fetchCalls: f } = await run(
    makeServer(),
    { net_rx_monthly: 900 * GB, net_tx_monthly: 0 },
    makeSiteSettings({ traffic_alert_threshold: '80', notification_webhook_enabled: 'false', notification_webhook_url: '' })
  );
  assert.equal(f, 0);
  assert.equal(writes.length, 0);
});

test('meta.changes=0（并发被抢先写）：发送后不刷新缓存', async () => {
  const used = 820 * GB;
  const { patches, fetchCalls: f } = await run(
    makeServer(),
    { net_rx_monthly: used, net_tx_monthly: 0 },
    makeSiteSettings({ traffic_alert_threshold: '80' }),
    { changes: 0 }
  );
  assert.equal(f, 1, '先通知仍会发出');
  assert.equal(patches.length, 0, 'changes=0 不刷缓存');
});

// ---- traffic baseline (ingest + D1 persistence + rebaseline) -----------

const BASELINE_SECRET = 'traffic-baseline-secret';
const BASELINE_SERVER_ID = '33333333-3333-4333-8333-333333333333';

function createBaselineD1({
  serverOverrides = {},
  siteSettings = makeSiteSettings({ traffic_alert_threshold: '80' })
} = {}) {
  const servers = new Map([
    [
      BASELINE_SERVER_ID,
      {
        id: BASELINE_SERVER_ID,
        name: 'node-traffic',
        server_group: 'Default',
        region: 'US',
        traffic_limit: '1000',
        traffic_calc_type: 'total',
        traffic_alert_percent: null,
        traffic_alert_state: null,
        traffic_baseline: null,
        reset_day: 1,
        is_hidden: '0',
        sort_order: 0,
        history_partition_id: 1,
        timestamp: Date.UTC(2026, 2, 1, 0, 0, 0),
        ...serverOverrides
      }
    ]
  ]);
  const settings = new Map([['site_options', JSON.stringify(siteSettings)]]);
  const historyRows = [];

  const normalizeSql = sql => String(sql).replace(/\s+/g, ' ').trim();

  function prepare(sql) {
    const text = normalizeSql(sql);
    const params = [];

    return {
      bind(...values) {
        params.push(...values);
        return this;
      },
      async first() {
        if (/^SELECT \* FROM servers WHERE id = \?$/.test(text)) {
          const row = servers.get(params[0]);
          return row ? { ...row } : null;
        }
        if (/^SELECT value FROM settings WHERE key = \?$/.test(text)) {
          const val = settings.get(params[0]);
          return val === undefined ? null : { value: val };
        }
        if (/^SELECT value FROM settings WHERE key = 'site_options'$/.test(text)) {
          const val = settings.get('site_options');
          return val === undefined ? null : { value: val };
        }
        return null;
      },
      async all() {
        if (/^PRAGMA table_info\(servers\)$/i.test(text)) {
          return {
            results: Object.keys(servers.get(BASELINE_SERVER_ID) || {}).map(name => ({ name }))
          };
        }
        if (/FROM servers/.test(text)) {
          return { results: [...servers.values()].map(r => ({ ...r })) };
        }
        return { results: [] };
      },
      async run() {
        if (/^UPDATE servers SET traffic_baseline = \? WHERE id = \?$/.test(text)) {
          const [serialized, serverId] = params;
          const row = servers.get(serverId);
          if (!row) return { success: true, meta: { changes: 0 } };
          row.traffic_baseline = serialized;
          return { success: true, meta: { changes: 1 } };
        }
        if (/^UPDATE servers SET traffic_alert_state = \? WHERE id = \? AND COALESCE\(traffic_alert_state,''\) = \?$/.test(text)) {
          const [newState, serverId, expectedOld] = params;
          const row = servers.get(serverId);
          if (!row || String(row.traffic_alert_state ?? '') !== String(expectedOld ?? '')) {
            return { success: true, meta: { changes: 0 } };
          }
          row.traffic_alert_state = newState;
          return { success: true, meta: { changes: 1 } };
        }
        if (/^UPDATE servers SET traffic_alert_state = NULL WHERE id = \? AND COALESCE\(traffic_alert_state,''\) = \?$/.test(text)) {
          const [serverId, expectedOld] = params;
          const row = servers.get(serverId);
          if (!row || String(row.traffic_alert_state ?? '') !== String(expectedOld ?? '')) {
            return { success: true, meta: { changes: 0 } };
          }
          row.traffic_alert_state = null;
          return { success: true, meta: { changes: 1 } };
        }
        if (/^INSERT INTO metrics_history/.test(text)) {
          // saveMetricsHistory binds net_rx_monthly and net_tx_monthly as the last two columns
          historyRows.push({
            id: params[0],
            server_id: params[1],
            timestamp: params[2],
            net_rx: params[8],
            net_tx: params[9],
            net_rx_monthly: params.at(-2),
            net_tx_monthly: params.at(-1)
          });
          return { success: true, meta: { changes: 1 } };
        }
        return { success: true, meta: { changes: 1 } };
      }
    };
  }

  return { db: { prepare }, servers, historyRows };
}

async function postUpdateReport(db, metrics, extraTopLevel = {}) {
  const pending = [];
  const ctx = {
    waitUntil(promise) {
      pending.push(Promise.resolve(promise));
    }
  };
  const request = new Request('https://example.com/update', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Secret': BASELINE_SECRET
    },
    body: JSON.stringify({
      id: BASELINE_SERVER_ID,
      metrics,
      ...extraTopLevel
    })
  });
  const response = await handleUpdate(request, { API_SECRET: BASELINE_SECRET, DB: db }, ctx);
  if (pending.length > 0) {
    await pending.at(-1);
  }
  return response;
}

test('normal forward-moving counter sequence accumulates traffic and triggers alert as today', async () => {
  clearServerDetailCache();
  clearSiteSettingsCache();
  fetchCalls = 0;

  const { db, historyRows } = createBaselineD1();
  const baseTs = Date.UTC(2026, 2, 10, 12, 0, 0);

  // Sample 1: initial anchor at 100 GB RX / 50 GB TX
  const r1 = await postUpdateReport(db, {
    timestamp: baseTs,
    net_rx: 100 * GB,
    net_tx: 50 * GB
  });
  assert.equal(r1.status, 200);
  assert.equal(historyRows.at(-1).net_rx_monthly, 0);
  assert.equal(historyRows.at(-1).net_tx_monthly, 0);
  assert.equal(fetchCalls, 0);

  // Sample 2: forward +400 GB RX / +100 GB TX => 500 GB total (< 800 GB threshold)
  await postUpdateReport(db, {
    timestamp: baseTs + 60_000,
    net_rx: 500 * GB,
    net_tx: 150 * GB
  });
  assert.equal(historyRows.at(-1).net_rx_monthly, 400 * GB);
  assert.equal(historyRows.at(-1).net_tx_monthly, 100 * GB);
  assert.equal(fetchCalls, 0);

  // Sample 3: forward +250 GB RX / +100 GB TX => 850 GB total (>= 800 GB threshold)
  await postUpdateReport(db, {
    timestamp: baseTs + 120_000,
    net_rx: 750 * GB,
    net_tx: 250 * GB
  });
  assert.equal(historyRows.at(-1).net_rx_monthly, 650 * GB);
  assert.equal(historyRows.at(-1).net_tx_monthly, 200 * GB);
  assert.equal(fetchCalls, 1, 'should fire threshold alert once');
});

test('counter going backwards (reboot) rebaselines without negative delta or double-counting prior total', async () => {
  clearServerDetailCache();
  clearSiteSettingsCache();
  fetchCalls = 0;

  const { db, historyRows } = createBaselineD1();
  const baseTs = Date.UTC(2026, 2, 10, 12, 0, 0);

  // 1. Anchor at 1000, 500
  await postUpdateReport(db, { timestamp: baseTs, net_rx: 1000, net_tx: 500 });
  // 2. Advance to 2500, 1200 => accumulated 1500 RX, 700 TX
  await postUpdateReport(db, { timestamp: baseTs + 60_000, net_rx: 2500, net_tx: 1200 });
  assert.equal(historyRows.at(-1).net_rx_monthly, 1500);
  assert.equal(historyRows.at(-1).net_tx_monthly, 700);

  // 3. Reboot #1: counters drop to 300, 100
  // Must NOT produce negative delta (-2200) and must NOT wipe 1500/700
  await postUpdateReport(db, { timestamp: baseTs + 120_000, net_rx: 300, net_tx: 100 });
  assert.equal(historyRows.at(-1).net_rx_monthly, 1500);
  assert.equal(historyRows.at(-1).net_tx_monthly, 700);

  // 4. Advance after reboot #1 to 700, 250 => delta is +400 RX, +150 TX => 1900 RX, 850 TX
  await postUpdateReport(db, { timestamp: baseTs + 180_000, net_rx: 700, net_tx: 250 });
  assert.equal(historyRows.at(-1).net_rx_monthly, 1900);
  assert.equal(historyRows.at(-1).net_tx_monthly, 850);

  // 5. Reboot #2 in the same period: counters drop to 50, 20
  // Must NOT count the previous 1500 or 1900 a second time
  await postUpdateReport(db, { timestamp: baseTs + 240_000, net_rx: 50, net_tx: 20 });
  assert.equal(historyRows.at(-1).net_rx_monthly, 1900);
  assert.equal(historyRows.at(-1).net_tx_monthly, 850);

  // 6. Advance after reboot #2 to 150, 70 => +100 RX, +50 TX => 2000 RX, 900 TX
  await postUpdateReport(db, { timestamp: baseTs + 300_000, net_rx: 150, net_tx: 70 });
  assert.equal(historyRows.at(-1).net_rx_monthly, 2000);
  assert.equal(historyRows.at(-1).net_tx_monthly, 900);

  const stored = await loadTrafficBaseline(db, BASELINE_SERVER_ID);
  assert.equal(stored.state.last_rebaseline_reason, REBASELINE_REASON_COUNTER_REGRESSION);
  assert.equal(stored.state.rebaseline_count, 2);
});

test('report carrying a different boot_id rebaselines even when counters did not regress', async () => {
  clearServerDetailCache();
  clearSiteSettingsCache();

  const { db, historyRows } = createBaselineD1();
  const baseTs = Date.UTC(2026, 2, 11, 0, 0, 0);

  await postUpdateReport(db, {
    timestamp: baseTs,
    net_rx: 1000,
    net_tx: 400,
    [BOOT_ID_FIELD]: 'boot-alpha'
  });
  await postUpdateReport(db, {
    timestamp: baseTs + 60_000,
    net_rx: 1600,
    net_tx: 700,
    [BOOT_ID_FIELD]: 'boot-alpha'
  });
  assert.equal(historyRows.at(-1).net_rx_monthly, 600);
  assert.equal(historyRows.at(-1).net_tx_monthly, 300);

  // New boot_id with higher raw counter values (e.g. fast traffic before first post-boot report):
  // must rebaseline at 5000/2000 instead of adding 5000 - 1600 = 3400
  await postUpdateReport(db, {
    timestamp: baseTs + 120_000,
    net_rx: 5000,
    net_tx: 2000,
    [BOOT_ID_FIELD]: 'boot-beta'
  });
  assert.equal(historyRows.at(-1).net_rx_monthly, 600);
  assert.equal(historyRows.at(-1).net_tx_monthly, 300);

  // Subsequent sample on boot-beta counts from 5000/2000
  await postUpdateReport(db, {
    timestamp: baseTs + 180_000,
    net_rx: 5250,
    net_tx: 2100,
    [BOOT_ID_FIELD]: 'boot-beta'
  });
  assert.equal(historyRows.at(-1).net_rx_monthly, 850);
  assert.equal(historyRows.at(-1).net_tx_monthly, 400);

  const stored = await loadTrafficBaseline(db, BASELINE_SERVER_ID);
  assert.equal(stored.state.boot_id, 'boot-beta');
  assert.equal(stored.state.last_rebaseline_reason, REBASELINE_REASON_BOOT_ID);
});

test('report carrying a different interface_digest rebaselines without wiping accumulated traffic', async () => {
  clearServerDetailCache();
  clearSiteSettingsCache();

  const { db, historyRows } = createBaselineD1();
  const baseTs = Date.UTC(2026, 2, 12, 0, 0, 0);

  await postUpdateReport(db, {
    timestamp: baseTs,
    net_rx: 2000,
    net_tx: 1000,
    [INTERFACE_DIGEST_FIELD]: 'eth0:sha256:1111'
  });
  await postUpdateReport(db, {
    timestamp: baseTs + 60_000,
    net_rx: 3200,
    net_tx: 1500,
    [INTERFACE_DIGEST_FIELD]: 'eth0:sha256:1111'
  });
  assert.equal(historyRows.at(-1).net_rx_monthly, 1200);
  assert.equal(historyRows.at(-1).net_tx_monthly, 500);

  // Interface set changes (e.g. docker0/wg0 added or NIC replaced), jumping raw counters to 90000/40000
  await postUpdateReport(db, {
    timestamp: baseTs + 120_000,
    net_rx: 90_000,
    net_tx: 40_000,
    [INTERFACE_DIGEST_FIELD]: 'eth0,wg0:sha256:2222'
  });
  assert.equal(historyRows.at(-1).net_rx_monthly, 1200);
  assert.equal(historyRows.at(-1).net_tx_monthly, 500);

  // Next sample on the new interface set counts from 90000/40000
  await postUpdateReport(db, {
    timestamp: baseTs + 180_000,
    net_rx: 90_300,
    net_tx: 40_120,
    [INTERFACE_DIGEST_FIELD]: 'eth0,wg0:sha256:2222'
  });
  assert.equal(historyRows.at(-1).net_rx_monthly, 1500);
  assert.equal(historyRows.at(-1).net_tx_monthly, 620);

  const stored = await loadTrafficBaseline(db, BASELINE_SERVER_ID);
  assert.equal(stored.state.interface_digest, 'eth0,wg0:sha256:2222');
  assert.equal(stored.state.last_rebaseline_reason, REBASELINE_REASON_INTERFACE_DIGEST);
});

test('reports without boot_id or interface_digest are accepted and fall back to regression detection', async () => {
  clearServerDetailCache();
  clearSiteSettingsCache();

  const { db, historyRows } = createBaselineD1();
  const baseTs = Date.UTC(2026, 2, 13, 0, 0, 0);

  const r1 = await postUpdateReport(db, { timestamp: baseTs, net_rx: 500, net_tx: 200 });
  const r2 = await postUpdateReport(db, { timestamp: baseTs + 60_000, net_rx: 900, net_tx: 350 });
  const r3 = await postUpdateReport(db, { timestamp: baseTs + 120_000, net_rx: 100, net_tx: 40 });
  const r4 = await postUpdateReport(db, { timestamp: baseTs + 180_000, net_rx: 250, net_tx: 90 });

  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200);
  assert.equal(r3.status, 200);
  assert.equal(r4.status, 200);
  assert.equal(historyRows.at(-1).net_rx_monthly, (900 - 500) + (250 - 100));
  assert.equal(historyRows.at(-1).net_tx_monthly, (350 - 200) + (90 - 40));
});

test('baseline is persisted in the D1 server row and survives cache eviction / cold start', async () => {
  clearServerDetailCache();
  clearSiteSettingsCache();

  const { db, servers, historyRows } = createBaselineD1();
  const baseTs = Date.UTC(2026, 2, 14, 0, 0, 0);

  await postUpdateReport(db, {
    timestamp: baseTs,
    net_rx: 10_000,
    net_tx: 4_000,
    boot_id: 'boot-persist-1',
    interface_digest: 'if-persist-1'
  });
  await postUpdateReport(db, {
    timestamp: baseTs + 60_000,
    net_rx: 15_000,
    net_tx: 6_500,
    boot_id: 'boot-persist-1',
    interface_digest: 'if-persist-1'
  });

  // Assert directly against the stored D1 row
  const storedRow = await db.prepare('SELECT * FROM servers WHERE id = ?').bind(BASELINE_SERVER_ID).first();
  assert.ok(storedRow.traffic_baseline, 'traffic_baseline column must be populated in D1');
  const persisted = parseTrafficBaseline(storedRow.traffic_baseline);
  assert.equal(persisted.baseline_rx, 10_000);
  assert.equal(persisted.baseline_tx, 4_000);
  assert.equal(persisted.last_rx, 15_000);
  assert.equal(persisted.last_tx, 6_500);
  assert.equal(persisted.period_rx, 5_000);
  assert.equal(persisted.period_tx, 2_500);
  assert.equal(persisted.boot_id, 'boot-persist-1');
  assert.equal(persisted.interface_digest, 'if-persist-1');

  // Simulate Worker cold start / cache loss and verify fresh read from D1 continues seamlessly
  clearServerDetailCache();
  clearSiteSettingsCache();

  // Mutate the stored D1 row copy to prove the next report reads from D1 rather than an in-memory variable
  servers.set(BASELINE_SERVER_ID, JSON.parse(JSON.stringify(storedRow)));

  await postUpdateReport(db, {
    timestamp: baseTs + 120_000,
    net_rx: 1_000,
    net_tx: 500,
    boot_id: 'boot-persist-2',
    interface_digest: 'if-persist-1'
  });
  await postUpdateReport(db, {
    timestamp: baseTs + 180_000,
    net_rx: 2_200,
    net_tx: 900,
    boot_id: 'boot-persist-2',
    interface_digest: 'if-persist-1'
  });

  assert.equal(historyRows.at(-1).net_rx_monthly, 5_000 + (2_200 - 1_000));
  assert.equal(historyRows.at(-1).net_tx_monthly, 2_500 + (900 - 500));

  const storedAfterReboot = parseTrafficBaseline(
    (await db.prepare('SELECT * FROM servers WHERE id = ?').bind(BASELINE_SERVER_ID).first()).traffic_baseline
  );
  assert.equal(storedAfterReboot.carry_rx, 5_000);
  assert.equal(storedAfterReboot.carry_tx, 2_500);
  assert.equal(storedAfterReboot.baseline_rx, 1_000);
  assert.equal(storedAfterReboot.baseline_tx, 500);
  assert.equal(storedAfterReboot.last_rx, 2_200);
  assert.equal(storedAfterReboot.last_tx, 900);
  assert.equal(storedAfterReboot.period_rx, 6_200);
  assert.equal(storedAfterReboot.period_tx, 2_900);
  assert.equal(storedAfterReboot.boot_id, 'boot-persist-2');
});

test('reset_day behaviour is unchanged for a machine that never reboots', async () => {
  clearServerDetailCache();
  clearSiteSettingsCache();

  const { db, historyRows } = createBaselineD1({
    serverOverrides: { reset_day: 15 }
  });

  // Billing period 1 (2026-02-15 .. 2026-03-15)
  const march10 = Date.UTC(2026, 2, 10, 10, 0, 0);
  const march14 = Date.UTC(2026, 2, 14, 23, 50, 0);
  await postUpdateReport(db, { timestamp: march10, net_rx: 1_000, net_tx: 500 });
  await postUpdateReport(db, { timestamp: march14, net_rx: 4_500, net_tx: 2_000 });
  assert.equal(historyRows.at(-1).net_rx_monthly, 3_500);
  assert.equal(historyRows.at(-1).net_tx_monthly, 1_500);

  // Billing period 2 starts at 2026-03-15 00:00 UTC (machine never rebooted; counters keep climbing)
  const march15 = Date.UTC(2026, 2, 15, 0, 5, 0);
  const march16 = Date.UTC(2026, 2, 16, 12, 0, 0);
  await postUpdateReport(db, { timestamp: march15, net_rx: 5_000, net_tx: 2_200 });
  assert.equal(historyRows.at(-1).net_rx_monthly, 0);
  assert.equal(historyRows.at(-1).net_tx_monthly, 0);

  await postUpdateReport(db, { timestamp: march16, net_rx: 6_200, net_tx: 2_900 });
  assert.equal(historyRows.at(-1).net_rx_monthly, 1_200);
  assert.equal(historyRows.at(-1).net_tx_monthly, 700);

  const stored = await loadTrafficBaseline(db, BASELINE_SERVER_ID);
  assert.equal(stored.state.last_rebaseline_reason, REBASELINE_REASON_RESET_DAY);
  assert.equal(stored.state.period_start, Date.UTC(2026, 2, 15, 0, 0, 0));
});

