// =====================
// SubStore 脚本：sing-box 1.14.x 配置构建
// 功能：自定义规则 + Tailscale + Tailscale DNS + 公司内网本地 DNS + 去广告 + SSID 自动回家
//
// 推荐 SubStore 参数：
// tskey=你的_tailscale_auth_key
// home_cidr=10.10.10.0/24
// home_wifi_ssid=ZTE-SuNthc-5G
// corp_dns=10.169.1.9
// corp_domain=longshine.com
// corp_cidrs=10.111.14.0/24,10.103.6.0/24,...
// corp_route_excludes=10.111.14.0/24,10.103.6.0/24,...
//
// 说明：
// - 公司域名 longshine.com 使用公司 DNS 解析。
// - 公司网段直连 direct。
// - 当前 Wi-Fi SSID 命中 home_wifi_ssid 时，home_cidr 直连 direct。
// - 当前 Wi-Fi SSID 未命中 home_wifi_ssid 时，home_cidr 走 Tailscale。
// - Tailscale 100.64/10 与 preferred_by=tailscale 走内置 Tailscale endpoint。
// =====================

const config = JSON.parse($content);

// =====================
// 0) 参数与常量
// =====================
const TS_TAG = "tailscale";
const TS_DNS_TAG = "ts-dns";
const CORP_DNS_TAG = "corp-dns";
const CORP_DIRECT_TAG = "corp-direct";
const RULE_SET_HTTP_CLIENT_TAG = "rule-set-proxy";
const LEGACY_RULE_SET_HTTP_CLIENT_TAG = "rule-set-direct";
const LEGACY_TS_TAG = "ts-ep";
const LEGACY_SUBNET_TAG = "TS-SUBNET";
const DEFAULT_HOME_CIDR = "10.10.10.0/24";
const DEFAULT_CORP_CIDRS = [
  "10.111.14.0/24",
  "10.103.6.0/24",
  "10.102.0.254/32",
  "10.104.0.254/32",
  "10.103.13.33/32",
  "10.103.14.28/32",
  "10.103.14.29/32",
  "36.150.163.143/32"
];
const DEFAULT_CORP_ROUTE_EXCLUDES = [
  "10.111.14.0/24",
  "10.103.6.0/24",
  "10.102.0.0/24",
  "10.104.0.0/24",
  "10.103.13.0/24",
  "10.103.14.0/24",
  "36.150.163.143/32"
];

const tskey = $arguments.tskey;

const homeCidr = $arguments.home_cidr || DEFAULT_HOME_CIDR;
const homeWifiSsids = ($arguments.home_wifi_ssid || "ZTE-SuNthc-5G")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);

const corpDns = $arguments.corp_dns || "10.169.1.9";
const corpDomain = $arguments.corp_domain || "longshine.com";
const corpCidrs = [...new Set([
  ...DEFAULT_CORP_CIDRS,
  ...($arguments.corp_cidrs || "").split(",").map(s => s.trim()).filter(Boolean)
])];
const corpRouteExcludes = [...new Set([
  ...DEFAULT_CORP_ROUTE_EXCLUDES,
  ...($arguments.corp_route_excludes || "").split(",").map(s => s.trim()).filter(Boolean)
])];

// =====================
// 1) 工具函数
// =====================
const arr = v => Array.isArray(v) ? v : (v ? [v] : []);

const hasRuleSet = (rule, tag) => {
  const rs = rule?.rule_set;
  return Array.isArray(rs) ? rs.includes(tag) : rs === tag;
};

const ensureRouteRuleOnce = (pred, rule, where = "unshift") => {
  config.route = config.route || {};
  config.route.rules = config.route.rules || [];
  if (config.route.rules.some(pred)) return;
  if (where === "push") config.route.rules.push(rule);
  else config.route.rules.unshift(rule);
};

const ensureDnsRuleOnce = (pred, rule, where = "unshift") => {
  config.dns = config.dns || {};
  config.dns.rules = config.dns.rules || [];
  if (config.dns.rules.some(pred)) return;
  if (where === "push") config.dns.rules.push(rule);
  else config.dns.rules.unshift(rule);
};

