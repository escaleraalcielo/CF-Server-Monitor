import { checkAuth, simpleAuthResponse } from '../middleware/auth.js';
import { getDashboardLatencyHistory, getLatestMetrics, getLatestMetricsForAllServers } from '../database/schema.js';
import { getAllServers, getServerDetail } from '../utils/cache.js';
import { mergeMetricsIntoServer, coerceNumericMetricFields } from '../utils/metrics.js';
import { normalizeLongHistoryPoints } from '../utils/settings.js';
import { createSuccessResponse, createBadRequestResponse, createNotFoundResponse } from '../utils/errors.js';
import {
  cacheLatestReportUpdate,
  getLatestReportSampleTimestamp,
  getWorkerLatestReportUpdates
} from '../utils/latestReportCache.js';
import { markFrontendRealtimeActive } from '../utils/realtimeBroadcastGate.js';
import {
  normalizePublicIpFields,
  toPublicServer,
  toPublicLatestReportUpdates
} from '../utils/publicPayload.js';
import {
  DASHBOARD_LATENCY_WINDOW_HOURS,
  DASHBOARD_LATENCY_WINDOW_POINTS,
  DASHBOARD_LATEST_REPORT_ID_CHUNK_SIZE
} from '../utils/config.js';

const PROBE_FIELDS = ['ct', 'cu', 'cm', 'bd', 'node_1', 'node_2', 'node_3', 'node_4'];

// REST 接口中，丢包值为 null 表示该探针没有可用样本；此时隐藏对应的延迟和丢包字段。
export function omitNullLossProbeFields(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
  const result = { ...item };
  for (const field of PROBE_FIELDS) {
    if (result[`loss_${field}`] === null) {
      delete result[`loss_${field}`];
      delete result[`ping_${field}`];
    }
  }
  return result;
}

function createEmptyLatencyWindow() {
  return { ping: [], loss: [] };
}

// 登录会话保持既有响应形状：删除历史上一直删除的三个字段，
// 并把 IP 归一成可达性标志。未登录访客走 publicPayload 的白名单构建。
function withoutPrivateServerFields(server) {
  const item = { ...server };
  delete item.bandwidth;
  delete item.note;
  delete item.auto_update;
  return normalizePublicIpFields(item);
}

function normalizeLatestReportSample(sample) {
  if (!sample || typeof sample !== 'object') return null;
  const data = sample?.data || sample?.payload || sample?.metrics;
  if (!data || typeof data !== 'object') return null;

  const publicData = coerceNumericMetricFields(normalizePublicIpFields({ ...data }, false));
  const ts = sample.ts ?? sample.timestamp;
  return ts === undefined ? { data: publicData } : { ts, data: publicData };
}

function normalizeLatestReportUpdate(update) {
  if (!update || !Array.isArray(update.samples)) return null;

  const samples = update.samples
    .map(normalizeLatestReportSample)
    .filter(Boolean);
  if (samples.length === 0) return null;

  return {
    ...update,
    samples
  };
}

function attachLatencyHistoryToServers(servers, latencyHistory) {
  for (const server of servers || []) {
    const window = latencyHistory?.get(String(server.id)) || createEmptyLatencyWindow();
    server.ping = window.ping;
    server.loss = window.loss;
  }
}

async function getDurableRealtimeState(env, serverIds) {
  const empty = { latestReportUpdates: [] };
  if (!env.METRICS_BROADCASTER || !Array.isArray(serverIds) || serverIds.length === 0) return empty;

  try {
    const id = env.METRICS_BROADCASTER.idFromName('global');
    const stub = env.METRICS_BROADCASTER.get(id);
    const updates = [];

    for (let offset = 0; offset < serverIds.length; offset += DASHBOARD_LATEST_REPORT_ID_CHUNK_SIZE) {
      const chunk = serverIds.slice(offset, offset + DASHBOARD_LATEST_REPORT_ID_CHUNK_SIZE);
      const response = await stub.fetch('http://internal/latest-report-updates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serverIds: chunk })
      });
      if (!response.ok) continue;
      const data = await response.json();
      if (Array.isArray(data?.updates)) updates.push(...data.updates);
    }

    return { latestReportUpdates: updates };
  } catch (e) {
    console.warn('[Dashboard] Failed to read realtime state:', e?.message || e);
    return empty;
  }
}

function mergeLatestReportUpdates(serverIds, durableUpdates, workerUpdates) {
  const merged = new Map();

  for (const update of durableUpdates) {
    if (!update?.serverId || !Array.isArray(update.samples)) continue;
    merged.set(String(update.serverId), update);
  }

  // Worker 缓存后合并：样本更新时取更新的一包；同一包优先使用更准确的 Worker 接收时间。
  for (const update of workerUpdates) {
    if (!update?.serverId || !Array.isArray(update.samples)) continue;
    const serverId = String(update.serverId);
    const existing = merged.get(serverId);
    if (!existing || getLatestReportSampleTimestamp(update) >= getLatestReportSampleTimestamp(existing)) {
      merged.set(serverId, update);
    }
  }

  const now = Date.now();
  return serverIds.map(serverId => merged.get(String(serverId)))
    .filter(Boolean)
    .map(update => normalizeLatestReportUpdate({
      ...update,
      reportAgeMs: Math.max(0, now - Number(update.reportTs || now))
    }))
    .filter(Boolean);
}

