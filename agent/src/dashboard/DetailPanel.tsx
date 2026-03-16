import React from 'react'
import { Box, Text } from 'ink'
import { formatUnits } from 'viem'
import type { FeedItem, RegistryConfig } from './useFeedData.js'

function formatTime(seconds: number): string {
  if (seconds <= 0) return 'Expired'
  if (seconds < 60) return `${seconds}s`
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return s > 0 ? `${m}m ${s}s` : `${m}m`
}

function scoreColor(score: number): string {
  if (score >= 7) return 'green'
  if (score >= 4) return 'yellow'
  return 'red'
}

const STATUS_LABELS: Record<number, { label: string; color: string }> = {
  0: { label: 'Voting', color: 'yellow' },
  1: { label: 'Accepted', color: 'green' },
  2: { label: 'Rejected', color: 'gray' },
}

type Props = {
  item: FeedItem
  cols: number
  config: RegistryConfig | null
}

export default function DetailPanel({ item, cols, config }: Props) {
  const statusInfo = STATUS_LABELS[item.status] ?? { label: 'Unknown', color: 'white' }
  const analysis = item.analysis
  const decimals = config?.tokenDecimals ?? 6
  const symbol = config?.tokenSymbol ?? 'USDC'
  const fmtBond = (amount: bigint) => `${formatUnits(amount, decimals)} ${symbol}`

  return (
    <Box flexDirection="column">
      {/* Title bar */}
      <Box justifyContent="space-between">
        <Text>
          <Text bold>Item #{item.id}</Text>
          {'  '}
          <Text color={statusInfo.color}>{statusInfo.label}</Text>
          {item.status === 0 && (
            <Text color="yellow"> ({formatTime(item.timeRemaining)})</Text>
          )}
        </Text>
        <Text dimColor>Esc: close  A: ask agent</Text>
      </Box>

      {/* URL + metadata */}
      <Box marginTop={1} flexDirection="column">
        <Text>
          <Text dimColor>URL:       </Text>
          <Text>{item.url}</Text>
        </Text>
        <Text>
          <Text dimColor>Submitter: </Text>
          <Text>{item.submitter}</Text>
        </Text>
        <Text>
          <Text dimColor>Bond:      </Text>
          <Text>{fmtBond(item.bond)}</Text>
        </Text>
        <Text>
          <Text dimColor>Submitted: </Text>
          <Text>{new Date(Number(item.submittedAt) * 1000).toISOString().replace('T', ' ').slice(0, 19)}</Text>
        </Text>
        {item.metadataHash && (
          <Text>
            <Text dimColor>Metadata:  </Text>
            <Text>{item.metadataHash}</Text>
          </Text>
        )}
      </Box>

      {/* Vote session info */}
      {item.status === 0 && item.voteSession && (
        <Box marginTop={1} flexDirection="column">
          <Text bold dimColor>── Votes ──</Text>
          <Text>
            <Text dimColor>Votes:      </Text>
            <Text color="green">{item.voteSession.votesFor.toString()} keep</Text>
            <Text> / </Text>
            <Text color="red">{item.voteSession.votesAgainst.toString()} remove</Text>
          </Text>
          <Text>
            <Text dimColor>Time:       </Text>
            <Text color={item.timeRemaining <= 0 ? 'green' : 'yellow'}>
              {formatTime(item.timeRemaining)}
            </Text>
          </Text>
        </Box>
      )}

      {/* Analysis */}
      {analysis && analysis.status === 'done' && (
        <Box marginTop={1} flexDirection="column">
          <Text bold dimColor>── Analysis ──</Text>
          <Box>
            <Text>
              Score: <Text bold color={scoreColor(analysis.score)}>{analysis.score.toFixed(1)}</Text> / 10
              {'  |  '}
              Source: <Text bold>{analysis.reliability}</Text> reliability
            </Text>
          </Box>
          <Box marginTop={1} flexDirection="column">
            <Text>
              <Text dimColor>  Article:   </Text>
              <Text color={scoreColor(analysis.articleScore)}>{analysis.articleScore.toFixed(1)}</Text>
            </Text>
            <Text>
              <Text dimColor>  Source:     </Text>
              <Text color={scoreColor(analysis.sourceScore)}>{analysis.sourceScore.toFixed(1)}</Text>
            </Text>
            <Text>
              <Text dimColor>  Submitter:  </Text>
              <Text color={scoreColor(analysis.submitterScore)}>{analysis.submitterScore.toFixed(1)}</Text>
            </Text>
            <Text>
              <Text dimColor>  Uniqueness: </Text>
              <Text color={scoreColor(analysis.uniquenessScore)}>{analysis.uniquenessScore.toFixed(1)}</Text>
            </Text>
          </Box>
          {analysis.summary && (
            <Box marginTop={1}>
              <Text>
                <Text dimColor>Summary: </Text>
                {analysis.summary}
              </Text>
            </Box>
          )}
          {analysis.reasoning && (
            <Box marginTop={1}>
              <Text>
                <Text dimColor>Reasoning: </Text>
                {analysis.reasoning}
              </Text>
            </Box>
          )}
        </Box>
      )}
      {analysis && analysis.status === 'pending' && (
        <Box marginTop={1}>
          <Text dimColor>Analysis in progress...</Text>
        </Box>
      )}
      {analysis && analysis.status === 'error' && (
        <Box marginTop={1}>
          <Text dimColor>Analysis: {analysis.error}</Text>
        </Box>
      )}
      {!analysis && (
        <Box marginTop={1}>
          <Text dimColor>No analysis available</Text>
        </Box>
      )}
    </Box>
  )
}
