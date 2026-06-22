export type MessageUsageSummary = {
  inputTokens?: number | null
  outputTokens?: number | null
}

export function extractUsageSummary(body: unknown): MessageUsageSummary {
  if (!body || typeof body !== 'object') {
    return {}
  }
  const usage = (body as { usage?: unknown }).usage
  if (!usage || typeof usage !== 'object') {
    return {}
  }
  const input = (usage as { input_tokens?: unknown }).input_tokens
  const output = (usage as { output_tokens?: unknown }).output_tokens
  return {
    inputTokens: typeof input === 'number' ? input : null,
    outputTokens: typeof output === 'number' ? output : null,
  }
}
