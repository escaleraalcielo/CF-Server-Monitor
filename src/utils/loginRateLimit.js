/**
 * 登录失败限速（进程内计数 + 指数退避）。
 *
 * Worker isolate 的内存状态不是全局一致的，但即便如此，它也能显著抬高
 * 暴力破解成本：攻击者必须命中同一个 isolate 才能累积失败次数。
 * 真正的纵深防御仍然是 Cloudflare Access / WAF 速率限制。
 */

const DEFAULT_WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_MAX_FAILURES = 5;
const DEFAULT_BASE_DELAY_MS = 1000;
const DEFAULT_MAX_DELAY_MS = 30000;

// key -> { count, firstFailureAt, blockedUntil, lastSeenAt }
const attempts = new Map();

function getClientKey(request) {
  const headers = request?.headers;
  if (!headers) return 'unknown';

  const cfConnectingIp = headers.get('CF-Connecting-IP');
  if (cfConnectingIp) return cfConnectingIp;

  const realIp = headers.get('X-Real-IP');
  if (realIp) return realIp;

  return 'unknown';
}

function pruneExpired(now) {
  for (const [key, state] of attempts) {
    if (now - state.lastSeenAt > DEFAULT_WINDOW_MS * 4) {
      attempts.delete(key);
    }
  }
}

/**
 * 记录一次登录失败，并在达到阈值后对该客户端施加退避。
 * @param {Request} request
 * @returns {number} 需要等待的毫秒数；0 表示可以继续尝试
 */
export function registerLoginFailure(request) {
  const now = Date.now();
  const key = getClientKey(request);

  pruneExpired(now);

  const state = attempts.get(key) || { count: 0, firstFailureAt: now, blockedUntil: 0, lastSeenAt: now };

  if (now - state.firstFailureAt > DEFAULT_WINDOW_MS) {
    state.count = 0;
    state.firstFailureAt = now;
  }

  state.count += 1;
  state.lastSeenAt = now;

  if (state.count >= DEFAULT_MAX_FAILURES) {
    const overage = state.count - DEFAULT_MAX_FAILURES;
    const delay = Math.min(DEFAULT_BASE_DELAY_MS * (2 ** overage), DEFAULT_MAX_DELAY_MS);
    state.blockedUntil = now + delay;
  }

  attempts.set(key, state);
  return Math.max(0, state.blockedUntil - now);
}

/**
 * 登录成功后清除该客户端的失败记录。
 * @param {Request} request
 */
export function clearLoginFailures(request) {
  const key = getClientKey(request);
  attempts.delete(key);
}

/**
 * 查询当前是否处于退避窗口内。
 * @param {Request} request
 * @returns {number} 剩余毫秒数；0 表示不在退避窗口内
 */
export function getLoginBackoffMs(request) {
  const state = attempts.get(getClientKey(request));
  if (!state) return 0;
  return Math.max(0, state.blockedUntil - Date.now());
}
