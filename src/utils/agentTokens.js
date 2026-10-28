import { sha256Hex, timingSafeEqualString } from './common.js';

/**
 * 节点令牌（per-node agent token）
 *
 * 背景：所有 Agent 过去共用一个 env.API_SECRET，这个值写在每台被监控机器的
 * config.conf 里，攻破任意一台就能冒充其它所有机器上报。
 *
 * 过渡期方案：上报接口同时接受
 *   1) 共享密钥 env.API_SECRET（已部署的 Agent 只认它，不能拒）
 *   2) 某个节点自己的令牌（只认它自己那台机器）
 * 共享密钥的使用次数会被计数，管理员可以盯着这个计数归零后再退役共享密钥。
 *
 * 安全约定：
 * - 库里只存 SHA-256 摘要，明文只在创建/轮换时返回一次；
 * - 比对一律走 timingSafeEqualString，不做 === / !== 的机密比较；
 * - 令牌只认一台机器：拿 A 的令牌报 B 会被拒。
 */

/** 节点令牌明文前缀：只认这个前缀的凭据走节点令牌通道，其它格式直接拒绝。 */
export const AGENT_TOKEN_PREFIX = 'cfsat_';
/** 随机字节数：32 字节 = 256 bit 熵，base64url 之后 43 个字符。 */
export const AGENT_TOKEN_RANDOM_BYTES = 32;
/** 摘要前缀长度（十六进制字符数），用作按前缀检索的索引桶。 */
export const AGENT_TOKEN_HASH_LOOKUP_LENGTH = 16;
/** 凭据长度上限：超长凭据直接拒绝，避免为它计算摘要。 */
export const MAX_AGENT_CREDENTIAL_LENGTH = 512;
/** 共享密钥使用次数在 settings 表里的 key。 */
export const SHARED_SECRET_USAGE_KEY = 'api_secret_usage';
/** 凭据类型：共享密钥。 */
export const AGENT_CREDENTIAL_SHARED = 'shared';
/** 凭据类型：节点令牌。 */
export const AGENT_CREDENTIAL_NODE = 'node';

/** last_used_at 的最小写入间隔：太频繁的写入对 D1 没有意义。 */
const AGENT_TOKEN_LAST_USED_THROTTLE_MS = 5 * 60 * 1000;

function toBase64Url(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * 生成一个节点令牌明文。调用方负责把它交给管理员一次，之后无法再取回。
 */
export function generateAgentToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(AGENT_TOKEN_RANDOM_BYTES));
  return `${AGENT_TOKEN_PREFIX}${toBase64Url(bytes)}`;
}

/**
 * 计算令牌摘要。库里存摘要，摘要前缀用于索引检索。
 */
export async function hashAgentToken(plaintext) {
  const hash = await sha256Hex(plaintext);
  return { hash, prefix: hash.slice(0, AGENT_TOKEN_HASH_LOOKUP_LENGTH) };
}

function normalizeCredential(value) {
  if (typeof value !== 'string') return '';
  if (!value.trim()) return '';
  if (value.length > MAX_AGENT_CREDENTIAL_LENGTH) return '';
  return value;
}

function isMissingTableError(error) {
  return /no such table/i.test(String(error?.message || error || ''));
}

/**
 * 按摘要前缀取出候选令牌行。前缀只是索引桶，最终是否匹配由常量时间比较决定。
 */
async function findAgentTokensByHashPrefix(db, prefix) {
  try {
    const { results } = await db.prepare(
      'SELECT server_id, token_hash, token_prefix, created_at, last_used_at FROM agent_tokens WHERE token_prefix = ?'
    ).bind(prefix).all();
    return results || [];
  } catch (e) {
    // 存量部署还没建表时按"没有任何节点令牌"处理，不让上报接口 500。
    if (!isMissingTableError(e)) {
      console.warn('[AgentAuth] 读取节点令牌失败:', e?.message || e);
    }
    return [];
  }
}

function touchAgentTokenLastUsed(db, row, ctx) {
  const now = Date.now();
  const lastUsedAt = Number(row?.last_used_at || 0);
  if (Number.isFinite(lastUsedAt) && now - lastUsedAt < AGENT_TOKEN_LAST_USED_THROTTLE_MS) {
    return;
  }

  let pending;
  try {
    pending = db.prepare('UPDATE agent_tokens SET last_used_at = ? WHERE server_id = ?')
      .bind(now, row.server_id)
      .run();
  } catch (_) {
    return;
  }

  const guard = Promise.resolve(pending).catch(() => {});
  if (ctx && typeof ctx.waitUntil === 'function') {
    ctx.waitUntil(guard);
  }
}

