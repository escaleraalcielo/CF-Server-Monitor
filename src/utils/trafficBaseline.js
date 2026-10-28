/**
 * 服务端流量基线（Traffic Baseline）
 *
 * 背景：
 * Agent 上报的 `net_rx` / `net_tx` 是内核网卡自启动或接口创建以来的单调累加字节计数。
 * 若服务端只按 `reset_day`（账期重置日）重置基线，当机器重启、容器重建、网卡热插拔或
 * 接口集合变更时，底层计数器身份已经改变：
 *   1) 计数器回退（新读数 < 上次读数）若直接相减会产生负增量，若整段清零则会丢掉当期已累计流量；
 *   2) 计数器重建后若碰巧高于旧值（例如新增了一张已有历史流量的网卡，或上次基线很低时重启），
 *      仅靠回退检测无法识别，会把新计数器的存量差值误算进当期流量。
 *
 * 设计约定：
 * 1) 零 Agent 改动即可工作（回退检测）：
 *    只要新上报的 `net_rx < last_rx` 或 `net_tx < last_tx`，立即判定计数器已重置并重设基线（rebaseline）。
 * 2) 前向兼容可选身份字段：
 *    - `boot_id`：内核启动标识（如 `/proc/sys/kernel/random/boot_id`）
 *    - `interface_digest`：接口集合摘要（同时兼容别名 `if_digest`、`iface_digest`、`interfaces_digest`）
 *    当任一字段出现且与已存基线中的非空值不同，立即触发重设基线；字段缺省时不报错，自动退回回退检测。
 * 3) 重设基线（rebaseline）≠ 清空当期累计流量：
 *    重设基线前，先把当前计数周期内已累计的增量折算进 `carry_rx` / `carry_tx`，
 *    再将 `baseline_rx` / `baseline_tx` 与 `last_rx` / `last_tx` 锚定到当前读数（“从这里重新开始计”）。
 *    只有跨过 `reset_day` 进入新账期时，才会将 `carry_rx` / `carry_tx` 归零。
 * 4) 持久化在 D1（`servers.traffic_baseline` 列）：
 *    状态落盘在 D1 的 `servers` 行上，Durable Object 重启或 Worker 冷启动后重新读取仍可恢复。
 */

export const BOOT_ID_FIELD = 'boot_id';
export const INTERFACE_DIGEST_FIELD = 'interface_digest';
export const INTERFACE_DIGEST_ALIASES = Object.freeze([
  'interface_digest',
  'if_digest',
  'iface_digest',
  'interfaces_digest',
  'interfaceDigest',
  'ifDigest'
]);

export const REBASELINE_REASON_INITIAL = 'initial';
export const REBASELINE_REASON_RESET_DAY = 'reset_day';
export const REBASELINE_REASON_COUNTER_REGRESSION = 'counter_regression';
export const REBASELINE_REASON_BOOT_ID = 'boot_id_changed';
export const REBASELINE_REASON_INTERFACE_DIGEST = 'interface_digest_changed';

const TRAFFIC_BASELINE_APPLIED = Symbol.for('cfsm.trafficBaselineApplied');

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function toFiniteNonNegativeNumber(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') {
    return null;
  }
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) return null;
  return num;
}

function toFiniteNumberOrZero(value) {
  const num = toFiniteNonNegativeNumber(value);
  return num === null ? 0 : num;
}

function normalizeIdentityToken(value) {
  if (typeof value === 'string') {
    return value.trim();
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return '';
}

/**
 * 归一化账期重置日（0 表示不按月重置，1..31 表示每月 UTC 重置日）。
 */
export function normalizeBaselineResetDay(value, fallback = 1) {
  if (value === null || value === undefined || value === '') return fallback;
  const parsed = Number.parseInt(String(value).trim(), 10);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 31) return fallback;
  return parsed;
}

