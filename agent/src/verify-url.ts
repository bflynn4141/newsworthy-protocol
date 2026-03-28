/**
 * Verify that a tweet URL points to a real, existing tweet.
 * Uses Twitter's public oEmbed endpoint (no API key required).
 */

export interface VerifyResult {
  valid: boolean
  title?: string
  reason?: string
}

export async function verifyTweetExists(url: string): Promise<VerifyResult> {
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 5000)

    const res = await fetch(
      `https://publish.twitter.com/oembed?url=${encodeURIComponent(url)}`,
      { signal: controller.signal }
    )

    clearTimeout(timeout)

    if (res.ok) {
      const data = await res.json() as { author_name?: string }
      return { valid: true, title: data.author_name ? `Tweet by ${data.author_name}` : undefined }
    }

    return { valid: false, reason: `Tweet not found (HTTP ${res.status})` }
  } catch (err: any) {
    if (err.name === 'AbortError') {
      return { valid: false, reason: 'oEmbed request timed out (5s)' }
    }
    return { valid: false, reason: `oEmbed check failed: ${err.message}` }
  }
}