/**
 * 共享密钥的使用次数按 UTC 小时分桶。
 * 桶里的计数会随小时归零：管理员看着"本小时次数"归零，就知道共享密钥已经没人用了，
 * 可以退役它。累计次数另外留着，用来对照"到底迁移了多少"。
 */
function getUsageHourKey(timestamp = Date.now()) {
  return new Date(timestamp).toISOString().slice(0, 13);
}

function parseUsageValue(raw) {
  if (raw === null || raw === undefined) return {};
  try {
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    return {};
  }
}

/**
 * 记录一次共享密钥的使用，并返回最新的计数。
 * 计数写在 settings 表的一个独立 key 上，不会混进 site_options。
 */
export async function incrementSharedSecretUsage(db) {
  const now = Date.now();
  const hour = getUsageHourKey(now);
  const initial = JSON.stringify({ total: 1, hour, hour_count: 1, last_used_at: now });
  try {
    // 一条语句完成"读改写"，并发上报也不会丢计数。
    await db.prepare(`
      INSERT INTO settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = json_object(
        'total', COALESCE(json_extract(value, '$.total'), 0) + 1,
        'hour', ?,
        'hour_count', CASE
          WHEN json_extract(value, '$.hour') = ? THEN COALESCE(json_extract(value, '$.hour_count'), 0) + 1
          ELSE 1
        END,
        'last_used_at', ?
      )
    `).bind(SHARED_SECRET_USAGE_KEY, initial, hour, hour, now).run();
    return await getSharedSecretUsage(db);
  } catch (e) {
    console.warn('[AgentAuth] 无法记录共享密钥使用次数:', e?.message || e);
    return null;
  }
}

/**
 * 读取共享密钥的使用计数。
 * @returns {Promise<{count: number, total: number, lastUsedAt: number}>}
 *   count 是本小时的使用次数（小时一过就归零），total 是累计次数。
 */
export async function getSharedSecretUsage(db) {
  try {
    const row = await db.prepare('SELECT value FROM settings WHERE key = ?')
      .bind(SHARED_SECRET_USAGE_KEY)
      .first();
    const usage = parseUsageValue(row?.value);
    const hour = getUsageHourKey();
    const hourCount = Number(usage.hour_count || 0);
    const total = Number(usage.total || 0);
    return {
      count: usage.hour === hour && Number.isFinite(hourCount) ? hourCount : 0,
      total: Number.isFinite(total) ? total : 0,
      lastUsedAt: Number(usage.last_used_at || 0) || 0
    };
  } catch (e) {
    console.warn('[AgentAuth] 无法读取共享密钥使用次数:', e?.message || e);
    return { count: 0, total: 0, lastUsedAt: 0 };
  }
}

/**
 * 校验上报凭据。
 *
 * @param {object} db D1 数据库
 * @param {string} presented 请求头 X-API-Secret 或请求体 secret 里的凭据
 * @param {string} sharedSecret env.API_SECRET
 * @param {{ ctx?: object }} options ctx 用于把 last_used_at 的写入放到后台
 * @returns {Promise<{ok: boolean, kind: string, serverId: string, usageCount: number|null}>}
 *   kind 为 AGENT_CREDENTIAL_SHARED 时 serverId 为空（共享密钥不绑定机器）；
 *   kind 为 AGENT_CREDENTIAL_NODE 时 serverId 是该令牌唯一对应的机器。
 */
export async function authenticateAgentCredential(db, presented, sharedSecret, options = {}) {
  const credential = normalizeCredential(presented);
  if (!credential) {
    return { ok: false, kind: '', serverId: '', usageCount: null };
  }

  // 共享密钥优先：过渡期内已部署的 Agent 只认它，用了就要计数。
  if (typeof sharedSecret === 'string' && sharedSecret.length > 0) {
    if (await timingSafeEqualString(credential, sharedSecret)) {
      const usage = await incrementSharedSecretUsage(db);
      console.info('[AgentAuth] 共享密钥上报，本小时次数:', usage?.count ?? '-', '累计:', usage?.total ?? '-');
      return { ok: true, kind: AGENT_CREDENTIAL_SHARED, serverId: '', usageCount: usage?.count ?? null };
    }
  }

  // 节点令牌：只认固定前缀的格式，其它凭据不查库直接拒绝。
  if (!credential.startsWith(AGENT_TOKEN_PREFIX)) {
    return { ok: false, kind: '', serverId: '', usageCount: null };
  }

  const digest = await sha256Hex(credential);
  const candidates = await findAgentTokensByHashPrefix(
    db,
    digest.slice(0, AGENT_TOKEN_HASH_LOOKUP_LENGTH)
  );

  for (const row of candidates) {
    // 摘要之间的比较必须走常量时间，不能用 === / !==。
    if (!await timingSafeEqualString(digest, row.token_hash)) continue;
    touchAgentTokenLastUsed(db, row, options.ctx);
    return { ok: true, kind: AGENT_CREDENTIAL_NODE, serverId: row.server_id, usageCount: null };
  }

  return { ok: false, kind: '', serverId: '', usageCount: null };
}

