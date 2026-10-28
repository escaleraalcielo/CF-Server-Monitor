import { md5Hash } from './common.js';
import { isWssReportConfigured } from './settings.js';

export const AGENT_CONFIG_SCHEMA_VERSION = 7;
export const AGENT_CONFIG_LEGACY_SCHEMA_VERSION = 3;
export const AGENT_CONFIG_CONNECTION_MODE_SCHEMA_VERSION = 4;
export const AGENT_CONFIG_WSS_REPORT_INTERVAL_SCHEMA_VERSION = 5;
export const AGENT_CONFIG_PING_MODE_SCHEMA_VERSION = 6;
export const AGENT_CONFIG_EXTRA_NODES_SCHEMA_VERSION = 7;
export const AGENT_CONFIG_SCHEMA_HEADER = 'X-Agent-Config-Schema';
export const AGENT_CONFIG_MD5_HEADER = 'X-Agent-Config-Md5';
export const MAX_TRAFFIC_CORRECTION_GB = 1000000;
export const CONNECTION_MODE_AUTO = 'auto';
export const CONNECTION_MODE_HTTP = 'http';
export const PING_MODE_TCP = 'tcp';
export const PING_MODE_ICMP = 'icmp';
export const DEFAULT_WSS_REPORT_INTERVAL = 2;

const ALLOWED_COLLECT_INTERVALS = new Set([0, 1, 2, 5, 10]);
const ALLOWED_REPORT_INTERVALS = new Set([30, 60, 120, 180]);
const ALLOWED_WSS_REPORT_INTERVALS = new Set([1, 2, 3, 4, 5]);
const ALLOWED_CONNECTION_MODES = new Set([CONNECTION_MODE_AUTO, CONNECTION_MODE_HTTP]);
const ALLOWED_PING_MODES = new Set([PING_MODE_TCP, PING_MODE_ICMP]);
const PING_NODE_HOST_PATTERN = /^[a-zA-Z0-9._-]+$/;
const IPV4_PATTERN = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const IPV4_LIKE_PATTERN = /^(?:\d+\.){3}\d+$/;
const IPV6_PATTERN = /^(?:(?:[0-9a-f]{1,4}:){1,7}[0-9a-f]{1,4}|(?:[0-9a-f]{1,4}:){1,7}:|(?:[0-9a-f]{1,4}:){1,6}:[0-9a-f]{1,4}|(?:[0-9a-f]{1,4}:){1,5}(?::[0-9a-f]{1,4}){1,2}|(?:[0-9a-f]{1,4}:){1,4}(?::[0-9a-f]{1,4}){1,3}|(?:[0-9a-f]{1,4}:){1,3}(?::[0-9a-f]{1,4}){1,4}|(?:[0-9a-f]{1,4}:){1,2}(?::[0-9a-f]{1,4}){1,5}|[0-9a-f]{1,4}:(?:(?::[0-9a-f]{1,4}){1,6})|:(?:(?::[0-9a-f]{1,4}){1,7}|:))$/i;
const NETWORK_INTERFACE_PATTERN = /^[A-Za-z0-9_.:-]+$/;

function normalizeSchemaVersion(value) {
  const version = Number(value);
  return Number.isInteger(version) && version >= AGENT_CONFIG_LEGACY_SCHEMA_VERSION && version <= AGENT_CONFIG_SCHEMA_VERSION
    ? version
    : AGENT_CONFIG_SCHEMA_VERSION;
}

export function normalizeAgentConfigSchemaVersion(value) {
  const version = Number(value);
  return Number.isInteger(version) && version >= AGENT_CONFIG_LEGACY_SCHEMA_VERSION && version <= AGENT_CONFIG_SCHEMA_VERSION
    ? version
    : null;
}

function validateInteger(name, value, allowedValues = null, min = null, max = null) {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return `${name} must be an integer`;
  }
  if (allowedValues && !allowedValues.has(value)) {
    return `${name} is not allowed`;
  }
  if (min !== null && value < min) return `${name} is below the minimum`;
  if (max !== null && value > max) return `${name} is above the maximum`;
  return null;
}

