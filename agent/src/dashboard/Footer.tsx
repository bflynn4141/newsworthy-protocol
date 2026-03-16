import React from 'react'
import { Box, Text } from 'ink'
import type { FeedItem } from './useFeedData.js'
import { SORT_LABELS, type SortMode } from './sortItems.js'

type Props = {
  lastRefresh: number
  error: string | null
  selectedItem?: FeedItem | null
  interactive?: boolean
  flaggedCount?: number
  showFlagged?: boolean
  sortMode?: SortMode
}

export default function Footer({ lastRefresh, error, selectedItem, interactive, flaggedCount, showFlagged, sortMode }: Props) {
  return (
    <Box flexDirection="column">
      {selectedItem && (
        <Box>
          <Text dimColor>
            Selected: <Text bold>#{selectedItem.id}</Text> {selectedItem.url}
          </Text>
        </Box>
      )}
      <Box justifyContent="space-between">
        {error ? (
          <Text color="red">Error: {error}</Text>
        ) : (
          <Text dimColor>Last refresh: {Math.max(0, lastRefresh)}s ago</Text>
        )}
        {interactive ? (
          <Text dimColor>
            {'\u2190\u2192\u2191\u2193'} nav  Enter: detail  S: sort ({SORT_LABELS[sortMode ?? 'newest']})
            {'  L: leaderboard'}
            {flaggedCount ? `  F: ${showFlagged ? 'hide' : 'show'} flagged (${flaggedCount})` : ''}
            {'  '}Q: quit
          </Text>
        ) : (
          <Text dimColor>Press Ctrl+C to exit</Text>
        )}
      </Box>
    </Box>
  )
}