const ensureRuleSetOnce = (tag, ruleSet) => {
  config.route = config.route || {};
  config.route.rule_set = config.route.rule_set || [];
  if (!config.route.rule_set.some(rs => rs.tag === tag)) {
    config.route.rule_set.push(ruleSet);
  }
};

const hasCidr = (rule, cidr) =>
  arr(rule?.ip_cidr).includes(cidr) || arr(rule?.rules).some(child => hasCidr(child, cidr));

const cleanLegacyRule = rule => {
  if (rule.outbound === LEGACY_SUBNET_TAG) return false;
  if (rule.outbound === LEGACY_TS_TAG) rule.outbound = TS_TAG;
  if (Array.isArray(rule.rules)) {
    rule.rules = rule.rules.filter(cleanLegacyRule);
    if (rule.type === "logical" && rule.rules.length === 0) return false;
  }
  return true;
};

// =====================
// 2) route 基础结构
// =====================
config.route = config.route || {};
config.route.rules = config.route.rules || [];
config.route.rule_set = config.route.rule_set || [];
config.http_clients = config.http_clients || [];
config.http_clients = config.http_clients.filter(client => client.tag !== LEGACY_RULE_SET_HTTP_CLIENT_TAG);
const ruleSetHttpClient = config.http_clients.find(client => client.tag === RULE_SET_HTTP_CLIENT_TAG);
if (ruleSetHttpClient) ruleSetHttpClient.detour = "proxy";
else config.http_clients.push({ tag: RULE_SET_HTTP_CLIENT_TAG, detour: "proxy" });
config.route.default_http_client = RULE_SET_HTTP_CLIENT_TAG;

for (const ruleSet of config.route.rule_set) {
  if (ruleSet.download_detour && ruleSet.download_detour !== "direct") {
    ruleSet.http_client = ruleSet.http_client || {};
    ruleSet.http_client.detour = ruleSet.http_client.detour || ruleSet.download_detour;
  }
  delete ruleSet.download_detour;
  if (ruleSet.http_client?.detour === "direct") {
    delete ruleSet.http_client.detour;
    if (Object.keys(ruleSet.http_client).length === 0) delete ruleSet.http_client;
  }
}

// =====================
// 3) 自定义规则插入
// =====================
let customRules = [];

try {
  const customRulesContent = await produceArtifact({
    type: "file",
    name: "custom_rules.json"
  });

  if (customRulesContent && customRulesContent.trim()) {
    const parsed = JSON.parse(customRulesContent);
    customRules = Array.isArray(parsed) ? parsed : [parsed];
  }
} catch (e) {
  customRules = [];
}

if (customRules.length > 0) {
  const existingRules = new Set(config.route.rules.map(rule => JSON.stringify(rule)));
  customRules = customRules.filter(rule => !existingRules.has(JSON.stringify(rule)));
  const insertIndex = config.route.rules.findIndex(rule => rule.clash_mode === "Global");
  if (insertIndex !== -1) {
    config.route.rules.splice(insertIndex + 1, 0, ...customRules);
  } else {
    config.route.rules.push(...customRules);
  }
}

// =====================
// 4) experimental / clash api
// =====================
config.experimental = config.experimental || {};
config.experimental.clash_api = config.experimental.clash_api || {};
delete config.experimental.clash_api.external_ui;
delete config.experimental.clash_api.external_ui_download_url;
delete config.experimental.clash_api.external_ui_download_detour;

// =====================
// 5) endpoints / Tailscale
// =====================
config.endpoints = config.endpoints || [];
config.endpoints = config.endpoints.filter(endpoint => endpoint.tag !== LEGACY_TS_TAG);

const existingTsEndpoint = config.endpoints.find(e => e.tag === TS_TAG);

if (!existingTsEndpoint) {
  const endpoint = {
    type: "tailscale",
    tag: TS_TAG,
    state_directory: "tailscale",
    accept_routes: true
  };

  if (tskey) endpoint.auth_key = tskey;

  config.endpoints.push(endpoint);
} else {
  existingTsEndpoint.type = "tailscale";
  existingTsEndpoint.state_directory = existingTsEndpoint.state_directory || "tailscale";
  existingTsEndpoint.accept_routes = true;
  if (tskey) existingTsEndpoint.auth_key = tskey;
  else delete existingTsEndpoint.auth_key;
}

