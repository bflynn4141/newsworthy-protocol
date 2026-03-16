import React from 'react'
import { Box, Text } from 'ink'
import type { FeedItem, ItemStatus } from './useFeedData.js'
import ItemCard from './ItemCard.js'

const HEADERS: Record<ItemStatus, { icon: string; color: string; label: string }> = {
  pending:    { icon: '\u23F3', color: 'yellow',    label: 'VOTING' },
  accepted:  { icon: '\u2713',  color: 'green',     label: 'ACCEPTED' },
  rejected:  { icon: '\u2717',  color: 'gray',      label: 'REJECTED' },
}

const EMPTY_MESSAGES: Record<ItemStatus, string[]> = {
  pending:    ['No items yet.', "Use 'submit' to", 'add the first.'],
  accepted:  ['No accepted', 'items yet.'],
  rejected:  ['No rejected', 'items.'],
}

const MAX_VISIBLE = 10

type Props = {
  status: ItemStatus
  items: FeedItem[]
  stacked: boolean
  isActive?: boolean
  selectedIndex?: number
  minVotes: number
}

export default function StatusColumn({ status, items, stacked, isActive, selectedIndex, minVotes }: Props) {
  const header = HEADERS[status]
  const visible = items.slice(0, MAX_VISIBLE)
  const overflow = items.length - MAX_VISIBLE

  return (
    <Box
      flexDirection="column"
      flexGrow={1}
      flexBasis={0}
      paddingX={1}
    >
      <Text bold color={header.color}>
        {isActive ? '\u25B8 ' : '  '}
        {header.icon} {header.label} ({items.length})
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {items.length === 0 ? (
          EMPTY_MESSAGES[status].map((line, i) => (
            <Text key={i} dimColor>{line}</Text>
          ))
        ) : (
          <>
            {visible.map((item, i) => (
              <ItemCard
                key={item.id}
                item={item}
                isSelected={isActive && selectedIndex === i}
                minVotes={minVotes}
              />
            ))}
            {overflow > 0 && (
              <Text dimColor>(+{overflow} more)</Text>
            )}
          </>
        )}
      </Box>
    </Box>
  )
}
