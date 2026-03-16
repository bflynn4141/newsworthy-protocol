import { useState, useEffect, useRef, useCallback } from 'react'
import { type Address, type PublicClient } from 'viem'
import { FEED_REGISTRY_ABI, ERC20_ABI } from '../curate.js'
import { AGENTBOOK_ABI } from '../register.js'
import { analyzeItem, getCachedAnalysis, detectLlm, getLlmStatus, type ArticleAnalysis } from './analyze.js'

// ── Types ────────────────────────────────────────────────────────────────────

export type ItemStatus = 'pending' | 'accepted' | 'rejected'

export type FeedItem = {
  id: number
  submitter: Address
  submitterHumanId: bigint
  url: string
  metadataHash: string
  bond: bigint
  voteCostSnapshot: bigint
  submittedAt: bigint
  status: number
  // Computed
  timeRemaining: number // seconds, -1 if N/A
  // Vote session data (only for status=0, populated from getVoteSession)
  voteSession?: {
    votesFor: bigint
    votesAgainst: bigint
    keepClaimPerVoter: bigint
    removeClaimPerVoter: bigint
  }
  // Analysis (populated async)
  analysis?: ArticleAnalysis
}

export type RegistryConfig = {
  bondAmount: bigint
  voteCost: bigint
  votingPeriod: bigint
  minVotes: bigint
  bondToken: Address
  tokenSymbol: string
  tokenDecimals: number
  newsToken: Address
  newsPerItem: bigint
  maxDailySubmissions: bigint
}

export type LlmStatus = {
  available: boolean
  model: string | null
}

export type FeedData = {
  config: RegistryConfig | null
  balance: bigint
  newsBalance: bigint
  withdrawable: bigint
  totalItems: number
  dailySubmissions: number // how many submitted today
  dailyResetIn: number    // seconds until daily reset (midnight UTC)
  items: Record<ItemStatus, FeedItem[]>
  flaggedCount: number
  loading: boolean
  lastRefresh: number // seconds ago
  error: string | null
  llm: LlmStatus
}

// ── Status mapping ───────────────────────────────────────────────────────────

const STATUS_MAP: Record<number, ItemStatus> = {
  0: 'pending',
  1: 'accepted',
  2: 'rejected',
}

// ── Hook ─────────────────────────────────────────────────────────────────────

