// Evaluate a URL for newsworthiness using an LLM
// Returns a score 0-100 and a recommended action (submit / skip / vote-remove)
//
// Scoring rubric (each criterion 0-20, total 0-100):
//   1. Novelty       — new information, or rehash of known events?
//   2. Verifiability  — on-chain tx, primary source, or hearsay?
//   3. Impact         — affects protocols, users, markets materially?
//   4. Signal:Noise   — real news or engagement farming / rage-bait?
//   5. Source quality  — reputable outlet / known shill account?
//
// Action thresholds:
//   >= 60  → submit       (newsworthy, worth bonding USDC on)
//   40-59  → skip         (borderline, not worth the bond risk)
//   < 40   → vote-remove  (if already submitted by someone else)
//
// Config (env vars):
//   NEWSWORTHY_LLM_URL    — OpenAI-compatible base URL (default: http://localhost:11434)
//   NEWSWORTHY_LLM_MODEL  — Model name (default: llama3.2:3b)
//   NEWSWORTHY_LLM_KEY    — API key (optional, for cloud providers like OpenRouter)

export interface CriteriaScores {
  novelty: number        // 0-20
  verifiability: number  // 0-20
  impact: number         // 0-20
  signalToNoise: number  // 0-20
  sourceQuality: number  // 0-20
}

export interface EvaluationResult {
  score: number                              // 0-100 (sum of criteria)
  action: 'submit' | 'skip' | 'vote-remove'
  reasoning: string
  criteria: CriteriaScores
}

const SUBMIT_THRESHOLD = 60
const VOTE_REMOVE_THRESHOLD = 40

const LLM_URL = process.env['NEWSWORTHY_LLM_URL'] ?? 'http://localhost:11434'
const LLM_MODEL = process.env['NEWSWORTHY_LLM_MODEL'] ?? 'llama3.2:3b'
const LLM_KEY = process.env['NEWSWORTHY_LLM_KEY'] ?? ''
const LLM_TIMEOUT = 30_000

const SYSTEM_PROMPT = `You are a crypto news evaluator for a token-curated registry. Your job is to score submissions on whether they report real, newsworthy events.

News is an EVENT THAT HAPPENED — a launch, hack, partnership, governance vote, regulatory action, funding round, outage, migration, exploit, etc.

These are NOT news:
- Opinions, predictions, or hot takes
- Market commentary ("BTC looks bullish")
- Engagement farming, memes, self-promotion
- Threads that only summarize existing knowledge

Exception: A tweet from a builder/team announcing their own event counts as news (primary source).

Score each criterion 0-20. Be strict — most submissions should score 40-70. Only genuinely significant events from credible sources should score 80+.

Always respond in valid JSON with this exact schema:
{
  "novelty": <0-20>,
  "verifiability": <0-20>,
  "impact": <0-20>,
  "signalToNoise": <0-20>,
  "sourceQuality": <0-20>,
  "reasoning": "<2-3 sentence explanation>"
}`

async function callLlm(userPrompt: string): Promise<string | null> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT)

    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (LLM_KEY) headers['Authorization'] = `Bearer ${LLM_KEY}`

    const res = await fetch(`${LLM_URL}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: LLM_MODEL,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.2,
      }),
      signal: controller.signal,
    })
    clearTimeout(timer)

    if (!res.ok) return null
    const data = await res.json() as { choices?: { message?: { content?: string } }[] }
    return data.choices?.[0]?.message?.content ?? null
  } catch {
    return null
  }
}

function parseJson(raw: string | null): { novelty: number; verifiability: number; impact: number; signalToNoise: number; sourceQuality: number; reasoning: string } | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    if (typeof parsed.novelty === 'number' && typeof parsed.verifiability === 'number') {
      return parsed
    }
    return null
  } catch {
    // Try extracting JSON from markdown code block
    const match = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
    if (match) {
      try { return JSON.parse(match[1]) } catch { /* fall through */ }
    }
    return null
  }
}

export async function evaluate(
  url: string,
  content: string,
): Promise<EvaluationResult> {
  const userPrompt = `Evaluate this submission for a crypto news registry.

URL: ${url}

Content:
${content.slice(0, 3000)}

Score each criterion 0-20:
1. Novelty — Is this new information or a rehash?
2. Verifiability — Can it be verified (on-chain tx, official source)?
3. Impact — Does it materially affect protocols, users, or markets?
4. Signal:Noise — Is this real news or engagement farming?
5. Source quality — Is this from an official/primary source or secondhand?`

  const raw = await callLlm(userPrompt)
  const parsed = parseJson(raw)

  if (!parsed) {
    // LLM unavailable or failed — return neutral stub
    const criteria: CriteriaScores = {
      novelty: 10,
      verifiability: 10,
      impact: 10,
      signalToNoise: 10,
      sourceQuality: 10,
    }
    return {
      score: 50,
      action: 'skip',
      reasoning: 'LLM unavailable — returning neutral score. Configure NEWSWORTHY_LLM_URL and NEWSWORTHY_LLM_MODEL.',
      criteria,
    }
  }

  const criteria: CriteriaScores = {
    novelty: Math.min(20, Math.max(0, Math.round(parsed.novelty))),
    verifiability: Math.min(20, Math.max(0, Math.round(parsed.verifiability))),
    impact: Math.min(20, Math.max(0, Math.round(parsed.impact))),
    signalToNoise: Math.min(20, Math.max(0, Math.round(parsed.signalToNoise))),
    sourceQuality: Math.min(20, Math.max(0, Math.round(parsed.sourceQuality))),
  }

  const score =
    criteria.novelty +
    criteria.verifiability +
    criteria.impact +
    criteria.signalToNoise +
    criteria.sourceQuality

  const action: EvaluationResult['action'] =
    score >= SUBMIT_THRESHOLD
      ? 'submit'
      : score < VOTE_REMOVE_THRESHOLD
        ? 'vote-remove'
        : 'skip'

  return {
    score,
    action,
    reasoning: parsed.reasoning ?? 'No reasoning provided',
    criteria,
  }
}
