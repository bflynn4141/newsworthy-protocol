#!/usr/bin/env node
// Newsworthy CLI — interact with FeedRegistry + AgentBook on World Chain
//
// Usage:
//   newsworthy [--test] <command> [args...]
//   npx @newsworthy/cli [--test] <command> [args...]
//
// Commands (read):
//   status          Registry overview: bond, periods, deployer balance
//   items           List all items with ID, status, submitter, URL
//   item <id>       Detail view for a single item + vote session info
//   leaderboard     $NEWS earnings leaderboard (who earned, not who holds)
//   register        Register agent via World ID (QR code + on-chain)
//   dashboard       Live TUI dashboard (auto-refreshing, requires Node)
//
// Commands (write — costs gas):
//   approve                 Max-approve USDC for the registry (one-shot)
//   submit <url> [meta]     Submit news item with bond
//   vote <id> <keep|remove> Vote on a voting item
//   resolve <id>            Resolve an item after voting period
//   claim <id>              Claim voter rewards for a resolved item
//   withdraw                Claim pending USDC rewards
//
// Flags:
//   --test    Use test contracts (MockAgentBook, relaxed params)

import { performance } from 'node:perf_hooks'
import { parseArgs } from 'node:util'

// Prevent perf_hooks memory leak in long-running dashboard sessions.
// React/tsx emit performance marks/measures on every render; after hours
// the buffer hits 1M+ entries and OOMs Node.  Flush every 30s.
setInterval(() => {
  performance.clearMarks()
  performance.clearMeasures()
}, 30_000)
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve as pathResolve, dirname } from 'node:path'
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbiItem,
  formatEther,
  formatUnits,
  decodeAbiParameters,
  type Address,
  type PublicClient,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { worldchain } from 'viem/chains'
import { FEED_REGISTRY_ABI, ERC20_ABI } from './curate.js'
import { AGENTBOOK_ABI, isRegistered, getNextNonce, registerAgent, type WorldIdProof } from './register.js'
import qrcode from 'qrcode-terminal'

// ── Config ──────────────────────────────────────────────────────────────────

type Deployment = {
  chainId: number
  rpc: string
  writeRpc?: string
  deployer: string
  contracts: {
    AgentBook: { address: string }
    FeedRegistry: { address: string }
  }
}

const EXPLORER = 'https://worldchain-mainnet.explorer.alchemy.com'

const STATUS_NAMES: Record<number, string> = {
  0: 'Voting',
  1: 'Accepted',
  2: 'Rejected',
}

const STATUS_COLORS: Record<number, string> = {
  0: '\x1b[33m',  // yellow
  1: '\x1b[32m',  // green
  2: '\x1b[31m',  // red
}

const RESET = '\x1b[0m'
const BOLD = '\x1b[1m'
const DIM = '\x1b[90m'
const GREEN = '\x1b[32m'
const RED = '\x1b[31m'

const API_BASE = process.env['NEWSWORTHY_API_URL'] ?? 'https://newsworthy-api.bflynn4141.workers.dev'