export function validateAgentConfigInput(input) {
  const collectError = validateInteger(
    'collect_interval',
    input.collect_interval,
    ALLOWED_COLLECT_INTERVALS
  );
  if (collectError) return { valid: false, error: collectError };

  const reportError = validateInteger(
    'report_interval',
    input.report_interval,
    ALLOWED_REPORT_INTERVALS
  );
  if (reportError) return { valid: false, error: reportError };

  const wssReportInterval = input.wss_report_interval === undefined
    ? DEFAULT_WSS_REPORT_INTERVAL
    : input.wss_report_interval;
  const wssReportError = validateInteger(
    'wss_report_interval',
    wssReportInterval,
    null,
    1,
    5
  );
  if (wssReportError) return { valid: false, error: wssReportError };

  const resetError = validateInteger('reset_day', input.reset_day, null, 0, 31);
  if (resetError) return { valid: false, error: resetError };

  if (input.collect_interval > 0 && input.report_interval < input.collect_interval) {
    return { valid: false, error: 'report_interval must be greater than or equal to collect_interval' };
  }

  if (
    input.collect_interval > 0 &&
    Math.ceil(input.report_interval / input.collect_interval) > 300
  ) {
    return { valid: false, error: 'configuration would create more than 300 samples per report' };
  }

  const connectionMode = normalizeConnectionMode(input.connection_mode);
  if (!ALLOWED_CONNECTION_MODES.has(connectionMode)) {
    return { valid: false, error: 'connection_mode is not allowed' };
  }

  const pingMode = normalizePingMode(input.ping_mode);
  if (!ALLOWED_PING_MODES.has(pingMode)) {
    return { valid: false, error: 'ping_mode is not allowed' };
  }

  return {
    valid: true,
    config: {
      collect_interval: input.collect_interval,
      report_interval: input.report_interval,
      wss_report_interval: wssReportInterval,
      reset_day: input.reset_day,
      connection_mode: connectionMode,
      ping_mode: pingMode,
      schema_version: AGENT_CONFIG_SCHEMA_VERSION
    }
  };
}

function storedInteger(value, allowedValues, fallback) {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(number) && allowedValues.has(number) ? number : fallback;
}

export function normalizeWssReportInterval(value) {
  return storedInteger(value, ALLOWED_WSS_REPORT_INTERVALS, DEFAULT_WSS_REPORT_INTERVAL);
}

function isValidIpv4(host) {
  if (!IPV4_PATTERN.test(host)) return false;
  return host.split('.').every(part => {
    const number = Number(part);
    return Number.isInteger(number) && number >= 0 && number <= 255;
  });
}

function isValidHostname(host) {
  if (!PING_NODE_HOST_PATTERN.test(host) || host.length > 50) return false;
  if (IPV4_LIKE_PATTERN.test(host)) return false;
  if (host.startsWith('.') || host.endsWith('.') || host.includes('..')) return false;
  return host.split('.').every(label => {
    if (!label || label.length > 63) return false;
    return /^[a-zA-Z0-9_](?:[a-zA-Z0-9_-]*[a-zA-Z0-9_])?$/.test(label);
  });
}
const isValidIpv6 = (host) => IPV6_PATTERN.test(host);

export function validatePingNode(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return { valid: true, value: '' };
  if (raw.length > 60 || raw.includes('://') || /[\s/@?#\\]/.test(raw)) {
    return { valid: false };
  }

  if (raw.startsWith('[')) {
    const match = raw.match(/^\[([^\]]+)\](?::(\d{1,5}))?$/);
    if (!match || !isValidIpv6(match[1])) return { valid: false };
    const port = match[2] ? Number(match[2]) : null;
    if (port !== null && (port < 1 || port > 65535)) return { valid: false };
    return { valid: true, value: `[${match[1].toLowerCase()}]${port !== null ? `:${port}` : ''}` };
  }

  const colonCount = (raw.match(/:/g) || []).length;
  if (colonCount > 1) {
    const host = raw.toLowerCase();
    return isValidIpv6(host) ? { valid: true, value: `[${host}]` } : { valid: false };
  }

  let host = raw;
  let port = '';
  if (colonCount === 1) {
    const parts = raw.split(':');
    host = parts[0];
    port = parts[1];
    if (!port || !/^\d{1,5}$/.test(port)) return { valid: false };
    const portNumber = Number(port);
    if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) {
      return { valid: false };
    }
    port = String(portNumber);
  }

  host = host.toLowerCase();
  if (!host) return { valid: false };
  if (isValidIpv4(host) || isValidHostname(host)) {
    return { valid: true, value: port ? `${host}:${port}` : host };
  }
  return { valid: false };
}

export function sanitizePingNode(value) {
  const result = validatePingNode(value);
  return result.valid ? result.value : '';
}

