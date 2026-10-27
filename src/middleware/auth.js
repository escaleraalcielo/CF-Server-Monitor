const ALGORITHM = { name: 'HMAC', hash: 'SHA-256' };
import { verifyPasswordHash } from '../utils/common.js';
import { isValidJwtSecret } from '../utils/settings.js';

export const AUTH_COOKIE_NAME = 'cfsm_auth';
const TOKEN_QUERY_KEYS = ['token', 'auth_token', 'ws_token'];

async function generateKeyFromSecret(secret) {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(secret);
  return await crypto.subtle.importKey('raw', keyData, ALGORITHM, false, ['sign', 'verify']);
}

function base64UrlEncode(input) {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function base64UrlDecode(input) {
  const normalized = String(input).replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function signJwt(payload, secret) {
  const header = { alg: 'HS256', typ: 'JWT' };
  // 使用 base64url：token 可能出现在 ?token= 查询参数中，
  // 标准 base64 的 '+' / '/' 会被 URL 解析破坏。
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));

  const data = `${encodedHeader}.${encodedPayload}`;
  const key = await generateKeyFromSecret(secret);

  const encoder = new TextEncoder();
  const dataBytes = encoder.encode(data);
  const signature = await crypto.subtle.sign(ALGORITHM, key, dataBytes);

  const encodedSignature = base64UrlEncode(new Uint8Array(signature));

  return `${encodedHeader}.${encodedPayload}.${encodedSignature}`;
}

async function verifyJwt(token, secret) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) {
      return null;
    }
    
    const [encodedHeader, encodedPayload, encodedSignature] = parts;
    
    const key = await generateKeyFromSecret(secret);
    
    const data = `${encodedHeader}.${encodedPayload}`;
    const encoder = new TextEncoder();
    const dataBytes = encoder.encode(data);
    
    const signatureBytes = base64UrlDecode(encodedSignature);

    const isValid = await crypto.subtle.verify(ALGORITHM, key, signatureBytes, dataBytes);

    if (!isValid) {
      return null;
    }

    const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(encodedPayload)));
    
    if (payload.exp && Date.now() > payload.exp * 1000) {
      return null;
    }
    
    return payload;
  } catch (e) {
    console.error('JWT verification error:', e);
    return null;
  }
}

function getJwtSecret(env, sys) {
  if (isValidJwtSecret(sys?.jwt_secret)) {
    return sys.jwt_secret;
  }

  // 回退到独立的 JWT_SECRET 环境变量（Worker Secret）。
  // 绝不回退到 API_SECRET：那是所有 Agent 共用的上报密钥，
  // 任何一台被监控主机泄露它就等于拿到会话签发密钥。
  if (isValidJwtSecret(env?.JWT_SECRET)) {
    return env.JWT_SECRET;
  }

  throw new Error('JWT secret is not configured');
}

function getCookieValue(request, name) {
  const cookie = request?.headers?.get('Cookie') || '';
  const prefix = `${name}=`;
  for (const part of cookie.split(';')) {
    const item = part.trim();
    if (!item.startsWith(prefix)) continue;
    try {
      return decodeURIComponent(item.slice(prefix.length));
    } catch (_) {
      return item.slice(prefix.length);
    }
  }
  return '';
}

function extractBearerToken(request) {
  const authHeader = request?.headers?.get('Authorization') || '';
  const parts = authHeader.trim().split(/\s+/);
  return parts[0] === 'Bearer' && parts[1] ? parts[1] : '';
}

async function verifyToken(token, env, sys) {
  if (!token) return false;
  const secret = getJwtSecret(env, sys);

  try {
    const payload = await verifyJwt(token, secret);
    return payload !== null;
  } catch (e) {
    console.error('Auth check error:', e);
    return false;
  }
}

export async function generateToken(env, sys) {
  const payload = {
    sub: 'admin',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 604800
  };

  const secret = getJwtSecret(env, sys);
  return signJwt(payload, secret);
}

export async function checkAuth(request, env, sys) {
  if (await verifyToken(extractBearerToken(request), env, sys)) {
    return true;
  }
  return verifyToken(getCookieValue(request, AUTH_COOKIE_NAME), env, sys);
}

export async function checkWebSocketAuth(request, env, sys) {
  if (await checkAuth(request, env, sys)) {
    return true;
  }

  let url;
  try {
    url = new URL(request.url);
  } catch (_) {
    return false;
  }

  for (const key of TOKEN_QUERY_KEYS) {
    if (await verifyToken(url.searchParams.get(key), env, sys)) {
      return true;
    }
  }
  return false;
}

export function buildAuthCookie(request, token, maxAge = 604800) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `${AUTH_COOKIE_NAME}=${encodeURIComponent(token || '')}; Max-Age=${maxAge}; Path=/; HttpOnly; SameSite=Lax${secure}`;
}

export function buildClearAuthCookie(request) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `${AUTH_COOKIE_NAME}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax${secure}`;
}

export async function validateCredentials(username, password, env, sys) {
  try {
    const validUsername = (sys && sys.username && sys.username.length > 0)
      ? sys.username
      : (typeof env.API_USER_NAME === 'string' && env.API_USER_NAME.length > 0)
        ? env.API_USER_NAME
        : 'admin';

    if (sys && sys.password && sys.password.length > 0) {
      if (username !== validUsername) {
        return { valid: false, needsPasswordUpgrade: false };
      }

      const result = await verifyPasswordHash(password, sys.password);
      return {
        valid: result.valid,
        needsPasswordUpgrade: result.needsRehash === true
      };
    }

    // 未在后台设置独立管理员密码时直接拒绝登录：
    // API_SECRET 是所有 Agent 共用的上报密钥，写在每台被监控主机的配置文件里，
    // 拿它当管理员密码意味着任意一台主机泄露即可接管整个面板。
    // 兼容路径仅保留给显式配置 API_USER_NAME 且设置了独立密码的部署。
    console.warn('[Auth] 拒绝登录：尚未设置独立的管理员密码');
    return { valid: false, needsPasswordUpgrade: false };
  } catch (e) {
    console.error('Credential validation error:', e);
    return { valid: false, needsPasswordUpgrade: false };
  }
}

export function simpleAuthResponse() {
  return new Response(JSON.stringify({ error: 'Unauthorized', code: 401 }), {
    status: 401,
    headers: { 'Content-Type': 'application/json' }
  });
}