// ── Bundled addresses (from addresses.json in repo root) ────────────────────
const DEFAULT_ADDRESSES = {
  chainId: 480,
  feedRegistry: '0xb2d538D2BD69a657A5240c446F0565a7F5d52BBF' as const,
  agentBook: '0xd4c3680c8cd5Ef45F5AbA9402e32D0561A1401cc' as const,
  newsToken: '0x2e8B4cB9716db48D5AB98ed111a41daC4AE6f8bF' as const,
  usdc: '0x79A02482A880bCE3F13e09Da970dC34db4CD24d1' as const,
  rpc: 'https://worldchain-mainnet.g.alchemy.com/public',
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function statusLabel(status: number): string {
  const color = STATUS_COLORS[status] ?? ''
  const name = STATUS_NAMES[status] ?? `Unknown(${status})`
  return `${color}${name}${RESET}`
}

function formatDuration(seconds: number): string {
  if (seconds <= 0) return 'expired'
  if (seconds < 60) return `${seconds}s`
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return s > 0 ? `${m}m ${s}s` : `${m}m`
}

function timeRemaining(startTimestamp: bigint, periodSeconds: bigint): string {
  const now = BigInt(Math.floor(Date.now() / 1000))
  const end = startTimestamp + periodSeconds
  if (now >= end) return '\x1b[32mExpired\x1b[0m'
  return formatDuration(Number(end - now)) + ' remaining'
}

function txLink(hash: string): string {
  return `${EXPLORER}/tx/${hash}`
}

function die(msg: string): never {
  console.error(`\x1b[31mError:\x1b[0m ${msg}`)
  process.exit(1)
}

// ── Load config ─────────────────────────────────────────────────────────────

async function loadDeployment(_test: boolean): Promise<Deployment> {
  // Try loading from addresses.json in repo root (for dev), or fall back to bundled defaults
  const rpc = process.env['NEWSWORTHY_RPC_URL'] ?? DEFAULT_ADDRESSES.rpc
  const key = process.env['NEWSWORTHY_PRIVATE_KEY']

  // Try to find addresses.json relative to this file (handles both src/ and dist/)
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

  // Derive deployer address from private key if available
  let deployer = '0x0000000000000000000000000000000000000000'
  if (key) {
    const account = privateKeyToAccount(key as `0x${string}`)
    deployer = account.address
  }

  return {
    chainId: addresses.chainId,
    rpc,
    deployer,
    contracts: {
      AgentBook: { address: addresses.agentBook },
      FeedRegistry: { address: addresses.feedRegistry },
    },
  }
}

async function loadPrivateKey(): Promise<`0x${string}`> {
  // 1. Environment variable (preferred)
  const envKey = process.env['NEWSWORTHY_PRIVATE_KEY']
  if (envKey) {
    if (!envKey.startsWith('0x')) return `0x${envKey}` as `0x${string}`
    return envKey as `0x${string}`
  }

  // 2. Key file at ~/.newsworthy/agent.key
  try {
    const homedir = process.env['HOME'] ?? process.env['USERPROFILE'] ?? '~'
    const keyPath = pathResolve(homedir, '.newsworthy', 'agent.key')
    const key = (await readFile(keyPath, 'utf-8')).trim()
    if (!key.startsWith('0x')) return `0x${key}` as `0x${string}`
    return key as `0x${string}`
  } catch {
    die('No private key found. Set NEWSWORTHY_PRIVATE_KEY env var or create ~/.newsworthy/agent.key')
  }
}

async function getWalletClient(rpcUrl: string) {
  const key = await loadPrivateKey()
  const account = privateKeyToAccount(key)
  return createWalletClient({ chain: worldchain, transport: http(rpcUrl), account })
}

// ── Commands ────────────────────────────────────────────────────────────────

async function cmdStatus(
  deployment: Deployment,
  client: PublicClient,
  registryAddr: Address,
  agentBookAddr: Address,
) {
  const [bond, votingPeriod, minVotes, voteCost, nextId, balance] = await Promise.all([
    client.readContract({ address: registryAddr, abi: FEED_REGISTRY_ABI, functionName: 'bondAmount' }),
    client.readContract({ address: registryAddr, abi: FEED_REGISTRY_ABI, functionName: 'votingPeriod' }),
    client.readContract({ address: registryAddr, abi: FEED_REGISTRY_ABI, functionName: 'minVotes' }),
    client.readContract({ address: registryAddr, abi: FEED_REGISTRY_ABI, functionName: 'voteCost' }),
    client.readContract({ address: registryAddr, abi: FEED_REGISTRY_ABI, functionName: 'nextItemId' }),
    client.getBalance({ address: deployment.deployer as Address }),
  ])

  const humanId = await client.readContract({
    address: agentBookAddr, abi: AGENTBOOK_ABI, functionName: 'lookupHuman',
    args: [deployment.deployer as Address],
  })

  console.log(`\n${BOLD}═══ Newsworthy Registry Status ═══${RESET}\n`)
  console.log(`  Registry:         ${DIM}${registryAddr}${RESET}`)
  console.log(`  AgentBook:        ${DIM}${agentBookAddr}${RESET}`)
  // Fetch bond token info for display
  const bondTokenAddr = await client.readContract({ address: registryAddr, abi: FEED_REGISTRY_ABI, functionName: 'bondToken' }) as Address
  const [tokenSymbol, tokenDecimals] = await Promise.all([
    client.readContract({ address: bondTokenAddr, abi: ERC20_ABI, functionName: 'symbol' }) as Promise<string>,
    client.readContract({ address: bondTokenAddr, abi: ERC20_ABI, functionName: 'decimals' }) as Promise<number>,
  ])
  const newsTokenAddr = await client.readContract({ address: registryAddr, abi: FEED_REGISTRY_ABI, functionName: 'newsToken' }) as Address
  const [newsPerItem, maxDaily] = await Promise.all([
    client.readContract({ address: registryAddr, abi: FEED_REGISTRY_ABI, functionName: 'newsPerItem' }) as Promise<bigint>,
    client.readContract({ address: registryAddr, abi: FEED_REGISTRY_ABI, functionName: 'maxDailySubmissions' }) as Promise<bigint>,
  ])
  const tokenBal = await client.readContract({ address: bondTokenAddr, abi: ERC20_ABI, functionName: 'balanceOf', args: [deployment.deployer as Address] }) as bigint
  const newsBal = await client.readContract({ address: newsTokenAddr, abi: ERC20_ABI, functionName: 'balanceOf', args: [deployment.deployer as Address] }) as bigint

  console.log(`  Bond:             ${formatUnits(bond as bigint, tokenDecimals)} ${tokenSymbol}`)
  console.log(`  Vote cost:        ${formatUnits(voteCost as bigint, tokenDecimals)} ${tokenSymbol}`)
  console.log(`  Voting period:    ${formatDuration(Number(votingPeriod as bigint))}`)
  console.log(`  Min votes:        ${(minVotes as bigint).toString()}`)
  console.log(`  Total items:      ${(nextId as bigint).toString()}`)
  console.log(`  Deployer:         ${DIM}${deployment.deployer}${RESET}`)
  console.log(`  $NEWS / item:     ${formatUnits(newsPerItem, 18)} $NEWS`)
  console.log(`  Daily limit:      ${maxDaily} submissions per human`)
  console.log(`  Deployer balance: ${formatEther(balance)} ETH`)
  console.log(`  ${tokenSymbol} balance:   ${formatUnits(tokenBal, tokenDecimals)} ${tokenSymbol}`)
  console.log(`  $NEWS balance:    ${formatUnits(newsBal, 18)} $NEWS`)
  console.log(`  $NEWS token:      ${DIM}${newsTokenAddr}${RESET}`)
  console.log(`  Registered:       ${humanId !== 0n ? `\x1b[32mYes\x1b[0m (humanId: ${humanId})` : '\x1b[31mNo\x1b[0m'}`)
  console.log()
}

async function cmdItems(client: PublicClient, registryAddr: Address) {
  const nextId = await client.readContract({
    address: registryAddr, abi: FEED_REGISTRY_ABI, functionName: 'nextItemId',
  }) as bigint

  if (nextId === 0n) {
    console.log('\nNo items submitted yet.\n')
    return
  }

  console.log(`\n${BOLD}═══ Items (${nextId} total) ═══${RESET}\n`)

  for (let i = 0n; i < nextId; i++) {
    const item = await client.readContract({
      address: registryAddr, abi: FEED_REGISTRY_ABI, functionName: 'items', args: [i],
    }) as [Address, bigint, string, string, bigint, bigint, bigint, number]

    const [submitter, , url, , bond, , , status] = item
    console.log(`  ${BOLD}#${i}${RESET}  ${statusLabel(status)}  ${formatUnits(bond, 6)} USDC  ${DIM}${submitter.slice(0, 10)}…${RESET}`)
    console.log(`      ${url}`)
  }
  console.log()
}

async function cmdItem(client: PublicClient, registryAddr: Address, itemId: bigint) {
  const item = await client.readContract({
    address: registryAddr, abi: FEED_REGISTRY_ABI, functionName: 'items', args: [itemId],
  }) as [Address, bigint, string, string, bigint, bigint, bigint, number]

  const [submitter, submitterHumanId, url, metadataHash, bond, voteCostSnapshot, submittedAt, status] = item

  const votingPeriod = await client.readContract({
    address: registryAddr, abi: FEED_REGISTRY_ABI, functionName: 'votingPeriod',
  }) as bigint

  console.log(`\n${BOLD}═══ Item #${itemId} ═══${RESET}\n`)
  console.log(`  Status:       ${statusLabel(status)}`)
  console.log(`  URL:          ${url}`)
  console.log(`  Metadata:     ${metadataHash || DIM + '(none)' + RESET}`)
  console.log(`  Submitter:    ${DIM}${submitter}${RESET}`)
  console.log(`  Human ID:     ${submitterHumanId.toString()}`)
  console.log(`  Bond:         ${formatUnits(bond, 6)} USDC`)
  console.log(`  Vote cost:    ${formatUnits(voteCostSnapshot, 6)} USDC`)
  console.log(`  Submitted at: ${new Date(Number(submittedAt) * 1000).toISOString()}`)

  if (status === 0) {
    console.log(`  Voting:       ${timeRemaining(submittedAt, votingPeriod)}`)
  }

  // Show vote session data for all items
  const voteSession = await client.readContract({
    address: registryAddr, abi: FEED_REGISTRY_ABI, functionName: 'getVoteSession', args: [itemId],
  }) as [bigint, bigint, bigint, bigint]

  const [votesFor, votesAgainst, keepClaimPerVoter, removeClaimPerVoter] = voteSession

  if (votesFor > 0n || votesAgainst > 0n) {
    console.log(`\n  ${BOLD}── Votes ──${RESET}`)
    console.log(`  Votes keep:   ${votesFor.toString()}`)
    console.log(`  Votes remove: ${votesAgainst.toString()}`)
    if (status !== 0) {
      console.log(`  Keep claim:   ${formatUnits(keepClaimPerVoter, 6)} USDC/voter`)
      console.log(`  Remove claim: ${formatUnits(removeClaimPerVoter, 6)} USDC/voter`)
    }
  }
  console.log()
}

async function cmdRegister(
  client: PublicClient,
  agentBookAddr: Address,
  deployer: Address,
  rpcUrl: string,
  isTest: boolean,
) {
  // 1. Check if already registered
  const humanId = await client.readContract({
    address: agentBookAddr, abi: AGENTBOOK_ABI, functionName: 'lookupHuman',
    args: [deployer],
  }) as bigint

  if (humanId !== 0n) {
    console.log(`\n${GREEN}✓${RESET} Already registered as humanId: ${BOLD}${humanId}${RESET}\n`)
    return
  }

  // 2. Test mode — no World ID flow
  if (isTest) {
    console.log(`\n${DIM}Test mode: MockAgentBook auto-registers the deployer.${RESET}`)
    console.log(`${DIM}No World ID verification needed in test mode.${RESET}\n`)
    return
  }

  console.log(`\n${BOLD}═══ World ID Registration ═══${RESET}\n`)
  console.log(`  ${DIM}Agent address: ${deployer}${RESET}\n`)

  // 3. Fetch nonce from AgentBook
  const nonce = await client.readContract({
    address: agentBookAddr, abi: AGENTBOOK_ABI, functionName: 'getNextNonce',
    args: [deployer],
  }) as bigint
  console.log(`  Nonce: ${nonce}`)

  // 4. Create registration session via API
  let sessionId: string
  let sessionExpiresAt: number | null = null // epoch ms
  const sessionCreatedAt = Date.now()
  try {
    const res = await fetch(`${API_BASE}/register/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentAddress: deployer, nonce: Number(nonce) }),
    })
    if (!res.ok) {
      const body = await res.text()
      die(`Failed to create registration session: ${res.status} ${body}`)
    }
    const data = (await res.json()) as { sessionId: string; expiresAt?: string | number }
    sessionId = data.sessionId
    if (data.expiresAt) {
      sessionExpiresAt = typeof data.expiresAt === 'number'
        ? data.expiresAt * (data.expiresAt < 1e12 ? 1000 : 1) // handle seconds vs ms
        : new Date(data.expiresAt).getTime()
    }
  } catch (err: any) {
    die(`Failed to create registration session: ${err?.message ?? String(err)}`)
  }

  // Show session ID with expiry info
  const sessionDeadline = sessionExpiresAt ?? (sessionCreatedAt + 15 * 60 * 1000) // fallback: 15m
  const expiryDeltaSec = Math.max(0, Math.floor((sessionDeadline - Date.now()) / 1000))
  console.log(`  Session: ${DIM}${sessionId}${RESET} (expires in ${formatDuration(expiryDeltaSec)})\n`)

  // 5. Build verification URL and display QR code
  const miniAppPath = encodeURIComponent(`/mini/register-cli?session=${sessionId}`)
  const verifyUrl = `https://world.org/mini-app?app_id=app_1325590145579e6d6df0809d48040738&path=${miniAppPath}`

  if (process.stdout.isTTY) {
    // Interactive terminal — show QR code + URL
    console.log(`  ${BOLD}Scan this QR code with World App to verify:${RESET}\n`)

    await new Promise<void>((resolve) => {
      qrcode.generate(verifyUrl, { small: true }, (qr: string) => {
        console.log(qr)
        resolve()
      })
    })

    console.log(`\n  ${DIM}Or open this URL:${RESET}`)
    console.log(`  ${verifyUrl}\n`)
  } else {
    // Non-TTY (piped, headless agent, CI) — QR codes are unreadable, just show URL
    console.log(`  ${BOLD}Open this URL in World App to verify:${RESET}`)
    console.log(`  ${verifyUrl}\n`)
  }

  // 6. Poll for completion (every 3s, up to 15 minutes = 300 iterations)
  const MAX_POLLS = 300
  const POLL_INTERVAL_MS = 3_000

  let sessionData: { status: string; proofData?: { merkle_root: string; nullifier_hash: string; proof: string } } | null = null

  for (let poll = 1; poll <= MAX_POLLS; poll++) {
    const remainingSec = Math.max(0, Math.floor((sessionDeadline - Date.now()) / 1000))
    process.stdout.write(`\r  ⏳ Waiting for World ID verification... (${formatDuration(remainingSec)} remaining)   `)

    try {
      const res = await fetch(`${API_BASE}/register/session/${sessionId}`)
      if (!res.ok) {
        // Non-fatal — keep polling
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
        continue
      }
      sessionData = (await res.json()) as { status: string; proofData?: { merkle_root: string; nullifier_hash: string; proof: string } }

      if (sessionData.status === 'completed') {
        process.stdout.write('\r' + ' '.repeat(80) + '\r') // clear the polling line
        console.log(`  ${GREEN}✓${RESET} World ID verification received!\n`)
        break
      }
    } catch {
      // Network hiccup — keep polling
    }

    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
  }

  if (!sessionData || sessionData.status !== 'completed') {
    console.log('\n')
    die('Session expired. Run `register` again.')
  }

  const completedSession = sessionData as { status: string; proofData?: { merkle_root: string; nullifier_hash: string; proof: string } }

  if (!completedSession.proofData) {
    die('Session completed but no proof data received.')
  }

  // 7. Parse proof and submit on-chain registration
  console.log(`  ${BOLD}Submitting on-chain registration...${RESET}`)

  const proofData = completedSession.proofData!

  // Decode the ABI-encoded uint256[8] proof
  const [decodedProof] = decodeAbiParameters(
    [{ type: 'uint256[8]' }],
    proofData.proof as `0x${string}`,
  )

  const proof: WorldIdProof = {
    root: BigInt(proofData.merkle_root),
    nonce: nonce,
    nullifierHash: BigInt(proofData.nullifier_hash),
    proof: decodedProof,
  }

  const key = await loadPrivateKey()
  const account = privateKeyToAccount(key)

  const txHash = await registerAgent(agentBookAddr, deployer, proof, account)
  console.log(`  Tx submitted: ${DIM}${txLink(txHash)}${RESET}`)

  // 8. Wait for receipt
  console.log(`  Waiting for confirmation...`)
  const receipt = await client.waitForTransactionReceipt({ hash: txHash })

  if (receipt.status === 'success') {
    // Read the new humanId
    const newHumanId = await client.readContract({
      address: agentBookAddr, abi: AGENTBOOK_ABI, functionName: 'lookupHuman',
      args: [deployer],
    }) as bigint
    console.log(`\n  ${GREEN}✓${RESET} ${BOLD}Registration complete!${RESET} humanId: ${newHumanId}`)
    console.log(`  ${DIM}${txLink(txHash)}${RESET}\n`)
  } else {
    die(`On-chain transaction failed. Check: ${txLink(txHash)}`)
  }
}

async function cmdSubmit(
  client: PublicClient, rpcUrl: string, registryAddr: Address,
  url: string, metadataHash: string,
) {
  const walletClient = await getWalletClient(rpcUrl)

  const [bond, bondToken] = await Promise.all([
    client.readContract({ address: registryAddr, abi: FEED_REGISTRY_ABI, functionName: 'bondAmount' }) as Promise<bigint>,
    client.readContract({ address: registryAddr, abi: FEED_REGISTRY_ABI, functionName: 'bondToken' }) as Promise<Address>,
  ])

  // Ensure approval
  const allowance = await client.readContract({
    address: bondToken, abi: ERC20_ABI, functionName: 'allowance',
    args: [walletClient.account!.address, registryAddr],
  }) as bigint
  if (allowance < bond) {
    console.log(`Approving bond token for registry...`)
    await walletClient.writeContract({
      address: bondToken, abi: ERC20_ABI, functionName: 'approve',
      args: [registryAddr, 2n ** 256n - 1n],
    })
  }

  console.log(`\nSubmitting: ${url}`)
  console.log(`Bond: ${formatUnits(bond, 6)} USDC`)

  const hash = await walletClient.writeContract({
    address: registryAddr, abi: FEED_REGISTRY_ABI, functionName: 'submitItem',
    args: [url, metadataHash],
  })

  console.log(`\x1b[32m✓\x1b[0m Submitted: ${txLink(hash)}\n`)
}

async function cmdVote(
  client: PublicClient, rpcUrl: string, registryAddr: Address,
  itemId: bigint, support: boolean,
) {
  const walletClient = await getWalletClient(rpcUrl)

  const [voteCost, bondToken] = await Promise.all([
    client.readContract({ address: registryAddr, abi: FEED_REGISTRY_ABI, functionName: 'voteCost' }) as Promise<bigint>,
    client.readContract({ address: registryAddr, abi: FEED_REGISTRY_ABI, functionName: 'bondToken' }) as Promise<Address>,
  ])

  // Ensure approval
  const allowance = await client.readContract({
    address: bondToken, abi: ERC20_ABI, functionName: 'allowance',
    args: [walletClient.account!.address, registryAddr],
  }) as bigint
  if (allowance < voteCost) {
    console.log(`Approving USDC for registry...`)
    await walletClient.writeContract({
      address: bondToken, abi: ERC20_ABI, functionName: 'approve',
      args: [registryAddr, 2n ** 256n - 1n],
    })
  }

  console.log(`\nVoting ${support ? '\x1b[32mKEEP\x1b[0m' : '\x1b[31mREMOVE\x1b[0m'} on item #${itemId}`)
  console.log(`Vote cost: ${formatUnits(voteCost, 6)} USDC`)

  const hash = await walletClient.writeContract({
    address: registryAddr, abi: FEED_REGISTRY_ABI, functionName: 'vote',
    args: [itemId, support],
  })

  console.log(`\x1b[32m✓\x1b[0m Vote cast: ${txLink(hash)}\n`)
}

async function cmdApprove(
  client: PublicClient, rpcUrl: string, registryAddr: Address,
) {
  const walletClient = await getWalletClient(rpcUrl)

  const bondToken = await client.readContract({
    address: registryAddr, abi: FEED_REGISTRY_ABI, functionName: 'bondToken',
  }) as Address

  const [tokenSymbol, tokenDecimals] = await Promise.all([
    client.readContract({ address: bondToken, abi: ERC20_ABI, functionName: 'symbol' }) as Promise<string>,
    client.readContract({ address: bondToken, abi: ERC20_ABI, functionName: 'decimals' }) as Promise<number>,
  ])

  const allowance = await client.readContract({
    address: bondToken, abi: ERC20_ABI, functionName: 'allowance',
    args: [walletClient.account!.address, registryAddr],
  }) as bigint

  // Consider "already approved" if allowance > 1000 tokens (generous threshold)
  const threshold = BigInt(1000) * (10n ** BigInt(tokenDecimals))
  if (allowance >= threshold) {
    console.log(`\n${GREEN}Already approved${RESET} — current allowance: ${formatUnits(allowance, tokenDecimals)} ${tokenSymbol}\n`)
    return
  }

  console.log(`\nApproving ${tokenSymbol} for FeedRegistry...`)
  console.log(`Current allowance: ${formatUnits(allowance, tokenDecimals)} ${tokenSymbol}`)

  const hash = await walletClient.writeContract({
    address: bondToken, abi: ERC20_ABI, functionName: 'approve',
    args: [registryAddr, 2n ** 256n - 1n],
  })

  console.log(`\x1b[32m✓\x1b[0m Max approval set: ${txLink(hash)}\n`)
}

async function cmdResolve(
  client: PublicClient, rpcUrl: string, registryAddr: Address, itemId: bigint,
) {
  const walletClient = await getWalletClient(rpcUrl)

  console.log(`\nResolving item #${itemId}`)

  const hash = await walletClient.writeContract({
    address: registryAddr, abi: FEED_REGISTRY_ABI, functionName: 'resolve',
    args: [itemId],
  })

  console.log(`\x1b[32m✓\x1b[0m Resolved: ${txLink(hash)}\n`)
}

async function cmdClaim(
  client: PublicClient, rpcUrl: string, registryAddr: Address, itemId: bigint,
) {
  const walletClient = await getWalletClient(rpcUrl)

  console.log(`\nClaiming voter rewards for item #${itemId}`)

  const hash = await walletClient.writeContract({
    address: registryAddr, abi: FEED_REGISTRY_ABI, functionName: 'claim',
    args: [itemId],
  })

  console.log(`\x1b[32m✓\x1b[0m Claimed: ${txLink(hash)}\n`)
}

async function cmdWithdraw(
  client: PublicClient, rpcUrl: string, registryAddr: Address, deployer: Address,
) {
  const walletClient = await getWalletClient(rpcUrl)

  const pending = await client.readContract({
    address: registryAddr, abi: FEED_REGISTRY_ABI, functionName: 'pendingWithdrawals',
    args: [deployer],
  }) as bigint

  if (pending === 0n) {
    console.log('\nNo pending withdrawals.\n')
    return
  }

  console.log(`\nWithdrawing ${formatUnits(pending, 6)} USDC`)

  const hash = await walletClient.writeContract({
    address: registryAddr, abi: FEED_REGISTRY_ABI, functionName: 'withdraw',
    args: [],
  })

  console.log(`\x1b[32m✓\x1b[0m Withdrawn: ${txLink(hash)}\n`)
}

async function cmdLeaderboard(
  client: PublicClient, registryAddr: Address,
) {
  const newsRewarded = parseAbiItem(
    'event NewsRewarded(uint256 indexed itemId, address indexed submitter, uint256 amount)'
  )

  // Start from deployment block to avoid RPC range limits
  const DEPLOY_BLOCK = 26707740n

  const logs = await client.getLogs({
    address: registryAddr,
    event: newsRewarded,
    fromBlock: DEPLOY_BLOCK,
    toBlock: 'latest',
  })

  // Accumulate earnings per address
  const earned = new Map<string, { total: bigint; items: number }>()
  for (const log of logs) {
    const { submitter, amount } = log.args as { submitter: string; amount: bigint }
    const addr = submitter.toLowerCase()
    const prev = earned.get(addr) ?? { total: 0n, items: 0 }
    earned.set(addr, { total: prev.total + amount, items: prev.items + 1 })
  }

  if (earned.size === 0) {
    console.log('\nNo $NEWS earned yet.\n')
    return
  }

  // Sort by total earned descending
  const sorted = [...earned.entries()].sort((a, b) =>
    b[1].total > a[1].total ? 1 : b[1].total < a[1].total ? -1 : 0
  )

  console.log(`\n${BOLD}═══ $NEWS Leaderboard (earned, not held) ═══${RESET}\n`)
  console.log(`  ${BOLD}#   Address                                      Earned         Items${RESET}`)
  console.log(`  ${'─'.repeat(72)}`)

  for (let i = 0; i < sorted.length; i++) {
    const [addr, { total, items }] = sorted[i]
    const rank = `${i + 1}`.padStart(2)
    const display = `${addr.slice(0, 6)}…${addr.slice(-4)}`
    const newsAmt = formatUnits(total, 18)
    const medal = i === 0 ? ' \u2B50' : i === 1 ? ' \u25C6' : i === 2 ? ' \u25CB' : '  '
    console.log(`  ${rank}${medal} ${display}  ${newsAmt.padStart(20)} $NEWS   ${items} item${items !== 1 ? 's' : ''}`)
  }
  console.log()
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const argv = typeof (globalThis as any).Bun !== 'undefined' ? (globalThis as any).Bun.argv.slice(2) : process.argv.slice(2)
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      test: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
      refresh: { type: 'string', default: '5' },
    },
    allowPositionals: true,
  })

  if (values.help || positionals.length === 0) {
    console.log(`
${BOLD}Newsworthy CLI${RESET} — FeedRegistry on World Chain

${BOLD}Usage:${RESET}
  newsworthy [--test] <command>                    (CLI commands)
  newsworthy dashboard [--test]                    (interactive TUI)

${BOLD}Read commands:${RESET}
  status              Registry overview
  items               List all items
  item <id>           Detail view for one item
  leaderboard         $NEWS earnings ranking
  register            Register via World ID (QR code flow)
  dashboard           Live TUI dashboard (auto-refreshing)

${BOLD}Write commands:${RESET} (costs gas)
  approve             Max-approve USDC for the registry (one-shot)
  submit <url> [meta] Submit item with bond
  vote <id> <keep|remove>  Vote on a voting item
  resolve <id>        Resolve an item after voting period
  claim <id>          Claim voter rewards for a resolved item
  withdraw            Claim pending USDC rewards

${BOLD}Flags:${RESET}
  --test              Use test contracts (MockAgentBook, 60s periods)
  --refresh <sec>     Dashboard refresh interval (default: 5)
`)
    return
  }

  const isTest = values.test ?? false
  const deployment = await loadDeployment(isTest)
  const rpcUrl = deployment.rpc
  const writeRpcUrl = deployment.writeRpc ?? rpcUrl

  // Cast to generic PublicClient to avoid OP Stack transaction type mismatches
  const client = createPublicClient({
    chain: worldchain,
    transport: http(rpcUrl),
  }) as PublicClient

  const registryAddr = deployment.contracts.FeedRegistry.address as Address
  const agentBookAddr = deployment.contracts.AgentBook.address as Address
  const deployer = deployment.deployer as Address

  const command = positionals[0]

  try {
    switch (command) {
      case 'status':
        await cmdStatus(deployment, client, registryAddr, agentBookAddr)
        break

      case 'items':
        await cmdItems(client, registryAddr)
        break

      case 'item': {
        const id = positionals[1]
        if (id === undefined) die('Usage: item <id>')
        await cmdItem(client, registryAddr, BigInt(id))
        break
      }

      case 'leaderboard':
        await cmdLeaderboard(client, registryAddr)
        break

      case 'register':
        await cmdRegister(client, agentBookAddr, deployer, writeRpcUrl, isTest)
        break

      case 'approve':
        await cmdApprove(client, writeRpcUrl, registryAddr)
        break

      case 'submit': {
        const url = positionals[1]
        if (!url) die('Usage: submit <url> [metadataHash]')
        const meta = positionals[2] ?? ''
        await cmdSubmit(client, writeRpcUrl, registryAddr, url, meta)
        break
      }

      case 'vote': {
        const id = positionals[1]
        const direction = positionals[2]
        if (id === undefined || !direction) die('Usage: vote <id> <keep|remove>')
        if (direction !== 'keep' && direction !== 'remove') die('Vote must be "keep" or "remove"')
        await cmdVote(client, writeRpcUrl, registryAddr, BigInt(id), direction === 'keep')
        break
      }

      case 'resolve': {
        const id = positionals[1]
        if (id === undefined) die('Usage: resolve <id>')
        await cmdResolve(client, writeRpcUrl, registryAddr, BigInt(id))
        break
      }

      case 'claim': {
        const id = positionals[1]
        if (id === undefined) die('Usage: claim <id>')
        await cmdClaim(client, writeRpcUrl, registryAddr, BigInt(id))
        break
      }

      case 'withdraw':
        await cmdWithdraw(client, writeRpcUrl, registryAddr, deployer)
        break

      case 'dashboard': {
        const { render } = await import('ink')
        const { createElement } = await import('react')
        const { Readable } = await import('node:stream')
        const { default: App } = await import('./dashboard/App.js')
        const refreshMs = Math.max(1, parseInt(values.refresh ?? '5', 10)) * 1000
        const options: Record<string, unknown> = {}
        if (!process.stdin.isTTY) {
          // Non-interactive: provide a dummy stdin so Ink doesn't crash
          options.stdin = new Readable({ read() {} }) as unknown as NodeJS.ReadStream
        }
        render(createElement(App, {
          client,
          registryAddr,
          agentBookAddr,
          deployer,
          isTest,
          refreshMs,
        }), options)
        return // ink takes over — don't exit
      }

      default:
        die(`Unknown command: ${command}. Run with --help to see available commands.`)
    }
  } catch (err: any) {
    // Viem puts custom error info at err.data.errorName or err.cause.data.errorName
    const errorName = err?.data?.errorName ?? err?.cause?.data?.errorName

    if (errorName) {
      const friendlyMessages: Record<string, string> = {
        AlreadyVoted: 'You already voted on this item',
        NotRegistered: "Your wallet is not registered in AgentBook. Run 'newsworthy register' first",
        VotingPeriodExpired: 'Voting period has ended for this item',
        VotingPeriodActive: 'Voting period is still active, cannot resolve yet',
        DailyLimitReached: 'Daily submission limit reached (max 3 per human per day)',
        SelfVote: 'Cannot vote on your own submission',
        InvalidItemStatus: 'Item is not in the correct status for this action',
        NothingToWithdraw: 'No pending USDC to withdraw',
        AlreadyClaimed: 'Already claimed rewards for this item',
        DuplicateUrl: 'This URL has already been submitted',
        InvalidUrl: 'The provided URL is invalid',
        NotAVoter: 'You did not vote on this item',
        TransferFailed: 'USDC transfer failed — check your balance and approval',
      }

      const friendly = friendlyMessages[errorName]
      if (friendly) {
        die(`${friendly} (${errorName})`)
      }
      die(`Contract reverted: ${errorName}`)
    }

    const reason = err?.shortMessage ?? err?.message ?? String(err)
    die(reason)
  }
}

main()
