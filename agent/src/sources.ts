// URL discovery from crypto news sources
//
// Sources (planned):
//   - RSS feeds: CoinDesk, The Block, Bankless, Blockworks
//   - Crypto Twitter: notable accounts via Neynar or direct API
//   - On-chain: governance proposals (Tally, Snapshot)
//   - Protocol blogs: official announcement feeds

export interface DiscoveredUrl {
  url: string
  source: string
  title?: string
  discoveredAt: number   // unix ms
}

// ── Known RSS feeds ──────────────────────────────────────────────────────────

const RSS_FEEDS = [
  'https://www.coindesk.com/arc/outboundfeeds/rss/',
  'https://www.theblock.co/rss.xml',
  'https://feeds.banklesshq.com/podcast',
  'https://blockworks.co/feed',
] as const

// ── Main discovery ───────────────────────────────────────────────────────────

export async function discoverUrls(): Promise<DiscoveredUrl[]> {
  const urls: DiscoveredUrl[] = []

  urls.push(...(await fetchRssFeeds()))
  // TODO: add Twitter, governance, protocol blog sources

  return urls
}

// ── RSS ──────────────────────────────────────────────────────────────────────

async function fetchRssFeeds(): Promise<DiscoveredUrl[]> {
  // TODO: fetch each feed, parse XML, extract <item> links
  // Consider using a lightweight XML parser (e.g. fast-xml-parser)
  const _feeds = RSS_FEEDS
  return []
}
