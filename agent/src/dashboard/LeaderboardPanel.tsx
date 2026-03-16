import React, { useState, useEffect } from 'react'
import { Box, Text } from 'ink'
import { parseAbiItem, formatUnits, type Address, type PublicClient } from 'viem'

const DEPLOY_BLOCK = 26707740n

const NEWS_REWARDED = parseAbiItem(
  'event NewsRewarded(uint256 indexed itemId, address indexed submitter, uint256 amount)'
)

type EarnerEntry = {
  address: string
  total: bigint
  items: number
}

type Props = {
  client: PublicClient
  registryAddr: Address
}

export default function LeaderboardPanel({ client, registryAddr }: Props) {
  const [earners, setEarners] = useState<EarnerEntry[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false

    async function fetch() {
      try {
        const logs = await client.getLogs({
          address: registryAddr,
          event: NEWS_REWARDED,
          fromBlock: DEPLOY_BLOCK,
          toBlock: 'latest',
        })

        const earned = new Map<string, { total: bigint; items: number }>()
        for (const log of logs) {
          const { submitter, amount } = log.args as { submitter: string; amount: bigint }
          const addr = submitter.toLowerCase()
          const prev = earned.get(addr) ?? { total: 0n, items: 0 }
          earned.set(addr, { total: prev.total + amount, items: prev.items + 1 })
        }

        const sorted = [...earned.entries()]
          .map(([address, data]) => ({ address, ...data }))
          .sort((a, b) => (b.total > a.total ? 1 : b.total < a.total ? -1 : 0))

        if (!cancelled) {
          setEarners(sorted)
          setLoading(false)
        }
      } catch {
        if (!cancelled) setLoading(false)
      }
    }

    fetch()
    return () => { cancelled = true }
  }, [client, registryAddr])

  if (loading) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text dimColor>Loading leaderboard...</Text>
      </Box>
    )
  }

  if (earners.length === 0) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text dimColor>No $NEWS earned yet.</Text>
      </Box>
    )
  }

  const medals = ['\u2B50', '\u25C6', '\u25CB']

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold>$NEWS Leaderboard (earned, not held)</Text>
      <Box marginTop={1} flexDirection="column">
        {earners.map((e, i) => {
          const medal = medals[i] ?? ' '
          const addr = `${e.address.slice(0, 6)}...${e.address.slice(-4)}`
          const amount = formatUnits(e.total, 18)
          return (
            <Box key={e.address}>
              <Text>
                <Text bold>{`${i + 1}`.padStart(2)}</Text>
                {` ${medal} `}
                <Text dimColor>{addr}</Text>
                {'  '}
                <Text bold color="yellow">{amount} $NEWS</Text>
                {'  '}
                <Text dimColor>{e.items} item{e.items !== 1 ? 's' : ''}</Text>
              </Text>
            </Box>
          )
        })}
      </Box>
    </Box>
  )
}
