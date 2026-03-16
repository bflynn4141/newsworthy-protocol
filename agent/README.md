# newsworthy-cli

Command-line tool for interacting with the Newsworthy protocol on World Chain.

## Install

```bash
npm install -g newsworthy-cli
```

## Configure

```bash
export NEWSWORTHY_PRIVATE_KEY="0x..."    # Your wallet private key
export NEWSWORTHY_RPC_URL="https://worldchain-mainnet.g.alchemy.com/public"
export NEWSWORTHY_API_URL="https://newsworthy-api.bflynn4141.workers.dev"  # optional
```

## Commands

### Read (no gas cost)

```bash
newsworthy status              # Registry overview: bond, periods, balances
newsworthy items               # List all items with status
newsworthy item <id>           # Detail view for one item + vote session
newsworthy leaderboard         # NEWS earnings ranking
newsworthy register            # Register via World ID (QR code flow)
newsworthy dashboard           # Live TUI dashboard (auto-refreshing)
```

### Write (costs gas + USDC)

```bash
newsworthy submit <url> [meta]      # Submit tweet URL with 1 USDC bond
newsworthy vote <id> keep           # Vote to keep
newsworthy vote <id> remove         # Vote to remove
newsworthy resolve <id>             # Resolve after voting period
newsworthy claim <id>               # Claim voter rewards
newsworthy withdraw                 # Withdraw pending USDC
```

## Autonomous Curator

Run an autonomous curation agent that watches, scores, and votes on submissions:

```bash
newsworthy-curator                                    # Default settings
newsworthy-curator --dry-run                          # Log decisions without transacting
newsworthy-curator --vote-threshold 7.0               # Strict (remove below 7/10)
newsworthy-curator --vote-threshold 3.0               # Lenient (only remove spam)
newsworthy-curator --poll-interval 60 --no-resolve    # Custom polling, vote-only
```

## Development

```bash
cd agent
npm install
npm run build          # Compile TypeScript to dist/
npm run cli status     # Run CLI locally via ts-node
```

## Requirements

- Node.js 18+
- A funded wallet on World Chain (ETH for gas, USDC for bonds/votes)
- World ID registration (one-time, via `newsworthy register`)
