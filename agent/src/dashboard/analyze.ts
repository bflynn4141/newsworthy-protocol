// Article analysis via any OpenAI-compatible LLM endpoint.
// Works with: Ollama, LM Studio, vLLM, OpenRouter, OpenAI, Anthropic, etc.
// Gracefully degrades if no LLM is available or URL fetch fails.
//
// Config (env vars):
//   NEWSWORTHY_LLM_URL    — Base URL (default: http://localhost:11434)
//   NEWSWORTHY_LLM_MODEL  — Model name (default: llama3.2:3b)
//   NEWSWORTHY_LLM_KEY    — API key (optional, for cloud providers)

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve as pathResolve } from 'node:path'
import { privateKeyToAccount } from 'viem/accounts'
import type { FeedItem } from './useFeedData.js'

// ── Types ────────────────────────────────────────────────────────────────────

export type ArticleAnalysis = {
  // Composite
  score: number            // 1-10 weighted composite
  summary: string          // One sentence (max 80 chars)
  // Sub-scores
  articleScore: number     // 1-10 content quality
  sourceScore: number      // 1-10 source/domain reputation
  submitterScore: number   // 1-10 on-chain accept/reject ratio
  uniquenessScore: number  // 1-10 novelty vs recent items
  // Detail
  reliability: string      // high | medium | low | unknown
  reasoning?: string       // Shown in detail panel only
  // Spam filter
  flagged?: boolean        // true if item is suspected spam/low-quality
  flagReason?: string      // "Unreachable URL" | "Low quality (2.1)" | "Low reliability"
  // Meta
  status: 'done' | 'pending' | 'error'
  error?: string
}

export const SPAM_THRESHOLD = 3.0

// ── Config ───────────────────────────────────────────────────────────────────

const LLM_URL = process.env.NEWSWORTHY_LLM_URL ?? 'http://localhost:11434'
const LLM_MODEL = process.env.NEWSWORTHY_LLM_MODEL ?? 'llama3.2:3b'
const LLM_KEY = process.env.NEWSWORTHY_LLM_KEY ?? ''
const FETCH_TIMEOUT = 5_000
const LLM_TIMEOUT = 30_000

// ── Cache ────────────────────────────────────────────────────────────────────

const analysisCache = new Map<number, ArticleAnalysis>()
const summaryCache = new Map<number, string>() // for uniqueness checks
let llmAvailable: boolean | null = null
let llmModel: string | null = null
let diskCachePromise: Promise<void> | null = null

const CACHE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.cache')
const CACHE_FILE = join(CACHE_DIR, 'analyses.json')

async function loadDiskCache(): Promise<void> {
  if (!diskCachePromise) {
    diskCachePromise = (async () => {
      try {
        const raw = await readFile(CACHE_FILE, 'utf-8')
        const entries = JSON.parse(raw) as Record<string, ArticleAnalysis>
        for (const [key, value] of Object.entries(entries)) {
          const id = Number(key)
          if (value.status === 'done') {
            analysisCache.set(id, value)
            if (value.summary) summaryCache.set(id, value.summary)
          }
        }
      } catch {
        // No cache file yet — that's fine
      }
    })()
  }
  return diskCachePromise
}

async function saveDiskCache(): Promise<void> {
  const entries: Record<string, ArticleAnalysis> = {}
  for (const [id, analysis] of analysisCache) {
    if (analysis.status === 'done') entries[id] = analysis
  }
  try {
    await mkdir(CACHE_DIR, { recursive: true })
    await writeFile(CACHE_FILE, JSON.stringify(entries, null, 2))
  } catch {
    // Non-critical — worst case we re-analyze next time
  }
}

export function getCachedAnalysis(itemId: number): ArticleAnalysis | undefined {
  return analysisCache.get(itemId)
}

export function getLlmStatus(): { available: boolean; model: string | null } {
  return { available: llmAvailable === true, model: llmModel }
}

// ── Twitter/X via x402 ──────────────────────────────────────────────────────

const TWITTER_URL_RE = /^https?:\/\/(?:(?:www\.)?(?:twitter|x)\.com)\/(\w+)\/status\/(\d+)/

