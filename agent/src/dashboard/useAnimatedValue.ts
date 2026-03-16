import { useState, useEffect, useRef } from 'react'

/**
 * Smoothly interpolates a numeric value over time.
 * Returns the current animated value that lerps from previous to target.
 * Only runs an interval while animating — idle when stable.
 */
export function useAnimatedValue(target: number, durationMs = 300): number {
  const [current, setCurrent] = useState(target)
  const startRef = useRef(target)
  const startTimeRef = useRef<number | null>(null)

  useEffect(() => {
    if (target === current && startTimeRef.current === null) return

    // Capture where we're starting from
    startRef.current = current
    startTimeRef.current = Date.now()

    const interval = setInterval(() => {
      const elapsed = Date.now() - startTimeRef.current!
      const progress = Math.min(1, elapsed / durationMs)
      // Ease-out cubic for natural deceleration
      const eased = 1 - Math.pow(1 - progress, 3)
      const value = startRef.current + (target - startRef.current) * eased

      if (progress >= 1) {
        setCurrent(target)
        startTimeRef.current = null
        clearInterval(interval)
      } else {
        setCurrent(value)
      }
    }, 33) // ~30fps

    return () => clearInterval(interval)
  }, [target, durationMs])

  return current
}