function normalizeSampleTimestampMs(timestamp, now = Date.now()) {
  const numeric = Number(timestamp);
  if (!Number.isFinite(numeric) || numeric <= 0) return now;
  // 兼容秒级与毫秒级时间戳
  return numeric < 1e11 ? Math.trunc(numeric * 1000) : Math.trunc(numeric);
}

function getClampedMonthResetUtcMs(year, monthIndex, resetDay) {
  const daysInMonth = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  const actualDay = Math.min(Math.max(1, resetDay), daysInMonth);
  return Date.UTC(year, monthIndex, actualDay, 0, 0, 0, 0);
}

/**
 * 计算给定时间点所属账期的起始毫秒时间戳（UTC）。
 * 当 `resetDay === 0` 时返回 `0`（不启用按日重置）。
 */
export function computeBillingPeriodStart(timestampMs = Date.now(), resetDay = 1) {
  const normalizedResetDay = normalizeBaselineResetDay(resetDay, 1);
  if (normalizedResetDay === 0) return 0;

  const ts = normalizeSampleTimestampMs(timestampMs);
  const date = new Date(ts);
  const year = date.getUTCFullYear();
  const monthIndex = date.getUTCMonth();

  const currentMonthStart = getClampedMonthResetUtcMs(year, monthIndex, normalizedResetDay);
  if (ts >= currentMonthStart) {
    return currentMonthStart;
  }

  const prevMonthDate = new Date(Date.UTC(year, monthIndex, 0));
  return getClampedMonthResetUtcMs(
    prevMonthDate.getUTCFullYear(),
    prevMonthDate.getUTCMonth(),
    normalizedResetDay
  );
}

/**
 * 从样本或顶层上报载荷中提取可选的 `boot_id`。缺省时返回空字符串。
 */
export function extractBootId(sampleOrMetrics = null, reportData = null) {
  const sources = [
    sampleOrMetrics?.metrics,
    sampleOrMetrics,
    reportData?.metrics,
    reportData
  ];
  for (const source of sources) {
    if (!isPlainObject(source)) continue;
    const candidate = source[BOOT_ID_FIELD] ?? source.bootId;
    const normalized = normalizeIdentityToken(candidate);
    if (normalized) return normalized;
  }
  return '';
}

/**
 * 从样本或顶层上报载荷中提取可选的接口集合摘要（主字段名 `interface_digest`，兼容 `if_digest` 等别名）。
 * 缺省时返回空字符串。
 */
export function extractInterfaceDigest(sampleOrMetrics = null, reportData = null) {
  const sources = [
    sampleOrMetrics?.metrics,
    sampleOrMetrics,
    reportData?.metrics,
    reportData
  ];
  for (const source of sources) {
    if (!isPlainObject(source)) continue;
    for (const field of INTERFACE_DIGEST_ALIASES) {
      const normalized = normalizeIdentityToken(source[field]);
      if (normalized) return normalized;
    }
  }
  return '';
}

/**
 * 判断指标对象是否包含原始累计流量计数器（`net_rx` 或 `net_tx`）。
 */
export function hasRawTrafficCounters(metrics) {
  if (!isPlainObject(metrics)) return false;
  return (
    toFiniteNonNegativeNumber(metrics.net_rx) !== null ||
    toFiniteNonNegativeNumber(metrics.net_tx) !== null
  );
}

export function markTrafficBaselineApplied(metrics) {
  if (!isPlainObject(metrics)) return metrics;
  try {
    Object.defineProperty(metrics, TRAFFIC_BASELINE_APPLIED, {
      value: true,
      enumerable: false,
      configurable: true,
      writable: true
    });
  } catch (_) {
    // 冻结对象忽略标记
  }
  return metrics;
}

export function isTrafficBaselineApplied(metrics) {
  return Boolean(isPlainObject(metrics) && metrics[TRAFFIC_BASELINE_APPLIED] === true);
}

/**
 * 解析存储在 D1 `servers.traffic_baseline` 中的 JSON 状态。
 */
