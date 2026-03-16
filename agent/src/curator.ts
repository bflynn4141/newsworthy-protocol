// Curator Agent — autonomous curation loop for FeedRegistryV2
//
// Watches the registry, analyzes new submissions, and takes action:
//   - Votes on pending items (keep/remove based on analysis, costs voteCost USDC)
//   - Resolves expired voting periods
//   - Claims payouts after resolution
//
// Usage:
//   bun run agent/src/curator.ts [--test] [--dry-run] [--vote-threshold 5.0]
//
// The agent needs:
//   - A funded wallet (NEWSWORTHY_PRIVATE_KEY env var or ~/.newsworthy/agent.key)
//   - Registration in AgentBook (World ID or MockAgentBook)
//   - An LLM endpoint (Ollama, OpenRouter, etc.) for analysis

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve as pathResolve, dirname } from 'node:path'
import { parseArgs } from 'node:util'
import {
  createPublicClient,
  createWalletClient,
  http,
  formatEther,
  formatUnits,
  type Address,
  type PublicClient,
  type WalletClient,
  type Chain,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { worldchain } from 'viem/chains'
import { FEED_REGISTRY_ABI, ERC20_ABI } from './curate.js'
import { AGENTBOOK_ABI } from './register.js'
import { analyzeItem, detectLlm, getLlmStatus, type ArticleAnalysis } from './dashboard/analyze.js'
import type { FeedItem } from './dashboard/useFeedData.js'

// ── Types ──────────────────────────────────────────────────────────────────

type Deployment = {
  rpc: string
  writeRpc?: string
  deployer: string
  contracts: {
    AgentBook: { address: string }
    FeedRegistry: { address: string }
  }
}

type RegistryConfig = {
  bondAmount: bigint
  voteCost: bigint
  votingPeriod: bigint
  minVotes: bigint
  bondToken: Address
  tokenSymbol: string
  tokenDecimals: number
  newsPerItem: bigint
  maxDailySubmissions: bigint
}

export type CuratorConfig = {
  voteThreshold: number       // vote REMOVE if below, KEEP if above (default: 5.0)
  autoResolve: boolean        // resolve expired voting periods (default: true)
  autoClaim: boolean          // claim payouts after resolution (default: true)
  dryRun: boolean             // log decisions without sending transactions
  pollIntervalMs: number      // how often to scan (default: 30000)
}

type ActionLog = {
  timestamp: number
  action: string
  itemId: number
  reason: string
  txHash?: string
}

// ── Constants ──────────────────────────────────────────────────────────────

const STATUS_VOTING = 0
const STATUS_ACCEPTED = 1
const STATUS_REJECTED = 2

const BOLD = '\x1b[1m'
const DIM = '\x1b[90m'
const GREEN = '\x1b[32m'
const YELLOW = '\x1b[33m'
const RED = '\x1b[31m'
const CYAN = '\x1b[36m'
const RESET = '\x1b[0m'

// ── Helpers ────────────────────────────────────────────────────────────────

function log(prefix: string, msg: string) {
  const time = new Date().toLocaleTimeString('en-US', { hour12: false })
  console.log(`${DIM}${time}${RESET} ${prefix} ${msg}`)
}

function logAction(msg: string) { log(`${GREEN}ACT${RESET}`, msg) }
function logSkip(msg: string) { log(`${DIM}---${RESET}`, msg) }
function logInfo(msg: string) { log(`${CYAN}INF${RESET}`, msg) }
function logWarn(msg: string) { log(`${YELLOW}WRN${RESET}`, msg) }
function logError(msg: string) { log(`${RED}ERR${RESET}`, msg) }

// ── Bundled addresses ────────────────────────────────────────────────────────
const DEFAULT_ADDRESSES = {
  chainId: 480,
  feedRegistry: '0xb2d538D2BD69a657A5240c446F0565a7F5d52BBF',
  agentBook: '0xd4c3680c8cd5Ef45F5AbA9402e32D0561A1401cc',
  rpc: 'https://worldchain-mainnet.g.alchemy.com/public',
}

async function loadDeployment(_test: boolean): Promise<Deployment> {
  const rpc = process.env['NEWSWORTHY_RPC_URL'] ?? DEFAULT_ADDRESSES.rpc

  let addresses = DEFAULT_ADDRESSES
  try {
    const thisDir = dirname(fileURLToPath(import.meta.url))
    const addrPath = pathResolve(thisDir, '../../addresses.json')
    const text = await readFile(addrPath, 'utf-8')
    const parsed = JSON.parse(text) as Record<string, typeof DEFAULT_ADDRESSES>
    const mainnet = parsed['worldchain-mainnet']
    if (mainnet) addresses = mainnet
  } catch {
    // Use bundled defaults
  }

  const key = await loadPrivateKey()
  const account = privateKeyToAccount(key)

  return {
    rpc,
    deployer: account.address,
    contracts: {
      AgentBook: { address: addresses.agentBook },
      FeedRegistry: { address: addresses.feedRegistry },
    },
  }
}

async function loadPrivateKey(): Promise<`0x${string}`> {
  const envKey = process.env['NEWSWORTHY_PRIVATE_KEY']
  if (envKey) {
    if (!envKey.startsWith('0x')) return `0x${envKey}` as `0x${string}`
    return envKey as `0x${string}`
  }

  try {
    const homedir = process.env['HOME'] ?? process.env['USERPROFILE'] ?? '~'
    const keyPath = pathResolve(homedir, '.newsworthy', 'agent.key')
    const key = (await readFile(keyPath, 'utf-8')).trim()
    if (!key.startsWith('0x')) return `0x${key}` as `0x${string}`
    return key as `0x${string}`
  } catch {
    console.error('\x1b[31mError:\x1b[0m No private key found. Set NEWSWORTHY_PRIVATE_KEY env var or create ~/.newsworthy/agent.key')
    process.exit(1)
  }
}

// ── Registry Reader ────────────────────────────────────────────────────────

async function fetchConfig(client: PublicClient, registry: Address): Promise<RegistryConfig> {
  const [bondAmount, voteCost, votingPeriod, minVotes, bondToken, newsPerItem, maxDailySubmissions] = await Promise.all([
    client.readContract({ address: registry, abi: FEED_REGISTRY_ABI, functionName: 'bondAmount' }) as Promise<bigint>,
    client.readContract({ address: registry, abi: FEED_REGISTRY_ABI, functionName: 'voteCost' }) as Promise<bigint>,
    client.readContract({ address: registry, abi: FEED_REGISTRY_ABI, functionName: 'votingPeriod' }) as Promise<bigint>,
    client.readContract({ address: registry, abi: FEED_REGISTRY_ABI, functionName: 'minVotes' }) as Promise<bigint>,
    client.readContract({ address: registry, abi: FEED_REGISTRY_ABI, functionName: 'bondToken' }) as Promise<Address>,
    client.readContract({ address: registry, abi: FEED_REGISTRY_ABI, functionName: 'newsPerItem' }) as Promise<bigint>,
    client.readContract({ address: registry, abi: FEED_REGISTRY_ABI, functionName: 'maxDailySubmissions' }) as Promise<bigint>,
  ])

  const [tokenSymbol, tokenDecimals] = await Promise.all([
    client.readContract({ address: bondToken, abi: ERC20_ABI, functionName: 'symbol' }) as Promise<string>,
    client.readContract({ address: bondToken, abi: ERC20_ABI, functionName: 'decimals' }) as Promise<number>,
  ])

  return { bondAmount, voteCost, votingPeriod, minVotes, bondToken, tokenSymbol, tokenDecimals, newsPerItem, maxDailySubmissions }
}

async function fetchAllItems(
  client: PublicClient,
  registry: Address,
  config: RegistryConfig,
): Promise<FeedItem[]> {
  const nextId = await client.readContract({
    address: registry, abi: FEED_REGISTRY_ABI, functionName: 'nextItemId',
  }) as bigint

  const count = Number(nextId)
  const nowSec = BigInt(Math.floor(Date.now() / 1000))

  const promises = Array.from({ length: count }, async (_, i) => {
    const raw = await client.readContract({
      address: registry, abi: FEED_REGISTRY_ABI, functionName: 'items', args: [BigInt(i)],
    }) as [Address, bigint, string, string, bigint, bigint, bigint, number]

    const [submitter, submitterHumanId, url, metadataHash, bond, voteCostSnapshot, submittedAt, status] = raw

    let timeRemaining = -1
    if (status === STATUS_VOTING) {
      const end = submittedAt + config.votingPeriod
      timeRemaining = Math.max(0, Number(end - nowSec))
    }

    const item: FeedItem = {
      id: i, submitter, submitterHumanId, url, metadataHash, bond, voteCostSnapshot, submittedAt, status, timeRemaining,
    }

    // Fetch vote session for voting items
    if (status === STATUS_VOTING) {
      const vRaw = await client.readContract({
        address: registry, abi: FEED_REGISTRY_ABI, functionName: 'getVoteSession', args: [BigInt(i)],
      }) as [bigint, bigint, bigint, bigint]
      const [votesFor, votesAgainst, keepClaimPerVoter, removeClaimPerVoter] = vRaw
      item.voteSession = { votesFor, votesAgainst, keepClaimPerVoter, removeClaimPerVoter }
    }

    return item
  })

  const results = await Promise.all(promises)
  return results.sort((a, b) => a.id - b.id)
}

// ── Curator Logic ──────────────────────────────────────────────────────────

export async function runCuratorLoop(
  curatorConfig: CuratorConfig,
  isTest: boolean,
): Promise<never> {
  // Setup
  const deployment = await loadDeployment(isTest)
  const readRpc = deployment.rpc
  const writeRpc = deployment.writeRpc ?? readRpc
  const registryAddr = deployment.contracts.FeedRegistry.address as Address
  const agentBookAddr = deployment.contracts.AgentBook.address as Address

  const client = createPublicClient({ chain: worldchain, transport: http(readRpc) })
  const key = await loadPrivateKey()
  const account = privateKeyToAccount(key)
  const walletClient = createWalletClient({ chain: worldchain, transport: http(writeRpc), account })
  const agentAddr = account.address

  // Preflight checks
  logInfo(`Agent address: ${agentAddr}`)
  logInfo(`Registry: ${registryAddr}`)
  logInfo(`Mode: ${curatorConfig.dryRun ? `${YELLOW}DRY RUN${RESET}` : `${GREEN}LIVE${RESET}`}`)
  logInfo(`Vote threshold: ${curatorConfig.voteThreshold}`)
  logInfo(`Poll interval: ${curatorConfig.pollIntervalMs / 1000}s`)

  // Check registration
  const humanId = await client.readContract({
    address: agentBookAddr, abi: AGENTBOOK_ABI, functionName: 'lookupHuman',
    args: [agentAddr],
  }) as bigint

  if (humanId === 0n) {
    logError('Agent is NOT registered in AgentBook. Register first (World ID or MockAgentBook).')
    process.exit(1)
  }
  logInfo(`Registered as humanId: ${humanId}`)

  // Check LLM
  const hasLlm = await detectLlm()
  const llmStatus = getLlmStatus()
  if (!hasLlm) {
    logWarn('No LLM detected. Analysis will be limited to submitter reputation only.')
  } else {
    logInfo(`LLM: ${llmStatus.model}`)
  }

  // Fetch registry config (including bond token info)
  const registryConfig = await fetchConfig(client, registryAddr)
  const fmt = (amount: bigint) => formatUnits(amount, registryConfig.tokenDecimals)

  // Check balances
  const ethBalance = await client.getBalance({ address: agentAddr })
  const tokenBalance = await client.readContract({
    address: registryConfig.bondToken, abi: ERC20_ABI, functionName: 'balanceOf', args: [agentAddr],
  }) as bigint
  logInfo(`ETH balance: ${formatEther(ethBalance)} (for gas)`)
  logInfo(`${registryConfig.tokenSymbol} balance: ${fmt(tokenBalance)}`)
  logInfo(`Bond token: ${registryConfig.tokenSymbol} @ ${registryConfig.bondToken}`)
  logInfo(`Bond: ${fmt(registryConfig.bondAmount)} ${registryConfig.tokenSymbol} | Vote cost: ${fmt(registryConfig.voteCost)} ${registryConfig.tokenSymbol} | Voting: ${registryConfig.votingPeriod}s | MinVotes: ${registryConfig.minVotes}`)

  // Ensure USDC approval for registry (approve max once)
  const allowance = await client.readContract({
    address: registryConfig.bondToken, abi: ERC20_ABI, functionName: 'allowance',
    args: [agentAddr, registryAddr],
  }) as bigint

  if (allowance < registryConfig.voteCost * 1000n) {
    logInfo(`Approving ${registryConfig.tokenSymbol} for registry...`)
    if (!curatorConfig.dryRun) {
      const approveHash = await walletClient.writeContract({
        address: registryConfig.bondToken, abi: ERC20_ABI, functionName: 'approve',
        args: [registryAddr, 2n ** 256n - 1n], // max approval
      })
      logInfo(`Approved: ${approveHash}`)
    } else {
      logInfo(`(dry run) Would approve max ${registryConfig.tokenSymbol}`)
    }
  } else {
    logInfo(`${registryConfig.tokenSymbol} already approved for registry`)
  }

  console.log(`\n${BOLD}${'='.repeat(60)}${RESET}`)
  console.log(`${BOLD}  Curator agent started. Watching for items...${RESET}`)
  console.log(`${BOLD}${'='.repeat(60)}${RESET}\n`)

  // Track what we've already processed to avoid double-actions
  const processedItems = new Set<number>()
  const votedItems = new Set<number>()
  const resolvedItems = new Set<number>()
  const claimedItems = new Set<number>()
  const actionLog: ActionLog[] = []

  function recordAction(action: string, itemId: number, reason: string, txHash?: string) {
    actionLog.push({ timestamp: Date.now(), action, itemId, reason, txHash })
  }

  // Main loop
  while (true) {
    try {
      const items = await fetchAllItems(client, registryAddr, registryConfig)
      const nowSec = Math.floor(Date.now() / 1000)

      for (const item of items) {
        // Skip terminal states
        if (item.status === STATUS_ACCEPTED || item.status === STATUS_REJECTED) {
          // Claim payouts for resolved items we voted on
          if (curatorConfig.autoClaim && votedItems.has(item.id) && !claimedItems.has(item.id)) {
            claimedItems.add(item.id)
            logAction(`#${item.id} resolved — claiming payout`)
            if (!curatorConfig.dryRun) {
              try {
                const hash = await walletClient.writeContract({
                  address: registryAddr, abi: FEED_REGISTRY_ABI, functionName: 'claim',
                  args: [BigInt(item.id)],
                })
                logAction(`#${item.id} claimed: ${hash}`)
                recordAction('claim', item.id, 'Payout claimed', hash)
              } catch (err: any) {
                logError(`#${item.id} claim failed: ${err?.shortMessage ?? err?.message}`)
              }
            } else {
              recordAction('claim (dry)', item.id, 'Payout claimed')
            }
          }
          continue
        }

        // ── VOTING items (status 0) ──────────────────────────────
        if (item.status === STATUS_VOTING) {
          const votingEnd = Number(item.submittedAt) + Number(registryConfig.votingPeriod)
          const expired = nowSec > votingEnd

          // Resolve expired voting periods
          if (expired && curatorConfig.autoResolve && !resolvedItems.has(item.id)) {
            resolvedItems.add(item.id)
            logAction(`#${item.id} voting period expired — resolving`)

            if (!curatorConfig.dryRun) {
              try {
                const hash = await walletClient.writeContract({
                  address: registryAddr, abi: FEED_REGISTRY_ABI, functionName: 'resolve',
                  args: [BigInt(item.id)],
                })
                logAction(`#${item.id} resolved: ${hash}`)
                recordAction('resolve', item.id, 'Voting period expired', hash)
              } catch (err: any) {
                logError(`#${item.id} resolve failed: ${err?.shortMessage ?? err?.message}`)
              }
            } else {
              recordAction('resolve (dry)', item.id, 'Voting period expired')
            }
            continue
          }

          // Analyze and vote (only while voting period is active)
          if (!expired && !processedItems.has(item.id)) {
            processedItems.add(item.id)

            // Don't vote on our own submissions
            if (item.submitter.toLowerCase() === agentAddr.toLowerCase()) {
              logSkip(`#${item.id} own submission — skipping`)
              continue
            }

            logInfo(`#${item.id} analyzing ${item.url.slice(0, 60)}...`)
            const analysis = await analyzeItem(item, items)

            if (analysis.status === 'done') {
              const keep = analysis.score >= curatorConfig.voteThreshold
              logAction(`#${item.id} score ${analysis.score} ${keep ? '>=' : '<'} ${curatorConfig.voteThreshold} — voting ${keep ? 'KEEP' : 'REMOVE'}`)
              if (!keep) {
                logAction(`  Reason: ${analysis.flagReason ?? analysis.summary ?? 'Low quality'}`)
              }

              if (!curatorConfig.dryRun) {
                try {
                  const hash = await walletClient.writeContract({
                    address: registryAddr, abi: FEED_REGISTRY_ABI, functionName: 'vote',
                    args: [BigInt(item.id), keep],
                  })
                  logAction(`#${item.id} voted ${keep ? 'KEEP' : 'REMOVE'}: ${hash}`)
                  votedItems.add(item.id)
                  recordAction(keep ? 'vote-keep' : 'vote-remove', item.id, `Score ${analysis.score}`, hash)
                } catch (err: any) {
                  // AlreadyVoted is expected if another agent voted from same humanId
                  logError(`#${item.id} vote failed: ${err?.shortMessage ?? err?.message}`)
                }
              } else {
                votedItems.add(item.id)
                recordAction(`vote-${keep ? 'keep' : 'remove'} (dry)`, item.id, `Score ${analysis.score}`)
              }
            } else if (analysis.status === 'error') {
              logWarn(`#${item.id} analysis error: ${analysis.error}`)
              // If URL is unreachable, vote REMOVE
              if (analysis.flagged && analysis.flagReason === 'Unreachable URL') {
                logAction(`#${item.id} unreachable URL — voting REMOVE`)
                if (!curatorConfig.dryRun) {
                  try {
                    const hash = await walletClient.writeContract({
                      address: registryAddr, abi: FEED_REGISTRY_ABI, functionName: 'vote',
                      args: [BigInt(item.id), false],
                    })
                    logAction(`#${item.id} voted REMOVE: ${hash}`)
                    votedItems.add(item.id)
                    recordAction('vote-remove', item.id, 'Unreachable URL', hash)
                  } catch (err: any) {
                    logError(`#${item.id} vote failed: ${err?.shortMessage ?? err?.message}`)
                  }
                } else {
                  votedItems.add(item.id)
                  recordAction('vote-remove (dry)', item.id, 'Unreachable URL')
                }
              }
            }
          }
        }
      }
    } catch (err: any) {
      logError(`Poll failed: ${err?.shortMessage ?? err?.message ?? err}`)
    }

    // Wait before next poll
    await new Promise(resolve => setTimeout(resolve, curatorConfig.pollIntervalMs))
  }
}

// ── CLI Entry Point ────────────────────────────────────────────────────────

async function main() {
  const argv = typeof globalThis.Bun !== 'undefined' ? (globalThis as any).Bun.argv.slice(2) : process.argv.slice(2)
  const { values } = parseArgs({
    args: argv,
    options: {
      test: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      'vote-threshold': { type: 'string', default: '5.0' },
      'no-resolve': { type: 'boolean', default: false },
      'no-claim': { type: 'boolean', default: false },
      'poll-interval': { type: 'string', default: '30' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: false,
  })

  if (values.help) {
    console.log(`
${BOLD}Newsworthy Curator Agent${RESET} — autonomous curation for FeedRegistryV2

${BOLD}Usage:${RESET}
  bun run agent/src/curator.ts [options]

${BOLD}Options:${RESET}
  --test                  Use test deployment (MockAgentBook, short periods)
  --dry-run               Log decisions without sending transactions
  --vote-threshold N      Score below which to vote REMOVE (default: 5.0)
                          ${DIM}Range 1-10. Items scoring above this get a KEEP vote.${RESET}
                          ${DIM}  1-3: Only votes REMOVE on obvious spam${RESET}
                          ${DIM}  4-5: Votes REMOVE on mediocre content${RESET}
                          ${DIM}  6-7: Votes REMOVE on anything below "good"${RESET}
                          ${DIM}  8-10: Votes REMOVE on almost everything${RESET}
                          ${DIM}Each vote costs 0.05 USDC (voteCost).${RESET}
                          ${DIM}You earn a payout if you voted with the majority.${RESET}
  --no-resolve            Don't auto-resolve expired voting periods
  --no-claim              Don't auto-claim payouts after resolution
  --poll-interval N       Seconds between scans (default: 30)
  -h, --help              Show this help

${BOLD}Examples:${RESET}
  ${DIM}# Conservative curator — only votes REMOVE on spam${RESET}
  bun run agent/src/curator.ts --test --vote-threshold 3.0

  ${DIM}# Strict curator — votes REMOVE on anything below "good"${RESET}
  bun run agent/src/curator.ts --test --vote-threshold 7.0

  ${DIM}# Dry run — see what the agent would do without spending USDC${RESET}
  bun run agent/src/curator.ts --test --dry-run

  ${DIM}# Vote-only (no housekeeping)${RESET}
  bun run agent/src/curator.ts --test --no-resolve --no-claim
`)
    return
  }

  const config: CuratorConfig = {
    voteThreshold: parseFloat(values['vote-threshold'] ?? '5.0'),
    autoResolve: !values['no-resolve'],
    autoClaim: !values['no-claim'],
    dryRun: values['dry-run'] ?? false,
    pollIntervalMs: parseInt(values['poll-interval'] ?? '30', 10) * 1000,
  }

  await runCuratorLoop(config, values.test ?? false)
}

main().catch(err => {
  console.error(`\x1b[31mFatal:\x1b[0m ${err?.message ?? err}`)
  process.exit(1)
})