function extractTweetId(url: string): string | null {
  const match = url.match(TWITTER_URL_RE)
  return match ? match[2] : null
}

let x402HttpClient: any = null
let x402InitAttempted = false

async function initX402() {
  if (x402HttpClient) return x402HttpClient
  if (x402InitAttempted) return null
  x402InitAttempted = true

  try {
    // Load private key from env var or ~/.newsworthy/agent.key
    let rawKey = process.env['NEWSWORTHY_PRIVATE_KEY']
    if (!rawKey) {
      const homedir = process.env['HOME'] ?? process.env['USERPROFILE'] ?? '~'
      const keyPath = pathResolve(homedir, '.newsworthy', 'agent.key')
      rawKey = (await readFile(keyPath, 'utf-8')).trim()
    }
    const privateKey = (rawKey.startsWith('0x') ? rawKey : `0x${rawKey}`) as `0x${string}`
    const account = privateKeyToAccount(privateKey)

    // @ts-expect-error — x402 is an optional dependency
    const { x402Client, x402HTTPClient } = await import('@x402/core/client')
    // @ts-expect-error — x402 is an optional dependency
    const { ExactEvmScheme } = await import('@x402/evm/exact/client')

    const coreClient = x402Client.fromConfig({
      schemes: [{ network: 'eip155:8453', client: new ExactEvmScheme(account) }],
    })
    x402HttpClient = new x402HTTPClient(coreClient)
    return x402HttpClient
  } catch {
    return null
  }
}

async function fetchTweetText(tweetId: string): Promise<string | null> {
  const client = await initX402()
  if (!client) return null

  try {
    const url = `https://x402.twit.sh/tweets/by/id?id=${tweetId}`

    // Step 1: Get 402 + payment requirements
    const initialRes = await fetch(url)
    if (initialRes.status !== 402) return null
    const body = await initialRes.text()
    const getHeader = (name: string) => initialRes.headers.get(name)

    // Step 2: Parse requirements, sign payment
    const paymentRequired = client.getPaymentRequiredResponse(getHeader, body)
    const paymentPayload = await client.createPaymentPayload(paymentRequired)
    const paymentHeaders = client.encodePaymentSignatureHeader(paymentPayload)

    // Step 3: Retry with payment
    const paidRes = await fetch(url, { headers: paymentHeaders })
    if (!paidRes.ok) return null

    const data = await paidRes.json() as { data?: { text?: string; author?: { username?: string; name?: string } } }
    const tweet = data.data
    if (!tweet?.text) return null
    const author = tweet.author?.username ?? tweet.author?.name ?? 'Unknown'
    return `Tweet by @${author}: ${tweet.text}`
  } catch {
    return null
  }
}

// ── LLM Detection ───────────────────────────────────────────────────────────

export async function detectLlm(): Promise<boolean> {
  if (llmAvailable !== null) return llmAvailable

  // If an API key is set, assume the endpoint works (cloud provider)
  if (LLM_KEY) {
    llmAvailable = true
    llmModel = LLM_MODEL
    return true
  }

  // For local servers, probe for availability
  // Try OpenAI-compatible /v1/models first, then Ollama's /api/tags
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 3000)

    // Try /v1/models (works with LM Studio, vLLM, Ollama >=0.1.14)
    let res = await fetch(`${LLM_URL}/v1/models`, { signal: controller.signal })

    if (res.ok) {
      const data = await res.json() as { data?: { id: string }[] }
      const models = data.data ?? []
      const match = models.find(m => m.id === LLM_MODEL || m.id.startsWith(LLM_MODEL + ':'))
      llmModel = match?.id ?? models[0]?.id ?? LLM_MODEL
      llmAvailable = true
      clearTimeout(timer)
      return true
    }

    // Fallback: try Ollama's native /api/tags
    res = await fetch(`${LLM_URL}/api/tags`, { signal: controller.signal })
    clearTimeout(timer)

    if (res.ok) {
      const data = await res.json() as { models?: { name: string }[] }
      const models = data.models ?? []
      const match = models.find(m => m.name === LLM_MODEL || m.name.startsWith(LLM_MODEL + ':'))
      llmModel = match?.name ?? models[0]?.name ?? null
      llmAvailable = llmModel !== null
      return llmAvailable
    }

    llmAvailable = false
    return false
  } catch {
    llmAvailable = false
    return false
  }
}