export function parseTrafficBaseline(raw) {
  if (!raw) return null;
  let parsed = raw;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    try {
      parsed = JSON.parse(trimmed);
    } catch (_) {
      return null;
    }
  }
  if (!isPlainObject(parsed)) return null;

  const baselineRx = toFiniteNonNegativeNumber(parsed.baseline_rx ?? parsed.rx_baseline);
  const baselineTx = toFiniteNonNegativeNumber(parsed.baseline_tx ?? parsed.tx_baseline);
  const lastRx = toFiniteNonNegativeNumber(parsed.last_rx ?? parsed.rx_prev ?? baselineRx);
  const lastTx = toFiniteNonNegativeNumber(parsed.last_tx ?? parsed.tx_prev ?? baselineTx);

  if (baselineRx === null || baselineTx === null || lastRx === null || lastTx === null) {
    return null;
  }

  const carryRx = toFiniteNumberOrZero(parsed.carry_rx);
  const carryTx = toFiniteNumberOrZero(parsed.carry_tx);
  const epochRx = Math.max(0, lastRx - baselineRx);
  const epochTx = Math.max(0, lastTx - baselineTx);
  const periodRx = toFiniteNonNegativeNumber(parsed.period_rx) ?? (carryRx + epochRx);
  const periodTx = toFiniteNonNegativeNumber(parsed.period_tx) ?? (carryTx + epochTx);

  return {
    baseline_rx: baselineRx,
    baseline_tx: baselineTx,
    last_rx: lastRx,
    last_tx: lastTx,
    carry_rx: carryRx,
    carry_tx: carryTx,
    period_rx: periodRx,
    period_tx: periodTx,
    period_start: toFiniteNumberOrZero(parsed.period_start),
    reset_day: normalizeBaselineResetDay(parsed.reset_day, 1),
    boot_id: normalizeIdentityToken(parsed.boot_id),
    interface_digest: normalizeIdentityToken(parsed.interface_digest ?? parsed.if_digest),
    updated_at: toFiniteNumberOrZero(parsed.updated_at),
    rebaseline_count: toFiniteNumberOrZero(parsed.rebaseline_count),
    last_rebaseline_reason: typeof parsed.last_rebaseline_reason === 'string'
      ? parsed.last_rebaseline_reason
      : ''
  };
}

export function serializeTrafficBaseline(state) {
  const normalized = parseTrafficBaseline(state);
  if (!normalized) return null;
  return JSON.stringify(normalized);
}

function applySignedCorrection(value, correction) {
  const numericCorrection = Number(correction || 0);
  if (!Number.isFinite(numericCorrection) || numericCorrection === 0) {
    return Math.max(0, value);
  }
  return Math.max(0, value + numericCorrection);
}

/**
 * 根据上一状态与新上报样本推进一次流量基线状态机。
 *
 * 规则：
 * - 初次建基线：`baseline = last = current`；若上报同时带了正的 `net_rx_monthly` / `net_tx_monthly`，
 *   将其作为初始 `carry`，保证存量 Agent 平滑接管。
 * - 跨 `reset_day` 新账期：`carry = 0`，`baseline = last = current`，当期累计归零并从当前读数起算。
 * - 同一账期内发生计数器身份变化（`boot_id` 变化、`interface_digest` 变化、或 `current < last` 回退）：
 *   先将已累计流量 `carry + max(0, last - baseline)` 折入新的 `carry`，再令 `baseline = last = current`。
 *   当期累计流量不归零、不出现负增量、也不会把之前的总计数再算一遍。
 * - 正常单调递增：`last = current`，当期流量为 `carry + (current - baseline)`。
 */
