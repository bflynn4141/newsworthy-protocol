import React from 'react'
import { Box, Text, useStdin } from 'ink'
import type { Address, PublicClient } from 'viem'
import { useFeedData } from './useFeedData.js'
import type { ItemStatus, FeedItem } from './useFeedData.js'
import { useNavigation, type ViewState } from './useNavigation.js'
import { sortItems, SORT_LABELS, type SortMode } from './sortItems.js'
import Header from './Header.js'
import StatusColumn from './StatusColumn.js'
import Footer from './Footer.js'
import DetailPanel from './DetailPanel.js'
import LeaderboardPanel from './LeaderboardPanel.js'

const COLUMNS: ItemStatus[] = ['pending', 'accepted', 'rejected']

type Props = {
  client: PublicClient
  registryAddr: Address
  agentBookAddr: Address
  deployer: Address
  isTest: boolean
  refreshMs?: number
}

// Compute visible items (filtered + sorted) from raw data
function computeVisibleItems(
  items: Record<ItemStatus, FeedItem[]>,
  showFlagged: boolean,
  sortMode: SortMode,
): Record<ItemStatus, FeedItem[]> {
  return {
    pending: sortItems(items.pending.filter(i => showFlagged || !i.analysis?.flagged), sortMode),
    accepted: sortItems(items.accepted.filter(i => showFlagged || !i.analysis?.flagged), sortMode),
    rejected: sortItems(items.rejected.filter(i => showFlagged || !i.analysis?.flagged), sortMode),
  }
}

// Interactive layer — only mounted when raw mode is supported
function InteractiveDashboard({ data, isTest, refreshMs, cols, client, registryAddr }: {
  data: ReturnType<typeof useFeedData>
  isTest: boolean
  refreshMs: number
  cols: number
  client: PublicClient
  registryAddr: Address
}) {
  // View state lives here so visible items are computed BEFORE navigation
  const [viewState, setViewState] = React.useState<ViewState>({ showFlagged: false, sortMode: 'newest' as SortMode, showLeaderboard: false })

  // Compute visible items from filter + sort
  const visibleItems = computeVisibleItems(data.items, viewState.showFlagged, viewState.sortMode)

  // Nav operates on visible items — indexes always match what's displayed
  const nav = useNavigation(visibleItems, setViewState)

  const stacked = cols < 80

  return (
    <DashboardLayout
      data={data}
      visibleItems={visibleItems}
      isTest={isTest}
      refreshMs={refreshMs}
      cols={cols}
      stacked={stacked}
      selectedCol={nav.selectedCol}
      selectedRow={nav.selectedRow}
      selectedItem={nav.selectedItem}
      detailItem={nav.detailItem}
      showFlagged={viewState.showFlagged}
      showLeaderboard={viewState.showLeaderboard}
      sortMode={viewState.sortMode}
      interactive={true}
      client={client}
      registryAddr={registryAddr}
    />
  )
}

// Shared layout used by both interactive and read-only modes
function DashboardLayout({ data, visibleItems, isTest, refreshMs, cols, stacked, selectedCol, selectedRow, selectedItem, detailItem, showFlagged, showLeaderboard, sortMode, interactive, client, registryAddr }: {
  data: ReturnType<typeof useFeedData>
  visibleItems: Record<ItemStatus, FeedItem[]>
  isTest: boolean
  refreshMs: number
  cols: number
  stacked: boolean
  selectedCol: number
  selectedRow: number
  selectedItem: FeedItem | null
  detailItem?: FeedItem | null
  showFlagged?: boolean
  showLeaderboard?: boolean
  sortMode?: SortMode
  interactive: boolean
  client?: PublicClient
  registryAddr?: Address
}) {
  const minVotes = data.config ? Number(data.config.minVotes) : 1

  return (
    <Box flexDirection="column" borderStyle="single" paddingX={1}>
      <Header
        isTest={isTest}
        config={data.config}
        totalItems={data.totalItems}
        balance={data.balance}
        newsBalance={data.newsBalance}
        withdrawable={data.withdrawable}
        dailySubmissions={data.dailySubmissions}
        dailyResetIn={data.dailyResetIn}
        llm={data.llm}
        flaggedCount={data.flaggedCount}
        showFlagged={showFlagged ?? false}
      />
      <Box marginY={0}>
        <Text dimColor>{'─'.repeat(Math.max(1, cols - 4))}</Text>
      </Box>
      <Box flexDirection={stacked ? 'column' : 'row'}>
        {COLUMNS.map((status, i) => (
          <React.Fragment key={status}>
            {!stacked && i > 0 && (
              <Box flexDirection="column" width={1}>
                <Text dimColor>│</Text>
              </Box>
            )}
            <StatusColumn
              status={status}
              items={visibleItems[status]}
              stacked={stacked}
              isActive={interactive && selectedCol === i}
              selectedIndex={interactive && selectedCol === i ? selectedRow : undefined}
              minVotes={minVotes}
            />
          </React.Fragment>
        ))}
      </Box>
      {detailItem && (
        <>
          <Box marginY={0}>
            <Text dimColor>{'─'.repeat(Math.max(1, cols - 4))}</Text>
          </Box>
          <DetailPanel item={detailItem} cols={cols} config={data.config} />
        </>
      )}
      {showLeaderboard && client && registryAddr && (
        <>
          <Box marginY={0}>
            <Text dimColor>{'─'.repeat(Math.max(1, cols - 4))}</Text>
          </Box>
          <LeaderboardPanel client={client} registryAddr={registryAddr} />
        </>
      )}
      <Box marginY={0}>
        <Text dimColor>{'─'.repeat(Math.max(1, cols - 4))}</Text>
      </Box>
      <Footer
        lastRefresh={data.lastRefresh}
        error={data.error}
        selectedItem={selectedItem}
        interactive={interactive}
        flaggedCount={data.flaggedCount}
        showFlagged={showFlagged ?? false}
        sortMode={sortMode ?? 'newest'}
      />
    </Box>
  )
}

export default function App({ client, registryAddr, agentBookAddr, deployer, isTest, refreshMs = 5000 }: Props) {
  const data = useFeedData(client, registryAddr, agentBookAddr, deployer, refreshMs)
  const { isRawModeSupported } = useStdin()
  const [cols, setCols] = React.useState(process.stdout.columns ?? 80)

  React.useEffect(() => {
    const onResize = () => setCols(process.stdout.columns ?? 80)
    process.stdout.on('resize', onResize)
    return () => { process.stdout.off('resize', onResize) }
  }, [])

  if (data.loading && !data.config) {
    return (
      <Box paddingX={1}>
        <Text>Loading registry data...</Text>
      </Box>
    )
  }

  // Mount the interactive layer only when raw mode is available
  if (isRawModeSupported) {
    return (
      <InteractiveDashboard
        data={data}
        isTest={isTest}
        refreshMs={refreshMs}
        cols={cols}
        client={client}
        registryAddr={registryAddr}
      />
    )
  }

  // Read-only fallback (piped stdin, CI, etc.) — show all items, default sort
  const readOnlyItems = computeVisibleItems(data.items, false, 'newest')
  return (
    <DashboardLayout
      data={data}
      visibleItems={readOnlyItems}
      isTest={isTest}
      refreshMs={refreshMs}
      cols={cols}
      stacked={cols < 80}
      selectedCol={0}
      selectedRow={0}
      selectedItem={null}
      interactive={false}
    />
  )
}