/**
 * 读取某个节点的令牌元信息（不含明文，也不含摘要）。
 */
export async function getAgentToken(db, serverId) {
  try {
    const row = await db.prepare(
      'SELECT server_id, token_prefix, created_at, rotated_at, last_used_at FROM agent_tokens WHERE server_id = ?'
    ).bind(serverId).first();
    return row || null;
  } catch (e) {
    if (!isMissingTableError(e)) {
      console.warn('[AgentAuth] 读取节点令牌失败:', e?.message || e);
    }
    return null;
  }
}

/**
 * 列出所有节点的令牌元信息（不含明文，也不含摘要）。
 */
export async function listAgentTokens(db) {
  try {
    const { results } = await db.prepare(
      'SELECT server_id, token_prefix, created_at, rotated_at, last_used_at FROM agent_tokens ORDER BY server_id ASC'
    ).all();
    return results || [];
  } catch (e) {
    if (!isMissingTableError(e)) {
      console.warn('[AgentAuth] 读取节点令牌列表失败:', e?.message || e);
    }
    return [];
  }
}

/**
 * 为某个节点创建（或覆盖）令牌，返回明文一次。
 * 调用方负责在响应里把明文交给管理员，之后库里只剩摘要。
 */
export async function createAgentToken(db, serverId) {
  const plaintext = generateAgentToken();
  const { hash, prefix } = await hashAgentToken(plaintext);
  const now = Date.now();

  await db.prepare(`
    INSERT INTO agent_tokens (server_id, token_hash, token_prefix, created_at, rotated_at, last_used_at)
    VALUES (?, ?, ?, ?, ?, 0)
    ON CONFLICT(server_id) DO UPDATE SET
      token_hash = excluded.token_hash,
      token_prefix = excluded.token_prefix,
      rotated_at = excluded.rotated_at
  `).bind(serverId, hash, prefix, now, now).run();

  const stored = await getAgentToken(db, serverId);
  return {
    plaintext,
    tokenPrefix: prefix,
    createdAt: Number(stored?.created_at ?? now),
    rotatedAt: Number(stored?.rotated_at ?? now)
  };
}

/**
 * 撤销某个节点的令牌。撤销后下一次上报立刻 401。
 * @returns {Promise<boolean>} 撤销前是否确实存在令牌
 */
export async function revokeAgentToken(db, serverId) {
  const existing = await getAgentToken(db, serverId);
  try {
    await db.prepare('DELETE FROM agent_tokens WHERE server_id = ?').bind(serverId).run();
  } catch (e) {
    if (!isMissingTableError(e)) {
      console.warn('[AgentAuth] 撤销节点令牌失败:', e?.message || e);
    }
    return false;
  }
  return Boolean(existing);
}

/**
 * 删除某个节点的全部令牌（删除服务器时调用，避免留下还能用的凭据）。
 */
export async function deleteAgentTokens(db, serverId) {
  try {
    await db.prepare('DELETE FROM agent_tokens WHERE server_id = ?').bind(serverId).run();
  } catch (e) {
    if (!isMissingTableError(e)) {
      console.warn('[AgentAuth] 清理节点令牌失败:', e?.message || e);
    }
  }
}

/**
 * 决定安装命令里写哪个密钥。
 *
 * - 节点有自己的令牌：写那个令牌（明文只有创建时拿得到，拿不到就宁可不生成命令）；
 * - 节点没有令牌：退回共享密钥（全新安装的场景）。
 * - 任何情况下都不会返回空串以外的"半截"密钥，也不会返回空串给调用方去拼命令。
 */
export function resolveAgentInstallSecret({ nodeToken = '', hasNodeToken = false, sharedSecret = '' } = {}) {
  if (typeof nodeToken === 'string' && nodeToken) {
    return nodeToken;
  }
  if (hasNodeToken) {
    // 节点已经有令牌，但明文不可再取：宁可不生成命令，也不要写一个空密钥。
    return '';
  }
  return typeof sharedSecret === 'string' ? sharedSecret : '';
}
