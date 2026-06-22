import { randomUUID } from 'node:crypto'
import type { QuotaSnapshot } from '../domain/types.js'

export function quotaSnapshotFromHeaders(input: {
  headers: Headers
  accountUuid: string
  tokenLabel?: string | null
  nowMs?: number
}): QuotaSnapshot | null {
  const status = input.headers.get('anthropic-ratelimit-unified-status')
  if (!status) {
    return null
  }

  const utilization = input.headers.get('anthropic-ratelimit-unified-utilization')
  const resetsAt = input.headers.get('anthropic-ratelimit-unified-reset')

  return {
    id: randomUUID(),
    accountUuid: input.accountUuid,
    tokenLabel: input.tokenLabel ?? null,
    status,
    rateLimitType: input.headers.get('anthropic-ratelimit-unified-type'),
    utilization: utilization ? Number(utilization) : null,
    resetsAt: resetsAt ? Date.parse(resetsAt) : null,
    createdAt: input.nowMs ?? Date.now(),
  }
}