// =====================
// 6) DNS
// =====================
config.dns = config.dns || {};
delete config.dns.independent_cache;
config.dns.strategy = "ipv4_only";
config.dns.servers = config.dns.servers || [];
config.dns.rules = config.dns.rules || [];

// 6.1 fakeip 去 IPv6
for (const server of config.dns.servers) {
  if (server.type === "fakeip") {
    delete server.inet6_range;
  }
}

// 6.2 Tailscale DNS：解析 MagicDNS / ts.net
const tsDnsServer = config.dns.servers.find(server => server.tag === TS_DNS_TAG);
const tsDnsOptions = {
  type: "tailscale",
  tag: TS_DNS_TAG,
  endpoint: TS_TAG,
  accept_default_resolvers: true
};
if (tsDnsServer) Object.assign(tsDnsServer, tsDnsOptions);
else config.dns.servers.push(tsDnsOptions);

// 6.3 公司 DNS：解析 longshine.com
const corpDnsServer = config.dns.servers.find(server => server.tag === CORP_DNS_TAG);
const corpDnsOptions = {
  type: "udp",
  tag: CORP_DNS_TAG,
  server: corpDns,
  server_port: 53
};
if (corpDnsServer) Object.assign(corpDnsServer, corpDnsOptions);
else config.dns.servers.push(corpDnsOptions);

// 6.4 公司域名优先走公司 DNS
ensureDnsRuleOnce(
    r => r.server === CORP_DNS_TAG && arr(r.domain_suffix).includes(corpDomain),
    {
      domain_suffix: corpDomain,
      action: "route",
      server: CORP_DNS_TAG
    },
    "unshift"
);

ensureDnsRuleOnce(
    r => arr(r.domain).includes("vpn.longshine.com"),
    {
      domain: ["vpn.longshine.com"],
      action: "route",
      server: "ali" // 或 google
    },
    "unshift"
);

// 6.5 ts.net 走 Tailscale DNS
ensureDnsRuleOnce(
    r => r.server === TS_DNS_TAG && arr(r.domain_suffix).includes("ts.net"),
    {
      domain_suffix: "ts.net",
      action: "route",
      server: TS_DNS_TAG
    },
    "unshift"
);

// 6.6 DNS 去广告
if (!config.dns.rules.some(r => hasRuleSet(r, "category-ads-all"))) {
  const adsDnsRule = {
    rule_set: "category-ads-all",
    action: "reject"
  };

  const cnIndex = config.dns.rules.findIndex(r => hasRuleSet(r, "cn_domain"));
  if (cnIndex >= 0) {
    config.dns.rules.splice(cnIndex, 0, adsDnsRule);
  } else {
    config.dns.rules.push(adsDnsRule);
  }
}

// =====================
// 7) inbounds / tun
// =====================
config.inbounds = config.inbounds || [];

for (const inbound of config.inbounds) {
  if (inbound.type !== "tun") continue;

  // IPv4 only：删除 TUN IPv6 地址
  if (Array.isArray(inbound.address)) {
    inbound.address = inbound.address.filter(a => !String(a).includes(":"));
  }

  // 使用较宽前缀，保证公司 VPN 安装的 /32 路由优先于 TUN 排除路由。
  const excludeList = [
    "127.0.0.0/8",
    "172.16.0.0/12",
    "192.168.0.0/16",
    "169.254.0.0/16",
    "fd7a:115c:a1e0::/48",
    "::1/128",
    "fe80::/10",
    "fd00::/8",
    ...corpRouteExcludes
  ];

  inbound.route_exclude_address = Array.isArray(inbound.route_exclude_address)
      ? inbound.route_exclude_address
      : [];

  for (const cidr of excludeList) {
    if (!inbound.route_exclude_address.includes(cidr)) {
      inbound.route_exclude_address.push(cidr);
    }
  }
}

