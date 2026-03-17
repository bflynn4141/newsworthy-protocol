# NEWS Token

NEWS is earned by curating a community-run news feed. Stake it to earn your share of the USDC that AI agents pay to read the feed via x402.

## How It Works

AI agents pay USDC to access a human-curated crypto news feed through the [x402 payment protocol](https://www.x402.org/). That revenue flows to NEWS stakers.

```
  Curate articles            Stake NEWS             Earn USDC
  ───────────────>  NEWS  ───────────────>  Staking  ───────────────>  Yield
                   (earned)                 contract                  (x402 revenue)
```

### 1. Earn NEWS by curating

When you submit an article to the Newsworthy registry and it's accepted by voters, you earn 100 NEWS tokens. Voters on the winning side also earn NEWS. This is the only way new NEWS enters circulation — through useful curation work.

### 2. Stake NEWS for revenue

Stake your NEWS in the staking contract to start earning. Revenue is distributed pro-rata: if you hold 10% of staked NEWS, you earn 10% of the USDC revenue.

There's no lock-up period. Stake and unstake freely. The [Synthetix accumulator pattern](https://github.com/Synthetixio/synthetix/blob/develop/contracts/StakingRewards.sol) ensures you only earn from revenue deposited while you're staked — no retroactive rewards.

### 3. Revenue from x402

AI agents and applications query the Newsworthy feed API, paying $0.01 USDC per request via x402. These micropayments accumulate in the RevenueRouter, which forwards them to the staking contract for distribution.

```
  Agent queries feed       x402 payment         RevenueRouter         NewsStaking
  ──────────────────>  USDC  ──────────>  Router  ──────────>  depositRevenue()
                      ($0.01)           (accumulates)          (pro-rata to stakers)
```

## Revenue Flow

```
                                    ┌──────────────┐
                                    │  AI Agents   │
                                    │  pay USDC    │
                                    │  via x402    │
                                    └──────┬───────┘
                                           │
                                     $0.01/query
                                           │
                                           v
                                  ┌────────────────┐
                                  │ RevenueRouter  │
                                  │                │
                                  │ stakingBps:    │
                                  │ 10000 (100%)   │
                                  └────────┬───────┘
                                           │
                                    depositRevenue()
                                           │
                                           v
┌───────────┐    stake()     ┌─────────────────────┐    claimRewards()    ┌──────────┐
│   NEWS    │ ──────────────>│    NewsStaking       │───────────────────> │  USDC    │
│  holders  │                │                      │                     │  yield   │
│           │ <──────────────│  rewardPerToken      │                     │          │
└───────────┘    unstake()   │  accumulator         │                     └──────────┘
                             └─────────────────────┘
```

## Token Details

| Property | Value |
|----------|-------|
| Name | Newsworthy |
| Symbol | NEWS |
| Decimals | 18 |
| Standard | ERC-20 |
| Chain | World Chain (480) |
| Minting | By FeedRegistryV2 on article acceptance |
| Supply | Uncapped, demand-driven by curation activity |

## Contracts

| Contract | Address | Purpose |
|----------|---------|---------|
| NewsToken | [`0x2e8B...6f8bF`](https://worldchain-mainnet.explorer.alchemy.com/address/0x2e8B4cB9716db48D5AB98ed111a41daC4AE6f8bF) | ERC-20 token |
| NewsStaking | [`0x2644...919F`](https://worldchain-mainnet.explorer.alchemy.com/address/0x2644BbDa170c313df17AFBbb740577F37A53919F) | Stake NEWS, earn USDC |
| RevenueRouter | [`0xC310...F130`](https://worldchain-mainnet.explorer.alchemy.com/address/0xC3100311ceDC1aD5A22DC650753dB507D399F130) | Routes x402 revenue to stakers |
| FeedRegistryV2 | [`0xb2d5...2BBF`](https://worldchain-mainnet.explorer.alchemy.com/address/0xb2d538D2BD69a657A5240c446F0565a7F5d52BBF) | Mints NEWS on resolution |

## Staking Mechanics

**Deposit revenue** — The `RevenueRouter.distribute()` function is permissionless. Anyone can trigger it to sweep accumulated USDC into the staking contract. Typically called by a keeper on a schedule.

**Pro-rata distribution** — Uses the Synthetix `rewardPerToken` accumulator for O(1) gas distribution regardless of staker count. Each staker's share is calculated as:

```
earned = staked[user] * (rewardPerTokenStored - userRewardPerTokenPaid[user])
```

**No retroactive rewards** — If you stake after revenue is deposited, you only earn from future deposits. This prevents flash-stake attacks.

**Instant liquidity** — No lock-up, no unbonding period. Unclaimed rewards are preserved even after unstaking.

## Revenue Router

The RevenueRouter sits between x402 payments and the staking contract. It starts with 100% of revenue going to stakers (`stakingBps = 10000`).

The owner can adjust the split in the future to fund protocol development:

```solidity
router.setStakingBps(9000); // 90% stakers, 10% treasury
```

This is a transparent, on-chain parameter — anyone can verify the current split.

## Bootstrapping Phase

During the early phase of the protocol:

- The FeedRegistryV2 is the primary minter of NEWS, creating tokens as curation rewards
- Admin retains the ability to mint additional NEWS for liquidity bootstrapping
- The intent is to transition to registry-only minting as the protocol matures and a liquidity pool is established

## Source Code

All contracts are open source (MIT) and verified on-chain:

- [`NewsToken.sol`](./contracts/src/NewsToken.sol)
- [`NewsStaking.sol`](./contracts/src/NewsStaking.sol)
- [`RevenueRouter.sol`](./contracts/src/RevenueRouter.sol)
- [`FeedRegistryV2.sol`](./contracts/src/FeedRegistryV2.sol)

Tests: `forge test` — 26 passing tests covering full staking lifecycle, pro-rata distribution, revenue routing, and edge cases.

## Disclaimer

These contracts are **unaudited**. NEWS is not an investment — it's a utility token for participating in the Newsworthy curation protocol. The protocol is in active development.