export function stepTrafficBaseline(prevState, input = {}) {
  const prior = parseTrafficBaseline(prevState);
  const now = normalizeSampleTimestampMs(input.timestamp);
  const resetDay = normalizeBaselineResetDay(
    input.reset_day ?? prior?.reset_day,
    1
  );
  const periodStart = computeBillingPeriodStart(now, resetDay);

  const rawRx = toFiniteNonNegativeNumber(input.net_rx);
  const rawTx = toFiniteNonNegativeNumber(input.net_tx);
  const currentRx = rawRx !== null ? rawRx : (prior ? prior.last_rx : 0);
  const currentTx = rawTx !== null ? rawTx : (prior ? prior.last_tx : 0);

  const incomingBootId = extractBootId(input, input.reportData);
  const incomingInterfaceDigest = extractInterfaceDigest(input, input.reportData);

  // 1. 尚无基线：锚定当前计数器
  if (!prior) {
    const seedRx = toFiniteNumberOrZero(input.net_rx_monthly);
    const seedTx = toFiniteNumberOrZero(input.net_tx_monthly);
    const carryRx = applySignedCorrection(seedRx, input.rx_correction);
    const carryTx = applySignedCorrection(seedTx, input.tx_correction);

    const state = {
      baseline_rx: currentRx,
      baseline_tx: currentTx,
      last_rx: currentRx,
      last_tx: currentTx,
      carry_rx: carryRx,
      carry_tx: carryTx,
      period_rx: carryRx,
      period_tx: carryTx,
      period_start: periodStart,
      reset_day: resetDay,
      boot_id: incomingBootId,
      interface_digest: incomingInterfaceDigest,
      updated_at: now,
      rebaseline_count: 0,
      last_rebaseline_reason: REBASELINE_REASON_INITIAL
    };

    return {
      state,
      net_rx_monthly: state.period_rx,
      net_tx_monthly: state.period_tx,
      rebaselined: false,
      period_reset: false,
      reason: REBASELINE_REASON_INITIAL
    };
  }

  // 2. 检查是否跨过 reset_day 进入新账期
  const crossedBillingPeriod =
    resetDay > 0 &&
    prior.period_start > 0 &&
    periodStart > prior.period_start;

  if (crossedBillingPeriod) {
    const carryRx = applySignedCorrection(0, input.rx_correction);
    const carryTx = applySignedCorrection(0, input.tx_correction);
    const state = {
      baseline_rx: currentRx,
      baseline_tx: currentTx,
      last_rx: currentRx,
      last_tx: currentTx,
      carry_rx: carryRx,
      carry_tx: carryTx,
      period_rx: carryRx,
      period_tx: carryTx,
      period_start: periodStart,
      reset_day: resetDay,
      boot_id: incomingBootId || prior.boot_id,
      interface_digest: incomingInterfaceDigest || prior.interface_digest,
      updated_at: now,
      rebaseline_count: prior.rebaseline_count,
      last_rebaseline_reason: REBASELINE_REASON_RESET_DAY
    };

    return {
      state,
      net_rx_monthly: state.period_rx,
      net_tx_monthly: state.period_tx,
      rebaselined: true,
      period_reset: true,
      reason: REBASELINE_REASON_RESET_DAY
    };
  }

  // 3. 同一账期内检测计数器身份变更（boot_id 改变 / interface_digest 改变 / 计数器回退）
  const bootIdChanged = Boolean(prior.boot_id) && Boolean(incomingBootId) && prior.boot_id !== incomingBootId;
  const interfaceDigestChanged =
    Boolean(prior.interface_digest) &&
    Boolean(incomingInterfaceDigest) &&
    prior.interface_digest !== incomingInterfaceDigest;
  const counterRegressed = currentRx < prior.last_rx || currentTx < prior.last_tx;

  const accumulatedRxBeforeStep = Math.max(
    0,
    prior.carry_rx + Math.max(0, prior.last_rx - prior.baseline_rx)
  );
  const accumulatedTxBeforeStep = Math.max(
    0,
    prior.carry_tx + Math.max(0, prior.last_tx - prior.baseline_tx)
  );

  if (bootIdChanged || interfaceDigestChanged || counterRegressed) {
    const reason = bootIdChanged
      ? REBASELINE_REASON_BOOT_ID
      : (interfaceDigestChanged ? REBASELINE_REASON_INTERFACE_DIGEST : REBASELINE_REASON_COUNTER_REGRESSION);

    const carryRx = applySignedCorrection(accumulatedRxBeforeStep, input.rx_correction);
    const carryTx = applySignedCorrection(accumulatedTxBeforeStep, input.tx_correction);

    const state = {
      baseline_rx: currentRx,
      baseline_tx: currentTx,
      last_rx: currentRx,
      last_tx: currentTx,
      carry_rx: carryRx,
      carry_tx: carryTx,
      period_rx: carryRx,
      period_tx: carryTx,
      period_start: periodStart || prior.period_start,
      reset_day: resetDay,
      boot_id: incomingBootId || prior.boot_id,
      interface_digest: incomingInterfaceDigest || prior.interface_digest,
      updated_at: now,
      rebaseline_count: prior.rebaseline_count + 1,
      last_rebaseline_reason: reason
    };

    return {
      state,
      net_rx_monthly: state.period_rx,
      net_tx_monthly: state.period_tx,
      rebaselined: true,
      period_reset: false,
      reason
    };
  }

  // 4. 正常单调递增
  const carryRx = applySignedCorrection(prior.carry_rx, input.rx_correction);
  const carryTx = applySignedCorrection(prior.carry_tx, input.tx_correction);
  const periodRx = Math.max(0, carryRx + (currentRx - prior.baseline_rx));
  const periodTx = Math.max(0, carryTx + (currentTx - prior.baseline_tx));

  const state = {
    baseline_rx: prior.baseline_rx,
    baseline_tx: prior.baseline_tx,
    last_rx: currentRx,
    last_tx: currentTx,
    carry_rx: carryRx,
    carry_tx: carryTx,
    period_rx: periodRx,
    period_tx: periodTx,
    period_start: periodStart || prior.period_start,
    reset_day: resetDay,
    boot_id: incomingBootId || prior.boot_id,
    interface_digest: incomingInterfaceDigest || prior.interface_digest,
    updated_at: now,
    rebaseline_count: prior.rebaseline_count,
    last_rebaseline_reason: prior.last_rebaseline_reason
  };

  return {
    state,
    net_rx_monthly: state.period_rx,
    net_tx_monthly: state.period_tx,
    rebaselined: false,
    period_reset: false,
    reason: ''
  };
}

