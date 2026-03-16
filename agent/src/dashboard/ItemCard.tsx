import React from 'react'
import { Box, Text } from 'ink'
import type { FeedItem } from './useFeedData.js'
import { useAnimatedValue } from './useAnimatedValue.js'
import { useStatusFlash } from './useStatusFlash.js'

function formatTime(seconds: number): string {
  if (seconds <= 0) return '\u2713'
  if (seconds < 60) return `${seconds}s`
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return s > 0 ? `${m}m${s}s` : `${m}m`
}

function truncateUrl(url: string, maxLen: number): string {
  try {
    const u = new URL(url)
    const display = u.hostname + u.pathname
    return display.length > maxLen ? display.slice(0, maxLen - 1) + '\u2026' : display
  } catch {
    return url.length > maxLen ? url.slice(0, maxLen - 1) + '\u2026' : url
  }
}

function scoreColor(score: number): string {
  if (score >= 7) return 'green'
  if (score >= 4) return 'yellow'
  return 'red'
}

function quorumBar(totalVotes: number, minVotes: number): string {
  const filled = Math.min(totalVotes, minVotes)
  const empty = Math.max(0, minVotes - filled)
  return '\u2588'.repeat(filled) + '\u2591'.repeat(empty)
}

function shortAddress(addr: string): string {
  return addr.slice(0, 4) + '\u2026'
}

function truncateSummary(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text
  return text.slice(0, maxLen - 1) + '\u2026'
}

type Props = {
  item: FeedItem
  isSelected?: boolean
  minVotes?: number
}

export default function ItemCard({ item, isSelected, minVotes = 1 }: Props) {
  const urlDisplay = truncateUrl(item.url, 18)
  const analysis = item.analysis
  const addr = shortAddress(item.submitter)
  const rep = analysis?.submitterScore

  // Animated vote counts for voting items
  const votesFor = useAnimatedValue(item.voteSession ? Number(item.voteSession.votesFor) : 0, 400)
  const votesAgainst = useAnimatedValue(item.voteSession ? Number(item.voteSession.votesAgainst) : 0, 400)

  // Status flash — highlight when item changes status
  const isFlashing = useStatusFlash(item.status)
  const flashColor = item.status === 1 ? 'green' : item.status === 2 ? 'red' : 'cyan'

  // Time line (voting items only)
  const hasTimer = item.status === 0
  const timerSeconds = item.timeRemaining
  const timerExpired = hasTimer && timerSeconds <= 0

  // Countdown urgency: red when < 60s
  const timerColor = timerExpired ? 'green' : timerSeconds < 60 ? 'red' : 'yellow'

  return (
    <Box flexDirection="column" marginBottom={1}>
      {/* Line 1: ID + URL */}
      <Text>
        {isSelected ? <Text color="cyan" bold>{'\u25B8 '}</Text> : '  '}
        {isFlashing ? (
          <Text bold inverse={!!isSelected} color={flashColor}>#{item.id}</Text>
        ) : (
          <Text bold inverse={!!isSelected}>#{item.id}</Text>
        )}
        {'  '}
        {isFlashing ? (
          <Text color={flashColor}>{urlDisplay}</Text>
        ) : isSelected ? (
          <Text color="cyan">{urlDisplay}</Text>
        ) : (
          <Text dimColor>{urlDisplay}</Text>
        )}
      </Text>

      {/* Line 2 (voting only): Quorum progress bar */}
      {item.status === 0 && item.voteSession && (
        <Text>
          {'  '}
          <Text color="cyan">
            {quorumBar(Math.round(votesFor + votesAgainst), minVotes)}
          </Text>
          {' '}
          <Text dimColor>
            {Math.round(votesFor + votesAgainst)}/{minVotes} votes
          </Text>
        </Text>
      )}

      {/* Line 3: Timer + Address + Reputation (or just Address + Rep for terminal states) */}
      <Text>
        {'  '}
        {hasTimer && (
          <>
            <Text color={timerColor} bold={timerSeconds < 60 && timerSeconds > 0}>
              {'\u23F1'} {formatTime(timerSeconds)}
            </Text>
            {'  '}
          </>
        )}
        <Text dimColor>{addr}</Text>
        {rep != null && (
          <>
            {' '}
            <Text color="yellow">{'\u2605'}</Text>
            {' '}
            <Text>{rep.toFixed(1)}</Text>
          </>
        )}
      </Text>

      {/* Line 4: Analysis score + summary (or status) */}
      {analysis && analysis.status === 'done' && (
        <Text>
          {'  '}
          {analysis.flagged && <Text color="red">{'\u2691'} </Text>}
          <Text color={scoreColor(analysis.score)}>{analysis.score.toFixed(1)}</Text>
          <Text dimColor> {truncateSummary(analysis.flagged ? (analysis.flagReason ?? '') : (analysis.summary || ''), 16)}</Text>
        </Text>
      )}
      {analysis && analysis.status === 'pending' && (
        <Text>
          {'  '}
          <Text dimColor>Analyzing...</Text>
        </Text>
      )}
      {analysis && analysis.status === 'error' && (
        <Text>
          {'  '}
          <Text dimColor>{analysis.error ?? 'Analysis error'}</Text>
        </Text>
      )}
    </Box>
  )
}
