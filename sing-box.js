const { type, name } = $arguments
const compatible_outbound = {
  tag: 'COMPATIBLE',
  type: 'direct',
}

let compatible
const parser = typeof ProxyUtils !== 'undefined' && ProxyUtils.JSON5 ? ProxyUtils.JSON5 : JSON
let config
try {
  config = parser.parse(typeof $content !== 'undefined' && $content ? $content : $files[0])
} catch (error) {
  throw new Error(`配置文件不是合法的 JSON${parser === JSON ? '' : '5'}: ${error.message || error}`)
}

const data = JSON.parse(await produceArtifact({
  name,
  type: /^1$|col/i.test(type) ? 'collection' : 'subscription',
  platform: 'sing-box',
}))
const outbounds = data.outbounds || []
const endpoints = data.endpoints || []
const proxies = [...outbounds, ...endpoints]
// shortcut: auto groups test the first 3 matching nodes; add ranking before raising the limit.
const AUTO_TEST_LIMIT = 3

config.outbounds = config.outbounds || []
config.endpoints = config.endpoints || []
config.outbounds.push(...outbounds)
config.endpoints.push(...endpoints)

config.outbounds.map(i => {
  const autoLimit = i.type === 'urltest' ? AUTO_TEST_LIMIT : undefined
  if (i.tag === 'all') {
    i.outbounds.push(...getTags(proxies))
  }
  if (['hk', 'hk-auto'].includes(i.tag)) {
    i.outbounds.push(...getTags(proxies, /港|hk|hongkong|hong kong|🇭🇰/i, autoLimit))
  }
  if (['tw', 'tw-auto'].includes(i.tag)) {
    i.outbounds.push(...getTags(proxies, /台|tw|taiwan|🇹🇼/i, autoLimit))
  }
  if (['jp', 'jp-auto'].includes(i.tag)) {
    i.outbounds.push(...getTags(proxies, /日本|jp|japan|🇯🇵/i, autoLimit))
  }
  if (['sg', 'sg-auto'].includes(i.tag)) {
    i.outbounds.push(...getTags(proxies, /^(?!.*(?:us)).*(新|sg|singapore|🇸🇬)/i, autoLimit))
  }
  if (['us', 'us-auto'].includes(i.tag)) {
    i.outbounds.push(...getTags(proxies, /美|us|unitedstates|united states|🇺🇸/i, autoLimit))
  }
})

config.outbounds.forEach(outbound => {
  if (Array.isArray(outbound.outbounds) && outbound.outbounds.length === 0) {
    if (!compatible) {
      config.outbounds.push(compatible_outbound)
      compatible = true
    }
    outbound.outbounds.push(compatible_outbound.tag);
  }
});

$content = JSON.stringify(config, null, 2)

function getTags(proxies, regex, limit) {
  const tags = (regex ? proxies.filter(p => regex.test(p.tag)) : proxies).map(p => p.tag)
  return limit === undefined ? tags : tags.slice(0, limit)
}