export function validateNetworkInterfaces(value) {
  const raw = String(value || '').trim();
  if (!raw) return { valid: true, value: '' };
  if (raw.length > 255 || /[/@?#\\[\]]/.test(raw)) {
    return { valid: false };
  }

  const seen = new Set();
  const interfaces = [];
  for (const item of raw.split(',')) {
    const name = item.trim();
    if (!name) continue;
    if (name.length > 64 || !NETWORK_INTERFACE_PATTERN.test(name)) {
      return { valid: false };
    }
    if (!seen.has(name)) {
      seen.add(name);
      interfaces.push(name);
    }
  }

  const normalized = interfaces.join(',');
  if (normalized.length > 255) return { valid: false };
  return { valid: true, value: normalized };
}

export function sanitizeNetworkInterfaces(value) {
  const result = validateNetworkInterfaces(value);
  return result.valid ? result.value : '';
}

export function normalizeConnectionMode(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw || raw === CONNECTION_MODE_AUTO || raw === 'wss' || raw === 'websocket') {
    return CONNECTION_MODE_AUTO;
  }
  if (raw === CONNECTION_MODE_HTTP || raw === 'post') {
    return CONNECTION_MODE_HTTP;
  }
  return '';
}

export function normalizePingMode(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw || raw === PING_MODE_TCP) {
    return PING_MODE_TCP;
  }
  if (raw === PING_MODE_ICMP) {
    return PING_MODE_ICMP;
  }
  return '';
}

export function isValidTrafficCorrection(value) {
  let number;
  if (typeof value === 'number') {
    number = value;
  } else if (typeof value === 'string' && /^[0-9]+(?:\.[0-9]+)?$/.test(value)) {
    number = Number(value);
  } else {
    return false;
  }
  return Number.isFinite(number) && number >= 0 && number <= MAX_TRAFFIC_CORRECTION_GB;
}

export function normalizeTrafficCorrection(value) {
  return isValidTrafficCorrection(value) ? Number(value) : 0;
}

// The single source of truth for the agent config channel. Each entry names
// one key, the minimum negotiated schema version that may receive it, and how
// its value is resolved. `buildAgentConfig` assembles the payload by walking
// this list in order and `serializeAgentConfig` renders the same keys into the
// body whose MD5 the agent verifies, so payload and body can never diverge.
// Only inert configuration belongs here — never an update trigger (`update`,
// `auto_update`), a download/proxy URL (`update_proxy`), a credential
// (`secret`), or any key that could make an agent act. Entries flagged
// `correction` travel only when the server row carries traffic corrections.
const pingNodeField = (key, minVersion = AGENT_CONFIG_LEGACY_SCHEMA_VERSION) => ({
  key,
  minVersion,
  resolve: ({ resolveNode }) => resolveNode(key)
});

