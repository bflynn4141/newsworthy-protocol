# Newsworthy Contracts

Solidity contracts for the Newsworthy protocol, built with [Foundry](https://book.getfoundry.sh/).

## Contracts

| Contract | Description |
|----------|-------------|
| `FeedRegistryV2` | Core registry — submit items, vote, resolve, claim rewards. UUPS upgradeable proxy. |
| `AgentBook` | World ID registration — links wallets to verified humans (1:1). |
| `NewsToken` | NEWS ERC-20 token — minted as rewards for accepted submissions and correct votes. |
| `NewsStaking` | Staking contract for NEWS tokens. |

## Build

```bash
forge install   # Install dependencies (solady, forge-std, OpenZeppelin)
forge build     # Compile all contracts
```

## Test

```bash
forge test          # Run all tests
forge test -vvv     # Verbose output with traces
forge test --match-contract FeedRegistryV2Test   # Run specific test file
```

## Dependencies

- [solady](https://github.com/Vectorized/solady) v0.0.210 — Gas-optimized Solidity utilities
- [forge-std](https://github.com/foundry-rs/forge-std) v1.8.2 — Foundry test framework
- [OpenZeppelin Contracts](https://github.com/OpenZeppelin/openzeppelin-contracts) v5.0.2 — ERC-20, UUPS proxy

## Architecture

```
FeedRegistryV2 (UUPS proxy)
├── submitItem(url, metadata)     Submit a tweet with 1 USDC bond
├── vote(itemId, support)         Vote keep/remove for 0.05 USDC
├── resolve(itemId)               Close voting after period expires
├── claim(itemId)                 Claim voter rewards
└── withdraw()                    Withdraw accumulated USDC rewards

AgentBook
├── register(agent, root, nonce, nullifierHash, proof)   World ID verification
├── lookupHuman(agent) → humanId                          Check registration
└── getNextNonce(agent) → nonce                           Get next registration nonce

NewsToken (ERC-20)
└── Minted by FeedRegistryV2 on item resolution
```

## Item Lifecycle

```
Submitted (status=0) → Voting period (1hr) → Resolved → Accepted (status=1) or Rejected (status=2)
```

1. Anyone submits a tweet URL with a 1 USDC bond
2. Registered humans vote keep or remove (0.05 USDC each)
3. After 1 hour (and >= 3 votes), anyone calls `resolve()`
4. Majority wins: winning voters split losing side's stakes
5. If accepted, submitter gets bond back + NEWS tokens

## Disclaimer

These contracts are **unaudited**. Use at your own risk.
