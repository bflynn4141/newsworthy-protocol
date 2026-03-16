import type { FeedItem } from './useFeedData.js'

export type SortMode = 'newest' | 'score' | 'reputation' | 'time'

export const SORT_MODES: SortMode[] = ['newest', 'score', 'reputation', 'time']

export const SORT_LABELS: Record<SortMode, string> = {
  newest: 'newest',
  score: 'score',
  reputation: 'reputation',
  time: 'time left',
}

function getTimeRemaining(item: FeedItem): number {
  if (item.status === 0) return item.timeRemaining
  return Infinity // no timer — sort last
}

export function sortItems(items: FeedItem[], mode: SortMode): FeedItem[] {
  const sorted = [...items]
  switch (mode) {
    case 'newest':
      return sorted.sort((a, b) => b.id - a.id)
    case 'score':
      return sorted.sort((a, b) => {
        const sa = a.analysis?.status === 'done' ? a.analysis.score : -1
        const sb = b.analysis?.status === 'done' ? b.analysis.score : -1
        return sb - sa
      })
    case 'reputation':
      return sorted.sort((a, b) => {
        const ra = a.analysis?.submitterScore ?? -1
        const rb = b.analysis?.submitterScore ?? -1
        return rb - ra
      })
    case 'time':
      return sorted.sort((a, b) => getTimeRemaining(a) - getTimeRemaining(b))
  }
}