const AGENT_CONFIG_FIELD_SPECS = [
  {
    key: 'collect_interval',
    minVersion: AGENT_CONFIG_LEGACY_SCHEMA_VERSION,
    resolve: ({ server }) => storedInteger(server?.collect_interval, ALLOWED_COLLECT_INTERVALS, 0)
  },
  {
    key: 'report_interval',
    minVersion: AGENT_CONFIG_LEGACY_SCHEMA_VERSION,
    resolve: ({ server }, config) => {
      const reportInterval = storedInteger(server?.report_interval, ALLOWED_REPORT_INTERVALS, 60);
      return config.collect_interval > 0 && reportInterval < config.collect_interval
        ? 60
        : reportInterval;
    }
  },
  {
    key: 'reset_day',
    minVersion: AGENT_CONFIG_LEGACY_SCHEMA_VERSION,
    resolve: ({ server }) => {
      const resetNumber = typeof server?.reset_day === 'number'
        ? server.reset_day
        : Number(server?.reset_day);
      return Number.isInteger(resetNumber) && resetNumber >= 0 && resetNumber <= 31
        ? resetNumber
        : 1;
    }
  },
  {
    key: 'schema_version',
    minVersion: AGENT_CONFIG_LEGACY_SCHEMA_VERSION,
    resolve: ({ version }) => version
  },
  pingNodeField('custom_ct'),
  pingNodeField('custom_cu'),
  pingNodeField('custom_cm'),
  pingNodeField('custom_bd'),
  {
    key: 'interface',
    minVersion: AGENT_CONFIG_LEGACY_SCHEMA_VERSION,
    resolve: ({ server }) => sanitizeNetworkInterfaces(server?.interface || '')
  },
  pingNodeField('node_1', AGENT_CONFIG_EXTRA_NODES_SCHEMA_VERSION),
  pingNodeField('node_2', AGENT_CONFIG_EXTRA_NODES_SCHEMA_VERSION),
  pingNodeField('node_3', AGENT_CONFIG_EXTRA_NODES_SCHEMA_VERSION),
  pingNodeField('node_4', AGENT_CONFIG_EXTRA_NODES_SCHEMA_VERSION),
  {
    key: 'connection_mode',
    minVersion: AGENT_CONFIG_CONNECTION_MODE_SCHEMA_VERSION,
    resolve: ({ server, wssEnabled }) => (wssEnabled
      ? normalizeConnectionMode(server?.connection_mode) || CONNECTION_MODE_AUTO
      : CONNECTION_MODE_HTTP)
  },
  {
    key: 'wss_report_interval',
    minVersion: AGENT_CONFIG_WSS_REPORT_INTERVAL_SCHEMA_VERSION,
    resolve: ({ server, wssEnabled }, config) => {
      if (config.connection_mode !== CONNECTION_MODE_AUTO || !wssEnabled) return undefined;
      const wssReportInterval = normalizeWssReportInterval(server?.wss_report_interval);
      if (config.collect_interval === 0 || config.collect_interval > wssReportInterval) {
        config.collect_interval = wssReportInterval;
      }
      return wssReportInterval;
    }
  },
  {
    key: 'ping_mode',
    minVersion: AGENT_CONFIG_PING_MODE_SCHEMA_VERSION,
    resolve: ({ server }) => normalizePingMode(server?.ping_mode) || PING_MODE_TCP
  },
  {
    key: 'rx_correction',
    minVersion: AGENT_CONFIG_LEGACY_SCHEMA_VERSION,
    correction: true,
    resolve: ({ server }) => normalizeTrafficCorrection(server?.rx_correction)
  },
  {
    key: 'tx_correction',
    minVersion: AGENT_CONFIG_LEGACY_SCHEMA_VERSION,
    correction: true,
    resolve: ({ server }) => normalizeTrafficCorrection(server?.tx_correction)
  }
];

export const AGENT_CONFIG_KEYS = Object.freeze(AGENT_CONFIG_FIELD_SPECS.map(spec => spec.key));

export function buildAgentConfig(server, settings = null, schemaVersion = AGENT_CONFIG_SCHEMA_VERSION) {
  const version = normalizeSchemaVersion(schemaVersion);
  const resolveNode = (field) => {
    const serverValue = server?.[field];
    const hasServerField = server && Object.prototype.hasOwnProperty.call(server, field);
    // A stored 0 explicitly disables this node; blank/null inherits the global node.
    if (hasServerField && (serverValue === 0 || serverValue === '0')) return '';
    const value = hasServerField && serverValue !== null && serverValue !== undefined && serverValue !== ''
      ? serverValue
      : settings?.[field] || '';
    return sanitizePingNode(value);
  };
  const context = {
    server,
    version,
    resolveNode,
    wssEnabled: isWssReportConfigured(settings)
  };

  const config = {};
  for (const spec of AGENT_CONFIG_FIELD_SPECS) {
    if (spec.correction || version < spec.minVersion) continue;
    const value = spec.resolve(context, config);
    if (value !== undefined) config[spec.key] = value;
  }
  return config;
}

export function serializeAgentConfig(config) {
  const parts = [];
  for (const spec of AGENT_CONFIG_FIELD_SPECS) {
    if (spec.correction) continue;
    if (Object.prototype.hasOwnProperty.call(config, spec.key)) {
      parts.push(`${spec.key}=${config[spec.key]}`);
    }
  }
  return parts.join('&');
}

export function serializeCorrection(correction) {
  if (correction === null || correction === undefined) return '';
  return AGENT_CONFIG_FIELD_SPECS
    .filter(spec => spec.correction)
    .map(spec => `&${spec.key}=${correction[spec.key]}`)
    .join('');
}

export async function describeAgentConfig(server, settings = null, schemaVersion = AGENT_CONFIG_SCHEMA_VERSION) {
  const config = buildAgentConfig(server, settings, schemaVersion);
  const serialized = serializeAgentConfig(config);
  const md5 = await md5Hash(serialized);

  const hasCorrection = AGENT_CONFIG_FIELD_SPECS.some(
    spec => spec.correction && server?.[spec.key] != null
  );
  let correction = null;
  if (hasCorrection) {
    correction = {};
    for (const spec of AGENT_CONFIG_FIELD_SPECS) {
      if (spec.correction) correction[spec.key] = spec.resolve({ server });
    }
  }

  return { config, serialized, md5, correction };
}
