import { useState, useEffect, useRef } from 'react'

/**
 * Detects when a status value changes and returns true for a brief flash period.
 * Used to highlight items that just moved between columns.
 */
export function useStatusFlash(status: number, flashMs = 600): boolean {
  const prevRef = useRef(status)
  const [flashing, setFlashing] = useState(false)

  useEffect(() => {
    if (prevRef.current !== status) {
      prevRef.current = status
      setFlashing(true)
      const timer = setTimeout(() => setFlashing(false), flashMs)
      return () => clearTimeout(timer)
    }
  }, [status, flashMs])

  return flashing
}