function isMissingTrafficBaselineColumnError(error) {
  return /no such column:\s*traffic_baseline/i.test(String(error?.message || error || ''));
}

/**
 * 从 D1 `servers` 行读取指定服务器的流量基线。
 */
export async function loadTrafficBaseline(db, serverId, fallbackServer = null) {
  let row = null;
  if (db && typeof db.prepare === 'function' && serverId) {
    try {
      row = await db.prepare('SELECT * FROM servers WHERE id = ?').bind(serverId).first();
    } catch (_) {
      row = null;
    }
  }

  const effectiveRow = row || fallbackServer || null;
  const rawBaseline = effectiveRow?.traffic_baseline ?? fallbackServer?.traffic_baseline ?? null;
  const resetDay = normalizeBaselineResetDay(
    effectiveRow?.reset_day ?? fallbackServer?.reset_day,
    1
  );

  return {
    state: parseTrafficBaseline(rawBaseline),
    reset_day: resetDay,
    row: effectiveRow
  };
}

/**
 * 将流量基线写入 D1 `servers.traffic_baseline` 列。
 */
export async function saveTrafficBaseline(db, serverId, state, hooks = {}) {
  const serialized = typeof state === 'string' ? state : serializeTrafficBaseline(state);
  if (!serialized || !db || typeof db.prepare !== 'function' || !serverId) {
    return serialized;
  }

  const runUpdate = () =>
    db.prepare('UPDATE servers SET traffic_baseline = ? WHERE id = ?')
      .bind(serialized, serverId)
      .run();

  try {
    await runUpdate();
  } catch (error) {
    if (isMissingTrafficBaselineColumnError(error)) {
      try {
        await db.prepare('ALTER TABLE servers ADD COLUMN traffic_baseline TEXT DEFAULT NULL').run();
        await runUpdate();
      } catch (retryError) {
        console.warn('[TrafficBaseline] 自动补列并写入基线失败:', retryError?.message || retryError);
      }
    } else {
      console.warn('[TrafficBaseline] 写入流量基线失败:', error?.message || error);
    }
  }

  if (typeof hooks?.patchCache === 'function') {
    hooks.patchCache(serverId, serialized);
  }
  return serialized;
}

