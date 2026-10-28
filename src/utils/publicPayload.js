/**
 * 公开状态页载荷构建（allowlist）。
 *
 * 未登录访客能看到的服务器字段只能来自 PUBLIC_SERVER_FIELDS：从空对象开始
 * 逐字段拷贝，而不是在完整行上删除已知私有字段。任何后续新增到 servers 行
 * 的字段默认不会进入公开响应，除非显式加入白名单。
 *
 * 无论 settings 如何配置都永不公开：服务器 id、note、tags、price/currency/
 * billing_cycle/auto_renewal/expire_date 等计费信息、agent 配置（collect_interval、
 * report_interval、wss_report_interval、connection_mode、ping_mode、auto_update、
 * custom_*、node_*、interface、offline_notify_disabled）、流量修正
 * （rx_correction、tx_correction、traffic_alert_percent、traffic_alert_state、
 * reset_day）、原始 IP 地址。IP 只以可达性 '1'/'0' 形式出现。
 */

function toPublicIpReachability(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  return normalized && normalized !== '0' && normalized !== 'false' ? '1' : '0';
}

// ip_v4/ip_v6 归一成可达性标志；data/payload/metrics 里的内嵌探针载荷递归处理。
export function normalizePublicIpFields(item, ensureFields = true) {
  if (ensureFields || Object.prototype.hasOwnProperty.call(item, 'ip_v4')) {
    item.ip_v4 = toPublicIpReachability(item.ip_v4);
  }
  if (ensureFields || Object.prototype.hasOwnProperty.call(item, 'ip_v6')) {
    item.ip_v6 = toPublicIpReachability(item.ip_v6);
  }
  for (const field of ['data', 'payload', 'metrics']) {
    if (item[field] && typeof item[field] === 'object' && !Array.isArray(item[field])) {
      item[field] = normalizePublicIpFields({ ...item[field] }, false);
    }
  }
  return item;
}

// 公开白名单：只有这里列出的字段会进入未登录响应。
export const PUBLIC_SERVER_FIELDS = Object.freeze([
  // 展示身份
  'name',
  'region',
  'server_group',
  // 系统信息（公开页一直展示）
  'os',
  'arch',
  'kernel_version',
  'cpu_info',
  'cpu_cores',
  'gpu_info',
  // 指标
  'cpu',
  'load_avg',
  'ram_total',
  'ram_used',
  'swap_total',
  'swap_used',
  'disk_total',
  'disk_used',
  'disk',
  'processes',
  'tcp_conn',
  'udp_conn',
  'net_in_speed',
  'net_out_speed',
  'net_rx',
  'net_tx',
  'net_rx_monthly',
  'net_tx_monthly',
  'ping_ct',
  'ping_cu',
  'ping_cm',
  'ping_bd',
  'loss_ct',
  'loss_cu',
  'loss_cm',
  'loss_bd',
  'ping_node_1',
  'ping_node_2',
  'ping_node_3',
  'ping_node_4',
  'loss_node_1',
  'loss_node_2',
  'loss_node_3',
  'loss_node_4',
  // 在线状态与延迟窗口
  'last_updated',
  'boot_time',
  'ping',
  'loss',
  // 流量配额展示（前端由 sysConfig.show_tf 控制是否渲染）
  'traffic_limit',
  'traffic_calc_type',
  // IP 仅以可达性 '1'/'0' 出现
  'ip_v4',
  'ip_v6'
]);

// 从空对象出发，只拷贝白名单内且确实存在的字段。
export function toPublicServer(server) {
  const view = {};
  if (!server || typeof server !== 'object') return view;

  for (const field of PUBLIC_SERVER_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(server, field)) {
      view[field] = server[field];
    }
  }

  view.ip_v4 = toPublicIpReachability(view.ip_v4);
  view.ip_v6 = toPublicIpReachability(view.ip_v6);
  return view;
}

// 公开响应里的实时上报更新不携带 serverId：服务器 id 永不公开。
export function toPublicLatestReportUpdates(updates) {
  if (!Array.isArray(updates)) return [];
  return updates.map(update => {
    if (!update || typeof update !== 'object') return update;
    const { serverId, ...rest } = update;
    return rest;
  });
}
