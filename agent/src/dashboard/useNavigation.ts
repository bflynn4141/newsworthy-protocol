import { useState, useEffect, useCallback } from 'react'
import { useInput, useApp } from 'ink'
import type { FeedItem, ItemStatus } from './useFeedData.js'
import { SORT_MODES, type SortMode } from './sortItems.js'

const COLUMNS: ItemStatus[] = ['pending', 'accepted', 'rejected']

export type NavigationState = {
  selectedCol: number
  selectedRow: number
  selectedItem: FeedItem | null
  detailItem: FeedItem | null
}

export type ViewState = {
  showFlagged: boolean
  sortMode: SortMode
  showLeaderboard: boolean
}

// This hook MUST only be called when raw mode is supported.
// `items` must be the VISIBLE (filtered + sorted) items — nav indexes into them directly.
// `onViewChange` is called when the user presses F or S to change view settings.
export function useNavigation(
  items: Record<ItemStatus, FeedItem[]>,
  onViewChange: (updater: (prev: ViewState) => ViewState) => void,
): NavigationState {
  const { exit } = useApp()
  const [selectedCol, setSelectedCol] = useState(0)
  const [selectedRow, setSelectedRow] = useState(0)
  const [detailItem, setDetailItem] = useState<FeedItem | null>(null)

  const columnItems = useCallback(
    (col: number): FeedItem[] => items[COLUMNS[col]] ?? [],
    [items],
  )

  // Clamp selection when data changes (filter/sort may shrink a column)
  useEffect(() => {
    const list = columnItems(selectedCol)
    if (list.length === 0) {
      setSelectedRow(0)
    } else if (selectedRow >= list.length) {
      setSelectedRow(list.length - 1)
    }
  }, [items, selectedCol, selectedRow, columnItems])

  // Close detail if item disappears from visible list
  useEffect(() => {
    if (!detailItem) return
    const allVisible = [...items.pending, ...items.accepted, ...items.rejected]
    if (!allVisible.some(i => i.id === detailItem.id)) {
      setDetailItem(null)
    }
  }, [items, detailItem])

  useInput((input, key) => {
    if (input === 'q') { exit(); return }

    if (input === 'f' || input === 'F') {
      onViewChange(v => ({ ...v, showFlagged: !v.showFlagged }))
      return
    }
    if (input === 'l' || input === 'L') {
      onViewChange(v => ({ ...v, showLeaderboard: !v.showLeaderboard }))
      return
    }
    if (input === 's' || input === 'S') {
      onViewChange(v => {
        const idx = SORT_MODES.indexOf(v.sortMode)
        return { ...v, sortMode: SORT_MODES[(idx + 1) % SORT_MODES.length] ?? 'newest' }
      })
      return
    }

    if (key.escape) {
      if (detailItem) { setDetailItem(null) }
      return
    }

    if (key.return) {
      const current = columnItems(selectedCol)[selectedRow] ?? null
      if (current) { setDetailItem(prev => prev?.id === current.id ? null : current) }
      return
    }

    // Close detail on any navigation
    if (detailItem) { setDetailItem(null) }

    const currentItems = columnItems(selectedCol)

    if (key.leftArrow || (key.shift && key.tab)) {
      setSelectedCol(c => {
        const next = (c - 1 + COLUMNS.length) % COLUMNS.length
        const nextItems = columnItems(next)
        setSelectedRow(r => Math.min(r, Math.max(0, nextItems.length - 1)))
        return next
      })
    } else if (key.rightArrow || key.tab) {
      setSelectedCol(c => {
        const next = (c + 1) % COLUMNS.length
        const nextItems = columnItems(next)
        setSelectedRow(r => Math.min(r, Math.max(0, nextItems.length - 1)))
        return next
      })
    } else if (key.upArrow) {
      setSelectedRow(r => Math.max(0, r - 1))
    } else if (key.downArrow) {
      setSelectedRow(r => Math.min(Math.max(0, currentItems.length - 1), r + 1))
    }
  })

  const currentItems = columnItems(selectedCol)
  const selectedItem = currentItems[selectedRow] ?? null

  return { selectedCol, selectedRow, selectedItem, detailItem }
}
