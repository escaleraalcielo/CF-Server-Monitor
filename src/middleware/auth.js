const ALGORITHM = { name: 'HMAC', hash: 'SHA-256' };
import { verifyPasswordHash, timingSafeEqualString } from '../utils/common.js';
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

/**
 * Verify a bearer/cookie token.
 * @returns {Promise<object|null>} the decoded payload, or null when invalid
 */
async function verifyToken(token, env, sys) {
  if (!token) return null;

  try {
    // getJwtSecret throws when no JWT secret is configured. That must degrade to
    // "not authenticated", never to a 500 for the whole request.
    const secret = getJwtSecret(env, sys);
    return await verifyJwt(token, secret);
  } catch (e) {
    console.error('Auth check error:', e);
    return null;
  }
}

export async function generateToken(env, sys, options = {}) {
  const payload = {
    sub: 'admin',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 604800
  };

  // A bootstrap session is issued when the panel is logged in with the
  // default credentials (no admin password has been configured yet). It is
  // restricted to the password-change flow and carries `scope: 'bootstrap'`,
  // so it cannot be used to administer the panel.
  if (options.scope) {
    payload.scope = options.scope;
  }

  const secret = getJwtSecret(env, sys);
  return signJwt(payload, secret);
}

/**
 * Verify a request's credentials and return the decoded token payload.
 * @returns {Promise<object|null>} payload when authenticated, else null
 */
export async function getAuthPayload(request, env, sys) {
  let payload = await verifyToken(extractBearerToken(request), env, sys);
  if (!payload) {
    payload = await verifyToken(getCookieValue(request, AUTH_COOKIE_NAME), env, sys);
  }
  return payload;
}

export async function checkAuth(request, env, sys) {
  return !!(await getAuthPayload(request, env, sys));
}

export async function checkWebSocketAuth(request, env, sys) {
  const payload = await getAuthPayload(request, env, sys);
  if (payload) {
    // A bootstrap session must not receive the live metrics stream.
    return payload.scope !== 'bootstrap';
  }

  let url;
  try {
    url = new URL(request.url);
  } catch (_) {
    return false;
  }

  for (const key of TOKEN_QUERY_KEYS) {
    const queryPayload = await verifyToken(url.searchParams.get(key), env, sys);
    if (queryPayload) {
      return queryPayload.scope !== 'bootstrap';
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
        needsPasswordUpgrade: result.needsRehash === true,
        bootstrap: false
      };
    }

    // No admin password has been configured yet. This is the state of a fresh
    // install, where the documented default credentials are `admin` and
    // API_SECRET. Allow that login so a new deployment is not locked out of
    // its own panel, but mark it as a bootstrap session: it can only be used
    // to set an independent password, and it never grants panel access.
    //
    // The shared ingest secret lives in the config file of every monitored
    // host, so it must not be an ongoing administrator credential.
    if (typeof env.API_SECRET !== 'string' || env.API_SECRET.length === 0) {
      return { valid: false, needsPasswordUpgrade: false };
    }

    if (username !== validUsername) {
      return { valid: false, needsPasswordUpgrade: false };
    }

    const secretMatches = await timingSafeEqualString(password, env.API_SECRET);
    return {
      valid: secretMatches,
      needsPasswordUpgrade: false,
      bootstrap: secretMatches
    };
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
