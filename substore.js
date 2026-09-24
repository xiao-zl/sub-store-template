// =====================
// SubStore 脚本：sing-box 1.14.x 配置构建
// 功能：自定义规则 + Tailscale + Tailscale DNS + 公司内网本地 DNS + 去广告 + SSID 自动回家
//
// 推荐 SubStore 参数：
// tskey=你的_tailscale_auth_key
// github_proxy=你的_GitHub_代理前缀
// home_cidr=10.10.10.0/24
// home_wifi_ssid=ZTE-SuNthc-5G
// corp_dns=10.169.1.9
// corp_domain=longshine.com
// corp_cidrs=10.111.14.0/24,10.103.0.0/16,...
// corp_route_excludes=10.111.14.0/24,10.103.0.0/16,...
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
const RULE_SET_HTTP_CLIENT_TAG = "rule-set-direct";
const LEGACY_RULE_SET_HTTP_CLIENT_TAG = "rule-set-proxy";
const LEGACY_TS_TAG = "ts-ep";
const LEGACY_SUBNET_TAG = "TS-SUBNET";
const DEFAULT_HOME_CIDR = "10.10.10.0/24";
const DEFAULT_CORP_CIDRS = [
  "10.100.0.0/16",
  "10.101.0.0/16",
  "10.102.0.0/16",
  "10.103.0.0/16",
  "10.104.0.0/16",
  "10.107.0.0/16",
  "10.111.0.0/16",
  "10.114.0.0/16",
  "10.120.0.0/16",
  "10.121.0.0/16",
  "10.122.0.0/16",
  "10.123.0.0/16",
  "10.130.0.0/16",
  "10.141.0.0/16",
  "10.143.0.0/16",
  "10.144.0.0/16",
  "10.145.0.0/16",
  "10.147.0.0/16",
  "10.152.0.0/16",
  "10.169.0.0/16",
  "14.103.75.35/32",
  "14.103.124.237/32",
  "14.103.125.142/32",
  "14.103.125.174/32",
  "36.150.163.71/32",
  "36.150.163.102/32",
  "36.150.163.124/32",
  "36.150.163.143/32",
  "36.155.71.29/32",
  "39.100.94.1/32",
  "47.92.230.156/32",
  "47.92.246.166/32",
  "47.123.119.244/32",
  "111.1.36.223/32",
  "111.13.42.102/32",
  "111.32.162.55/32",
  "111.40.199.39/32",
  "111.40.199.160/32",
  "112.25.75.11/32",
  "112.25.75.27/32",
  "112.25.75.35/32",
  "115.190.253.161/32",
  "115.190.253.185/32",
  "115.190.253.188/32",
  "115.191.28.195/32",
  "117.157.22.4/32",
  "172.18.0.0/16",
  "172.19.1.0/24",
  "172.19.18.0/24",
  "172.20.0.0/16",
  "172.22.0.0/16",
  "172.26.0.0/16",
  "180.184.162.180/32",
  "180.184.172.202/32",
  "183.224.42.187/32",
  "183.230.101.8/32",
  "183.230.101.15/32",
  "198.18.0.0/16",
  "211.136.31.147/32",
  "218.205.80.28/32",
  "218.206.26.122/32",
  "218.207.221.14/32",
  "221.181.205.206/32"
];
const DEFAULT_CORP_ROUTE_EXCLUDES = DEFAULT_CORP_CIDRS;

const tskey = $arguments.tskey;
const githubProxy = String($arguments.github_proxy || "").trim().replace(/\/+$/, "");

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

const applyGitHubProxy = url => {
  if (!url) return url;
  const rawUrl = url
    .replace(
      "https://fastly.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@sing/",
      "https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/refs/heads/sing/",
    )
    .replace(
      "https://fastly.jsdelivr.net/gh/SagerNet/sing-geosite@rule-set/",
      "https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set/",
    );
  const rawIndex = rawUrl.indexOf("https://raw.githubusercontent.com/");
  if (rawIndex < 0) return rawUrl;
  const normalizedUrl = rawUrl.slice(rawIndex);
  return githubProxy ? `${githubProxy}/${normalizedUrl}` : normalizedUrl;
};

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
if (ruleSetHttpClient) delete ruleSetHttpClient.detour;
else config.http_clients.push({ tag: RULE_SET_HTTP_CLIENT_TAG });
config.route.default_http_client = RULE_SET_HTTP_CLIENT_TAG;

for (const ruleSet of config.route.rule_set) {
  ruleSet.url = applyGitHubProxy(ruleSet.url);
  delete ruleSet.download_detour;
  if (ruleSet.http_client?.detour) {
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
    server.inet4_range = "198.19.0.0/16";
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

  if (inbound.platform?.http_proxy) {
    inbound.platform.http_proxy.enabled = false;
  }

  // IPv4 only：删除 TUN IPv6 地址
  if (Array.isArray(inbound.address)) {
    inbound.address = inbound.address.filter(a => !String(a).includes(":"));
  }

  // 使用较宽前缀，保证公司 VPN 安装的 /32 路由优先于 TUN 排除路由。
  const excludeList = [
    "127.0.0.0/8",
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
  url: applyGitHubProxy("https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set/geosite-category-ads-all.srs")
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