export function useFeedData(
  client: PublicClient,
  registryAddr: Address,
  agentBookAddr: Address,
  deployer: Address,
  refreshMs = 5000,
): FeedData {
  const [config, setConfig] = useState<RegistryConfig | null>(null)
  const [balance, setBalance] = useState(0n)
  const [newsBalance, setNewsBalance] = useState(0n)
  const [withdrawable, setWithdrawable] = useState(0n)
  const [totalItems, setTotalItems] = useState(0)
  const [dailySubmissions, setDailySubmissions] = useState(0)
  const [items, setItems] = useState<Record<ItemStatus, FeedItem[]>>({
    pending: [], accepted: [], rejected: [],
  })
  const [loading, setLoading] = useState(true)
  const [lastRefreshTime, setLastRefreshTime] = useState(Date.now())
  const [now, setNow] = useState(Date.now())
  const [error, setError] = useState<string | null>(null)
  const [llm, setLlm] = useState<LlmStatus>({ available: false, model: null })
  const [analysisVersion, setAnalysisVersion] = useState(0) // bump to trigger re-render

  // Cache terminal-state items (accepted/rejected don't change)
  const terminalCache = useRef<Map<number, FeedItem>>(new Map())
  const configFetchedAt = useRef(0)
  const analyzedIds = useRef<Set<number>>(new Set())

  // Detect Ollama on mount
  useEffect(() => {
    detectLlm().then(() => setLlm(getLlmStatus()))
  }, [])

  // 1-second tick for countdowns + "last refresh" display
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  // Trigger background analysis for new items
  const triggerAnalysis = useCallback((allItems: FeedItem[]) => {
    for (const item of allItems) {
      if (analyzedIds.current.has(item.id)) continue
      analyzedIds.current.add(item.id)

      // Fire and forget — analysis runs in background
      analyzeItem(item, allItems).then(() => {
        setAnalysisVersion(v => v + 1) // trigger re-render when done
      })
    }
  }, [])

  // Data fetch on interval
  useEffect(() => {
    let mounted = true

    async function fetchData() {
      try {
        // Fetch config every 60s
        let cfg = config
        if (!cfg || Date.now() - configFetchedAt.current > 60_000) {
          const [bondAmount, voteCost, votingPeriod, minVotes, bondToken, newsToken, newsPerItem, maxDailySubmissions] = await Promise.all([
            client.readContract({ address: registryAddr, abi: FEED_REGISTRY_ABI, functionName: 'bondAmount' }),
            client.readContract({ address: registryAddr, abi: FEED_REGISTRY_ABI, functionName: 'voteCost' }),
            client.readContract({ address: registryAddr, abi: FEED_REGISTRY_ABI, functionName: 'votingPeriod' }),
            client.readContract({ address: registryAddr, abi: FEED_REGISTRY_ABI, functionName: 'minVotes' }),
            client.readContract({ address: registryAddr, abi: FEED_REGISTRY_ABI, functionName: 'bondToken' }),
            client.readContract({ address: registryAddr, abi: FEED_REGISTRY_ABI, functionName: 'newsToken' }),
            client.readContract({ address: registryAddr, abi: FEED_REGISTRY_ABI, functionName: 'newsPerItem' }),
            client.readContract({ address: registryAddr, abi: FEED_REGISTRY_ABI, functionName: 'maxDailySubmissions' }),
          ])
          const tokenAddr = bondToken as Address
          const [tokenSymbol, tokenDecimals] = await Promise.all([
            client.readContract({ address: tokenAddr, abi: ERC20_ABI, functionName: 'symbol' }) as Promise<string>,
            client.readContract({ address: tokenAddr, abi: ERC20_ABI, functionName: 'decimals' }) as Promise<number>,
          ])
          cfg = {
            bondAmount: bondAmount as bigint,
            voteCost: voteCost as bigint,
            votingPeriod: votingPeriod as bigint,
            minVotes: minVotes as bigint,
            bondToken: tokenAddr,
            tokenSymbol,
            tokenDecimals,
            newsToken: newsToken as Address,
            newsPerItem: newsPerItem as bigint,
            maxDailySubmissions: maxDailySubmissions as bigint,
          }
          if (mounted) {
            setConfig(cfg)
            configFetchedAt.current = Date.now()
          }
        }

        // Always fetch: nextItemId, balance, withdrawable, $NEWS balance, daily submissions
        const tokenAddr = cfg?.bondToken
        const newsAddr = cfg?.newsToken
        const today = BigInt(Math.floor(Date.now() / 1000 / 86400))
        const [nextId, bal, newsBal, pending, humanId] = await Promise.all([
          client.readContract({ address: registryAddr, abi: FEED_REGISTRY_ABI, functionName: 'nextItemId' }) as Promise<bigint>,
          tokenAddr
            ? client.readContract({ address: tokenAddr, abi: ERC20_ABI, functionName: 'balanceOf', args: [deployer] }) as Promise<bigint>
            : Promise.resolve(0n),
          newsAddr
            ? client.readContract({ address: newsAddr, abi: ERC20_ABI, functionName: 'balanceOf', args: [deployer] }) as Promise<bigint>
            : Promise.resolve(0n),
          client.readContract({ address: registryAddr, abi: FEED_REGISTRY_ABI, functionName: 'pendingWithdrawals', args: [deployer] }) as Promise<bigint>,
          client.readContract({ address: agentBookAddr, abi: AGENTBOOK_ABI, functionName: 'lookupHuman', args: [deployer] }) as Promise<bigint>,
        ])

        let dailySubs = 0
        if (humanId > 0n) {
          dailySubs = Number(await client.readContract({
            address: registryAddr, abi: FEED_REGISTRY_ABI, functionName: 'dailySubmissions',
            args: [humanId, today],
          }) as bigint)
        }

        const count = Number(nextId)
        if (mounted) {
          setTotalItems(count)
          setBalance(bal)
          setNewsBalance(newsBal)
          setWithdrawable(pending)
          setDailySubmissions(dailySubs)
        }

        // Fetch items (skip terminal-state items that are already cached)
        const nowSec = BigInt(Math.floor(Date.now() / 1000))
        const buckets: Record<ItemStatus, FeedItem[]> = {
          pending: [], accepted: [], rejected: [],
        }

        const allFetched: FeedItem[] = []
        const itemPromises: Promise<void>[] = []
        for (let i = 0; i < count; i++) {
          const cached = terminalCache.current.get(i)
          if (cached) {
            const status = STATUS_MAP[cached.status] ?? 'rejected'
            buckets[status].push(cached)
            allFetched.push(cached)
            continue
          }

          itemPromises.push(
            (async () => {
              const raw = await client.readContract({
                address: registryAddr, abi: FEED_REGISTRY_ABI, functionName: 'items', args: [BigInt(i)],
              }) as [Address, bigint, string, string, bigint, bigint, bigint, number]

              const [submitter, submitterHumanId, url, metadataHash, bond, voteCostSnapshot, submittedAt, status] = raw
              const statusKey = STATUS_MAP[status] ?? 'rejected'

              let timeRemaining = -1
              if (status === 0 && cfg) {
                const end = submittedAt + cfg.votingPeriod
                timeRemaining = Math.max(0, Number(end - nowSec))
              }

              const item: FeedItem = {
                id: i, submitter, submitterHumanId, url, metadataHash, bond, voteCostSnapshot, submittedAt, status, timeRemaining,
              }

              // Fetch vote session data for voting items
              if (status === 0 && cfg) {
                const vRaw = await client.readContract({
                  address: registryAddr, abi: FEED_REGISTRY_ABI, functionName: 'getVoteSession', args: [BigInt(i)],
                }) as [bigint, bigint, bigint, bigint]
                const [votesFor, votesAgainst, keepClaimPerVoter, removeClaimPerVoter] = vRaw
                item.voteSession = { votesFor, votesAgainst, keepClaimPerVoter, removeClaimPerVoter }
              }

              // Cache terminal-state items (1=Accepted, 2=Rejected)
              if (status === 1 || status === 2) {
                terminalCache.current.set(i, item)
              }

              buckets[statusKey].push(item)
              allFetched.push(item)
            })(),
          )
        }

        await Promise.all(itemPromises)

        // Sort each bucket by ID descending (newest first)
        for (const key of Object.keys(buckets) as ItemStatus[]) {
          buckets[key].sort((a, b) => b.id - a.id)
        }

        if (mounted) {
          setItems(buckets)
          setLastRefreshTime(Date.now())
          setLoading(false)
          setError(null)

          // Trigger background analysis for any new items
          triggerAnalysis(allFetched)
        }
      } catch (err: any) {
        if (mounted) {
          setError(err?.shortMessage ?? err?.message ?? String(err))
          setLoading(false)
        }
      }
    }

    fetchData()
    const id = setInterval(fetchData, refreshMs)
    return () => { mounted = false; clearInterval(id) }
  }, [client, registryAddr, agentBookAddr, deployer, refreshMs])

  // Recompute time-remaining fields on every 1s tick + attach analysis from cache
  const nowSec = Math.floor(now / 1000)
  const liveItems = { ...items }

  // Attach cached analysis to all items
  function attachAnalysis(list: FeedItem[]): FeedItem[] {
    return list.map(item => {
      const analysis = getCachedAnalysis(item.id)
      return analysis ? { ...item, analysis } : item
    })
  }

  if (config) {
    liveItems.pending = attachAnalysis(items.pending.map(item => ({
      ...item,
      timeRemaining: Math.max(0, Number(item.submittedAt + config.votingPeriod) - nowSec),
    })))
    liveItems.accepted = attachAnalysis(items.accepted)
    liveItems.rejected = attachAnalysis(items.rejected)
  } else {
    for (const key of Object.keys(liveItems) as ItemStatus[]) {
      liveItems[key] = attachAnalysis(liveItems[key])
    }
  }

  // Count flagged items across all buckets
  let flaggedCount = 0
  for (const key of Object.keys(liveItems) as ItemStatus[]) {
    flaggedCount += liveItems[key].filter(i => i.analysis?.flagged).length
  }

  // Seconds until next UTC midnight
  const nowMs = now
  const nextMidnight = Math.ceil(nowMs / 86400000) * 86400000
  const dailyResetIn = Math.max(0, Math.floor((nextMidnight - nowMs) / 1000))

  return {
    config,
    balance,
    newsBalance,
    withdrawable,
    totalItems,
    dailySubmissions,
    dailyResetIn,
    items: liveItems,
    flaggedCount,
    loading,
    lastRefresh: Math.floor((now - lastRefreshTime) / 1000),
    error,
    llm,
  }
}