// =====================
// 8) 清理旧 Tailscale / TS-SUBNET 引用
// =====================
config.outbounds = config.outbounds || [];
config.outbounds = config.outbounds.filter(outbound => outbound.tag !== LEGACY_SUBNET_TAG);
const corpDirectOptions = {
  tag: CORP_DIRECT_TAG,
  type: "direct",
  domain_resolver: { server: CORP_DNS_TAG }
};
const corpDirect = config.outbounds.find(outbound => outbound.tag === CORP_DIRECT_TAG);
if (corpDirect) Object.assign(corpDirect, corpDirectOptions);
else config.outbounds.push(corpDirectOptions);
for (const outbound of config.outbounds) {
  if (Array.isArray(outbound.outbounds)) {
    outbound.outbounds = outbound.outbounds
      .filter(tag => tag !== LEGACY_SUBNET_TAG)
      .map(tag => tag === LEGACY_TS_TAG ? TS_TAG : tag);
  }
  if (outbound.default === LEGACY_TS_TAG || outbound.default === LEGACY_SUBNET_TAG) {
    outbound.default = TS_TAG;
  }
}

// =====================
// 9) route rule_set / 广告拦截
// =====================
ensureRuleSetOnce("category-ads-all", {
  tag: "category-ads-all",
  type: "remote",
  format: "binary",
  url: "https://fastly.jsdelivr.net/gh/SagerNet/sing-geosite@rule-set/geosite-category-ads-all.srs"
});

if (!config.route.rules.some(r => hasRuleSet(r, "category-ads-all"))) {
  const adsRouteRule = {
    rule_set: "category-ads-all",
    action: "reject"
  };

  const hijackIndex = config.route.rules.findIndex(r => r.action === "hijack-dns");
  if (hijackIndex >= 0) {
    config.route.rules.splice(hijackIndex + 1, 0, adsRouteRule);
  } else {
    config.route.rules.unshift(adsRouteRule);
  }
}



// =====================
// 10) route / 公司、Tailscale、回家
// =====================

// 保留当前版本对公司 VPN 域名的显式直连处理。
ensureRouteRuleOnce(
    r => arr(r.domain).includes("vpn.longshine.com") && r.outbound === "direct",
    {
      domain: ["vpn.longshine.com"],
      action: "route",
      outbound: "direct"
    },
    "unshift"
);

const managedCidrs = [...corpCidrs, homeCidr, DEFAULT_HOME_CIDR, "100.64.0.0/10"];
config.route.rules = config.route.rules
  .filter(cleanLegacyRule)
  .filter(rule => {
    if (["direct", CORP_DIRECT_TAG].includes(rule.outbound) && arr(rule.domain_suffix).includes(corpDomain)) return false;
    if (arr(rule.preferred_by).includes(TS_TAG)) return false;
    return !managedCidrs.some(cidr => hasCidr(rule, cidr));
  });

const managedRules = [
  {
    domain_suffix: corpDomain,
    action: "route",
    outbound: CORP_DIRECT_TAG
  },
  ...corpCidrs.map(cidr => ({
    ip_cidr: [cidr],
    action: "route",
    outbound: "direct"
  })),
  {
    type: "logical",
    mode: "and",
    rules: [
      { wifi_ssid: homeWifiSsids },
      { ip_cidr: [homeCidr] }
    ],
    action: "route",
    outbound: "direct"
  },
  {
    ip_cidr: [homeCidr],
    action: "route",
    outbound: TS_TAG
  },
  {
    ip_cidr: ["100.64.0.0/10"],
    action: "route",
    outbound: TS_TAG
  },
  {
    preferred_by: [TS_TAG],
    action: "route",
    outbound: TS_TAG
  }
];

// 保留 sniff / DNS 劫持在最前，业务规则从 hijack-dns 后按契约顺序插入。
const coreActionIndex = config.route.rules.reduce(
  (index, rule, current) => ["sniff", "hijack-dns"].includes(rule.action) ? current : index,
  -1
);
config.route.rules.splice(coreActionIndex + 1, 0, ...managedRules);

// =====================
// 11) 输出最终配置
// =====================
$content = JSON.stringify(config, null, 2);
