// Helper to register a wallet in AgentBook on World Chain
// Requires a World ID proof from World App
//
// Flow:
// 1. Check if agent is already registered via lookupHuman
// 2. If not, get the next nonce
// 3. Generate deep link for World App verification (external to this module)
// 4. After user scans QR and provides proof, call register()
//
// Chain: World Chain (480)

import {
  createPublicClient,
  createWalletClient,
  http,
  type Address,
  type Hash,
  type Account,
} from 'viem'
import { worldchain } from 'viem/chains'

// ── AgentBook ABI (subset needed by agents) ──────────────────────────────────

export const AGENTBOOK_ABI = [
  {
    type: 'function',
    name: 'register',
    inputs: [
      { name: 'agent', type: 'address' },
      { name: 'root', type: 'uint256' },
      { name: 'nonce', type: 'uint256' },
      { name: 'nullifierHash', type: 'uint256' },
      { name: 'proof', type: 'uint256[8]' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'lookupHuman',
    inputs: [{ name: 'agent', type: 'address' }],
    outputs: [{ name: 'humanId', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'getNextNonce',
    inputs: [{ name: 'agent', type: 'address' }],
    outputs: [{ name: 'nonce', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'event',
    name: 'AgentRegistered',
    inputs: [
      { name: 'agent', type: 'address', indexed: true },
      { name: 'humanId', type: 'uint256', indexed: true },
    ],
  },
] as const

// ── Clients ──────────────────────────────────────────────────────────────────

const publicClient = createPublicClient({
  chain: worldchain,
  transport: http(),
})

// ── Read helpers ─────────────────────────────────────────────────────────────

export async function isRegistered(
  agentBookAddress: Address,
  agentAddress: Address,
): Promise<boolean> {
  const humanId = await publicClient.readContract({
    address: agentBookAddress,
    abi: AGENTBOOK_ABI,
    functionName: 'lookupHuman',
    args: [agentAddress],
  })
  return humanId !== 0n
}

export async function getNextNonce(
  agentBookAddress: Address,
  agentAddress: Address,
): Promise<bigint> {
  return publicClient.readContract({
    address: agentBookAddress,
    abi: AGENTBOOK_ABI,
    functionName: 'getNextNonce',
    args: [agentAddress],
  })
}

// ── Write helper ─────────────────────────────────────────────────────────────

export type WorldIdProof = {
  root: bigint
  nonce: bigint
  nullifierHash: bigint
  proof: readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint]
}

export async function registerAgent(
  agentBookAddress: Address,
  agentAddress: Address,
  worldIdProof: WorldIdProof,
  account: Account,
): Promise<Hash> {
  const walletClient = createWalletClient({
    chain: worldchain,
    transport: http(),
    account,
  })

  return walletClient.writeContract({
    address: agentBookAddress,
    abi: AGENTBOOK_ABI,
    functionName: 'register',
    args: [
      agentAddress,
      worldIdProof.root,
      worldIdProof.nonce,
      worldIdProof.nullifierHash,
      worldIdProof.proof,
    ],
  })
}