/**
 * 在上报链路中对一批已排序样本应用并持久化流量基线，原地更新样本的
 * `net_rx_monthly` / `net_tx_monthly` 字段。
 */
export async function reconcileServerTrafficBaseline(
  db,
  server,
  samples = [],
  reportData = null,
  options = {}
) {
  const sampleList = Array.isArray(samples) ? samples : [];
  const serverId = server?.id || reportData?.id || '';
  const hasAnyRawCounters = sampleList.some(sample => hasRawTrafficCounters(sample?.metrics || sample));

  if (!hasAnyRawCounters) {
    return {
      state: parseTrafficBaseline(server?.traffic_baseline),
      samples: sampleList,
      net_rx_monthly: null,
      net_tx_monthly: null,
      rebaselined: false,
      period_reset: false,
      reason: ''
    };
  }

  const loaded = await loadTrafficBaseline(db, serverId, server);
  let currentState = loaded.state;
  const resetDay = normalizeBaselineResetDay(
    server?.reset_day ?? loaded.reset_day,
    1
  );

  let lastStep = null;
  let anyRebaselined = false;
  let anyPeriodReset = false;
  let lastReason = '';
  let correctionApplied = false;

  for (const sample of sampleList) {
    const metrics = isPlainObject(sample?.metrics) ? sample.metrics : (isPlainObject(sample) ? sample : null);
    if (!metrics || !hasRawTrafficCounters(metrics)) continue;

    const sampleTs = sample?.ts ?? sample?.timestamp ?? metrics.timestamp ?? Date.now();
    const stepResult = stepTrafficBaseline(currentState, {
      net_rx: metrics.net_rx,
      net_tx: metrics.net_tx,
      net_rx_monthly: metrics.net_rx_monthly,
      net_tx_monthly: metrics.net_tx_monthly,
      boot_id: extractBootId(sample, reportData),
      interface_digest: extractInterfaceDigest(sample, reportData),
      timestamp: sampleTs,
      reset_day: resetDay,
      rx_correction: !correctionApplied ? (options.rxCorrection || 0) : 0,
      tx_correction: !correctionApplied ? (options.txCorrection || 0) : 0,
      reportData
    });

    correctionApplied = true;
    currentState = stepResult.state;
    lastStep = stepResult;
    if (stepResult.rebaselined) {
      anyRebaselined = true;
      lastReason = stepResult.reason;
    }
    if (stepResult.period_reset) {
      anyPeriodReset = true;
    }

    metrics.net_rx_monthly = stepResult.net_rx_monthly;
    metrics.net_tx_monthly = stepResult.net_tx_monthly;
    markTrafficBaselineApplied(metrics);
  }

  if (currentState && serverId) {
    const serialized = await saveTrafficBaseline(db, serverId, currentState, {
      patchCache: options.patchCache
    });
    if (isPlainObject(server) && serialized) {
      server.traffic_baseline = serialized;
    }
  }

  return {
    state: currentState,
    samples: sampleList,
    net_rx_monthly: lastStep ? lastStep.net_rx_monthly : null,
    net_tx_monthly: lastStep ? lastStep.net_tx_monthly : null,
    rebaselined: anyRebaselined,
    period_reset: anyPeriodReset,
    reason: lastReason
  };
}
