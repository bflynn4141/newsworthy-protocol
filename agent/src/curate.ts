// Main curation pipeline (V2 — no challenge step)
//
// Lifecycle of a news item:
//   1. Agent discovers URLs          (sources.ts)
//   2. Agent evaluates each URL      (evaluate.ts)
//   3. Worthy items → submitItem()   (this file)
//   4. Registered humans vote        → vote(itemId, support)
//   5. After voting period           → resolve(itemId)
//   6. Voters claim rewards          → claim(itemId)
//   7. Bond holders withdraw         → withdraw()
//
// All functions require the caller to be registered in AgentBook (enforced on-chain).

import {
  createPublicClient,
  createWalletClient,
  http,
  type Address,
  type Hash,
  type Account,
} from 'viem'
import { worldchain } from 'viem/chains'

// ── FeedRegistry V2 ABI ──────────────────────────────────────────────────────
// V2 eliminates the challenge step. Items go directly to voting.
// Status enum: 0=Voting, 1=Accepted, 2=Rejected

export const FEED_REGISTRY_ABI = [
  // ── Errors ───────────────────────────────────────────────────────────────
  { type: 'error', name: 'NotRegistered', inputs: [] },
  { type: 'error', name: 'DuplicateUrl', inputs: [] },
  { type: 'error', name: 'InvalidItemStatus', inputs: [] },
  { type: 'error', name: 'InvalidUrl', inputs: [] },
  { type: 'error', name: 'SelfVote', inputs: [] },
  { type: 'error', name: 'AlreadyVoted', inputs: [] },
  { type: 'error', name: 'VotingPeriodActive', inputs: [] },
  { type: 'error', name: 'VotingPeriodExpired', inputs: [] },
  { type: 'error', name: 'NotAVoter', inputs: [] },
  { type: 'error', name: 'AlreadyClaimed', inputs: [] },
  { type: 'error', name: 'NothingToWithdraw', inputs: [] },
  { type: 'error', name: 'TransferFailed', inputs: [] },
  { type: 'error', name: 'DailyLimitReached', inputs: [] },

  // ── Write functions ────────────────────────────────────────────────────────
  {
    type: 'function',
    name: 'submitItem',
    inputs: [
      { name: 'url', type: 'string' },
      { name: 'metadataHash', type: 'string' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'vote',
    inputs: [
      { name: 'itemId', type: 'uint256' },
      { name: 'support', type: 'bool' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'resolve',
    inputs: [{ name: 'itemId', type: 'uint256' }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'claim',
    inputs: [{ name: 'itemId', type: 'uint256' }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'withdraw',
    inputs: [],
    outputs: [],
    stateMutability: 'nonpayable',
  },

  // ── Read functions ─────────────────────────────────────────────────────────
  {
    type: 'function',
    name: 'bondAmount',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'bondToken',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'items',
    inputs: [{ name: 'itemId', type: 'uint256' }],
    outputs: [
      { name: 'submitter', type: 'address' },
      { name: 'submitterHumanId', type: 'uint256' },
      { name: 'url', type: 'string' },
      { name: 'metadataHash', type: 'string' },
      { name: 'bond', type: 'uint256' },
      { name: 'voteCostSnapshot', type: 'uint256' },
      { name: 'submittedAt', type: 'uint256' },
      { name: 'status', type: 'uint8' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'nextItemId',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'pendingWithdrawals',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'votingPeriod',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'minVotes',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'newsToken',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'newsPerItem',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'maxDailySubmissions',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'dailySubmissions',
    inputs: [
      { name: 'humanId', type: 'uint256' },
      { name: 'day', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'owner',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'hasVotedByHuman',
    inputs: [
      { name: 'itemId', type: 'uint256' },
      { name: 'humanId', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'getVoteSession',
    inputs: [{ name: 'itemId', type: 'uint256' }],
    outputs: [
      { name: 'votesFor', type: 'uint256' },
      { name: 'votesAgainst', type: 'uint256' },
      { name: 'keepClaimPerVoter', type: 'uint256' },
      { name: 'removeClaimPerVoter', type: 'uint256' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'voteCost',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },

  // ── Events ─────────────────────────────────────────────────────────────────
  {
    type: 'event',
    name: 'ItemSubmitted',
    inputs: [
      { name: 'itemId', type: 'uint256', indexed: true },
      { name: 'submitter', type: 'address', indexed: true },
      { name: 'url', type: 'string', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'VoteCast',
    inputs: [
      { name: 'itemId', type: 'uint256', indexed: true },
      { name: 'humanId', type: 'uint256', indexed: true },
      { name: 'support', type: 'bool', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'ItemResolved',
    inputs: [
      { name: 'itemId', type: 'uint256', indexed: true },
      { name: 'status', type: 'uint8', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'VoterClaimed',
    inputs: [
      { name: 'itemId', type: 'uint256', indexed: true },
      { name: 'voter', type: 'address', indexed: true },
      { name: 'payout', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'Withdrawal',
    inputs: [
      { name: 'account', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'NewsRewarded',
    inputs: [
      { name: 'itemId', type: 'uint256', indexed: true },
      { name: 'submitter', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
    ],
  },
] as const

// ── ERC-20 ABI (minimal for approve + allowance) ────────────────────────────

export const ERC20_ABI = [
  {
    type: 'function',
    name: 'approve',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'allowance',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'balanceOf',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'decimals',
    inputs: [],
    outputs: [{ name: '', type: 'uint8' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'symbol',
    inputs: [],
    outputs: [{ name: '', type: 'string' }],
    stateMutability: 'view',
  },
] as const

// ── Clients ──────────────────────────────────────────────────────────────────

const publicClient = createPublicClient({
  chain: worldchain,
  transport: http(),
})

// ── Submit ───────────────────────────────────────────────────────────────────

export async function submitItem(
  registryAddress: Address,
  url: string,
  metadataHash: string,
  account: Account,
): Promise<Hash> {
  const walletClient = createWalletClient({
    chain: worldchain,
    transport: http(),
    account,
  })

  return walletClient.writeContract({
    address: registryAddress,
    abi: FEED_REGISTRY_ABI,
    functionName: 'submitItem',
    args: [url, metadataHash],
  })
}

// ── Vote ─────────────────────────────────────────────────────────────────────

export async function vote(
  registryAddress: Address,
  itemId: bigint,
  support: boolean,
  account: Account,
): Promise<Hash> {
  const walletClient = createWalletClient({
    chain: worldchain,
    transport: http(),
    account,
  })

  return walletClient.writeContract({
    address: registryAddress,
    abi: FEED_REGISTRY_ABI,
    functionName: 'vote',
    args: [itemId, support],
  })
}

// ── Resolve ──────────────────────────────────────────────────────────────────

export async function resolve(
  registryAddress: Address,
  itemId: bigint,
  account: Account,
): Promise<Hash> {
  const walletClient = createWalletClient({
    chain: worldchain,
    transport: http(),
    account,
  })

  return walletClient.writeContract({
    address: registryAddress,
    abi: FEED_REGISTRY_ABI,
    functionName: 'resolve',
    args: [itemId],
  })
}

// ── Claim ────────────────────────────────────────────────────────────────────

export async function claim(
  registryAddress: Address,
  itemId: bigint,
  account: Account,
): Promise<Hash> {
  const walletClient = createWalletClient({
    chain: worldchain,
    transport: http(),
    account,
  })

  return walletClient.writeContract({
    address: registryAddress,
    abi: FEED_REGISTRY_ABI,
    functionName: 'claim',
    args: [itemId],
  })
}

// ── Withdraw ─────────────────────────────────────────────────────────────────

export async function claimRewards(
  registryAddress: Address,
  account: Account,
): Promise<Hash> {
  const walletClient = createWalletClient({
    chain: worldchain,
    transport: http(),
    account,
  })

  return walletClient.writeContract({
    address: registryAddress,
    abi: FEED_REGISTRY_ABI,
    functionName: 'withdraw',
    args: [],
  })
}

// ── Read helpers ─────────────────────────────────────────────────────────────

export async function getBondAmount(registryAddress: Address): Promise<bigint> {
  return publicClient.readContract({
    address: registryAddress,
    abi: FEED_REGISTRY_ABI,
    functionName: 'bondAmount',
  })
}

export async function getPendingWithdrawals(
  registryAddress: Address,
  account: Address,
): Promise<bigint> {
  return publicClient.readContract({
    address: registryAddress,
    abi: FEED_REGISTRY_ABI,
    functionName: 'pendingWithdrawals',
    args: [account],
  })
}

export async function getBondToken(registryAddress: Address): Promise<Address> {
  return publicClient.readContract({
    address: registryAddress,
    abi: FEED_REGISTRY_ABI,
    functionName: 'bondToken',
  })
}