async function getRealtimeStateForServers(env, serverIds) {
  const normalizedServerIds = Array.from(new Set(
    (Array.isArray(serverIds) ? serverIds : [])
      .map(serverId => String(serverId || '').trim())
      .filter(Boolean)
  ));
  if (normalizedServerIds.length === 0) {
    return { latestReportUpdates: [] };
  }

  const durableState = await getDurableRealtimeState(env, normalizedServerIds);
  const durableLatestReportUpdates = durableState.latestReportUpdates;

  // DO 命中后反向预热当前 Worker isolate，降低随后 DO 休眠造成的空缓存概率。
  for (const update of durableLatestReportUpdates) {
    cacheLatestReportUpdate(update.serverId, update.samples, update.reportTs);
  }

  return {
    latestReportUpdates: mergeLatestReportUpdates(
      normalizedServerIds,
      durableLatestReportUpdates,
      getWorkerLatestReportUpdates(normalizedServerIds)
    )
  };
}

export async function handleServerAPI(request, env, sys) {
  const isLoggedIn = await checkAuth(request, env, sys);
  
  if (sys.is_public !== 'true' && !isLoggedIn) {
    return simpleAuthResponse();
  }
  markFrontendRealtimeActive();
  
  const url = new URL(request.url);
  const id = url.searchParams.get('id');
  
  if (!id) return createBadRequestResponse('Missing ID');
  
  const server = await getServerDetail(env.DB, id, isLoggedIn);
  if (!server) return createNotFoundResponse('Server not found');
  
  const [latestMetrics, realtimeState] = await Promise.all([
    getLatestMetrics(env.DB, id, server),
    getRealtimeStateForServers(env, [id])
  ]);
  mergeMetricsIntoServer(server, latestMetrics);
  
  // 未登录访客只能拿到白名单视图；登录会话保持既有响应形状。
  const view = isLoggedIn ? withoutPrivateServerFields(server) : toPublicServer(server);
  view.latestReportUpdates = isLoggedIn
    ? realtimeState.latestReportUpdates
    : toPublicLatestReportUpdates(realtimeState.latestReportUpdates);
  view.sysConfig = {
    long_history_points: Number(normalizeLongHistoryPoints(sys.long_history_points))
  };
  
  return createSuccessResponse(omitNullLossProbeFields(view));
}

export async function handleServersAPI(request, env, sys) {
  const isLoggedIn = await checkAuth(request, env, sys);
  
  if (sys.is_public !== 'true' && !isLoggedIn) {
    return simpleAuthResponse();
  }
  markFrontendRealtimeActive();
  
  const results = await getAllServers(env.DB, isLoggedIn);
  const shouldIncludeLatencyHistory = sys.show_three_net_details === 'true';
  
  const serverIds = results.map(server => server.id).filter(Boolean);
  const [latestMetricsMap, realtimeState, latencyHistory] = await Promise.all([
    getLatestMetricsForAllServers(env.DB),
    getRealtimeStateForServers(env, serverIds),
    shouldIncludeLatencyHistory
      ? getDashboardLatencyHistory(env.DB, results)
      : Promise.resolve(new Map())
  ]);
  attachLatencyHistoryToServers(results, latencyHistory);
  
  const now = Date.now();
  let globalOnline = 0;
  let globalSpeedIn = 0, globalSpeedOut = 0, globalNetTx = 0, globalNetRx = 0;
  const regionStats = {};
  
  for (const server of results) {
    const latestMetrics = latestMetricsMap.get(server.id);
    
    let isOnline = false;
    
    if (latestMetrics) {
      isOnline = (now - latestMetrics.timestamp) < 300000;
      mergeMetricsIntoServer(server, latestMetrics);
    }
    
    if (isOnline) {
      globalOnline++;
      globalSpeedIn += parseFloat(server.net_in_speed) || 0;
      globalSpeedOut += parseFloat(server.net_out_speed) || 0;
    }
    
    globalNetRx += parseFloat(server.net_rx || 0);
    globalNetTx += parseFloat(server.net_tx || 0);
    
    let cCode = (server.region || '').toUpperCase();
    if (cCode !== '') {
      regionStats[cCode] = (regionStats[cCode] || 0) + 1;
    }
  }
  
  const globalOffline = results.length - globalOnline;

  // 未登录访客只能拿到白名单视图；登录会话保持既有响应形状。
  const servers = isLoggedIn
    ? results.map(withoutPrivateServerFields)
    : results.map(toPublicServer);
  const latestReportUpdates = isLoggedIn
    ? realtimeState.latestReportUpdates
    : toPublicLatestReportUpdates(realtimeState.latestReportUpdates);

  const data = {
    servers,
    latestReportUpdates,
    stats: {
      total: results.length,
      online: globalOnline,
      offline: globalOffline,
      globalSpeedIn,
      globalSpeedOut,
      globalNetTx,
      globalNetRx
    },
    regionStats,
    sysConfig: {
      show_price: sys.show_price === 'true',
      show_expire: sys.show_expire === 'true',
      show_tf: sys.show_tf === 'true',
      show_three_net_details: sys.show_three_net_details === 'true',
      // Ping node labels are localised client-side; empty means "unset", so the
      // frontend falls back to the active locale instead of a fixed language.
      custom_ct_name: sys.custom_ct_name || '',
      custom_cu_name: sys.custom_cu_name || '',
      custom_cm_name: sys.custom_cm_name || '',
      custom_bd_name: sys.custom_bd_name || '',
      node_1_name: sys.node_1_name || 'Node 1',
      node_2_name: sys.node_2_name || 'Node 2',
      node_3_name: sys.node_3_name || 'Node 3',
      node_4_name: sys.node_4_name || 'Node 4',
      display_mode: sys.display_mode || 'bar',
      latency_window: {
        points: DASHBOARD_LATENCY_WINDOW_POINTS,
        hours: DASHBOARD_LATENCY_WINDOW_HOURS
      }
    }
  };

  return createSuccessResponse(data);
}