// ── URL Fetching + Text Extraction ───────────────────────────────────────────

async function fetchArticleText(url: string): Promise<string | null> {
  // Twitter/X URLs: use x402 twit.sh
  const tweetId = extractTweetId(url)
  if (tweetId) {
    return fetchTweetText(tweetId)
  }

  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT)
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Newsworthy/0.1 (article-analysis)' },
    })
    clearTimeout(timer)

    if (!res.ok) return null

    const html = await res.text()
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ')
      .trim()

    return text.slice(0, 2000)
  } catch {
    return null
  }
}

// ── LLM Call (OpenAI-compatible) ─────────────────────────────────────────────

async function callLlm(system: string, user: string): Promise<string | null> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT)

    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (LLM_KEY) headers['Authorization'] = `Bearer ${LLM_KEY}`

    const res = await fetch(`${LLM_URL}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: llmModel ?? LLM_MODEL,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.3,
      }),
      signal: controller.signal,
    })
    clearTimeout(timer)

    if (!res.ok) return null
    const data = await res.json() as { choices?: { message?: { content?: string } }[] }
    return data.choices?.[0]?.message?.content ?? null
  } catch {
    return null
  }
}

function parseJsonResponse<T>(raw: string | null): T | null {
  if (!raw) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    const match = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
    if (match) {
      try { return JSON.parse(match[1]) as T } catch { /* fall through */ }
    }
    return null
  }
}

// ── Submitter Reputation (on-chain) ──────────────────────────────────────────

export function computeSubmitterScore(
  submitter: string,
  allItems: FeedItem[],
): number {
  const theirs = allItems.filter(i =>
    i.submitter.toLowerCase() === submitter.toLowerCase()
  )
  const accepted = theirs.filter(i => i.status === 1).length
  const rejected = theirs.filter(i => i.status === 2).length
  const total = accepted + rejected

  if (total === 0) return 3.0 // unproven — must earn credibility
  // Bayesian-style: blend actual ratio with a prior of 3.0
  // More history = more weight on actual performance
  const prior = 3.0
  const priorWeight = 2 // equivalent to 2 "phantom" items at the prior
  const blended = (accepted * 10 + priorWeight * prior) / (total + priorWeight)
  return Math.round(Math.min(10, Math.max(1, blended)) * 10) / 10
}

// ── Main Analysis Function ───────────────────────────────────────────────────

type AnalysisResult = {
  articleScore: number
  sourceScore: number
  summary: string
  reliability: string
  reasoning: string
}

type UniquenessResult = {
  uniquenessScore: number
}

const ANALYSIS_SYSTEM = `You are a news quality analyst. Evaluate articles for newsworthiness, quality, and source reliability. Always respond in valid JSON.`

export async function analyzeItem(
  item: FeedItem,
  allItems: FeedItem[],
): Promise<ArticleAnalysis> {
  // Load disk cache on first call
  await loadDiskCache()

  // Check cache (includes disk-loaded entries)
  const cached = analysisCache.get(item.id)
  if (cached && cached.status !== 'error') return cached

  // Set pending status
  const pending: ArticleAnalysis = {
    score: 0, summary: 'Analyzing...', articleScore: 0,
    sourceScore: 0, submitterScore: 0, uniquenessScore: 0,
    reliability: 'unknown', status: 'pending',
  }
  analysisCache.set(item.id, pending)

  // Compute submitter score (no LLM needed)
  const submitterScore = computeSubmitterScore(item.submitter, allItems)

  // Check LLM
  if (!await detectLlm()) {
    const result: ArticleAnalysis = {
      score: submitterScore, summary: '',
      articleScore: 0, sourceScore: 0, submitterScore, uniquenessScore: 0,
      reliability: 'unknown', status: 'error', error: 'No LLM',
    }
    analysisCache.set(item.id, result)
    return result
  }

  // Fetch article text
  const articleText = await fetchArticleText(item.url)
  if (!articleText) {
    const result: ArticleAnalysis = {
      score: submitterScore, summary: '',
      articleScore: 0, sourceScore: 0, submitterScore, uniquenessScore: 0,
      reliability: 'unknown', status: 'error', error: 'Fetch failed',
      flagged: true, flagReason: 'Unreachable URL',
    }
    analysisCache.set(item.id, result)
    return result
  }

  // Call 1: Article analysis
  const analysisUser = `Analyze this article and provide:
1. An article quality score from 1-10 (writing, sourcing, newsworthiness)
2. A source reputation score from 1-10 (is this domain a known, reliable outlet?)
3. A one-sentence summary (max 80 chars)
4. Source reliability assessment (high, medium, low, or unknown)
5. Brief reasoning (2-3 sentences)

Respond in JSON: {"articleScore":N,"sourceScore":N,"summary":"...","reliability":"...","reasoning":"..."}

Article URL: ${item.url}
Article text:
${articleText}`

  const analysisRaw = await callLlm(ANALYSIS_SYSTEM, analysisUser)
  const analysis = parseJsonResponse<AnalysisResult>(analysisRaw)

  if (!analysis || typeof analysis.articleScore !== 'number') {
    const result: ArticleAnalysis = {
      score: submitterScore, summary: '',
      articleScore: 0, sourceScore: 0, submitterScore, uniquenessScore: 0,
      reliability: 'unknown', status: 'error', error: 'Analysis failed',
    }
    analysisCache.set(item.id, result)
    return result
  }

  // Cache summary for uniqueness checks
  summaryCache.set(item.id, analysis.summary)

  // Call 2: Uniqueness check
  const recentSummaries = Array.from(summaryCache.entries())
    .filter(([id]) => id !== item.id)
    .map(([id, summary]) => `- #${id}: ${summary}`)

  let uniquenessScore = 8.0 // default if no other items to compare
  if (recentSummaries.length > 0) {
    const uniquenessUser = `Rate how unique this new article is compared to recently submitted items.
Score 1-10 where 10 = completely novel topic, 1 = exact duplicate.

New article: "${analysis.summary}"

Recent items:
${recentSummaries.join('\n')}

Respond in JSON: {"uniquenessScore":N}`

    const uniquenessRaw = await callLlm(ANALYSIS_SYSTEM, uniquenessUser)
    const uniqueness = parseJsonResponse<UniquenessResult>(uniquenessRaw)
    if (uniqueness && typeof uniqueness.uniquenessScore === 'number') {
      uniquenessScore = Math.min(10, Math.max(1, uniqueness.uniquenessScore))
    }
  }

  // Compute composite: 30% article + 25% source + 20% submitter + 25% uniqueness
  const composite = (
    0.30 * Math.min(10, Math.max(1, analysis.articleScore)) +
    0.25 * Math.min(10, Math.max(1, analysis.sourceScore)) +
    0.20 * submitterScore +
    0.25 * uniquenessScore
  )

  const finalScore = Math.round(composite * 10) / 10
  const finalReliability = analysis.reliability ?? 'unknown'

  // Spam flagging
  let flagged = false
  let flagReason: string | undefined = undefined
  if (finalScore < SPAM_THRESHOLD) {
    flagged = true
    flagReason = `Low quality (${finalScore})`
  } else if (finalReliability === 'low' && finalScore < 5.0) {
    flagged = true
    flagReason = 'Low reliability'
  }

  const result: ArticleAnalysis = {
    score: finalScore,
    summary: (analysis.summary ?? '').slice(0, 80),
    articleScore: Math.round(analysis.articleScore * 10) / 10,
    sourceScore: Math.round(analysis.sourceScore * 10) / 10,
    submitterScore,
    uniquenessScore: Math.round(uniquenessScore * 10) / 10,
    reliability: finalReliability,
    reasoning: analysis.reasoning,
    ...(flagged ? { flagged, flagReason: flagReason! } : {}),
    status: 'done',
  }

  analysisCache.set(item.id, result)
  saveDiskCache() // fire-and-forget — persist for next session
  return result
}
