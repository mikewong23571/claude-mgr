import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue }

type HeaderValue = string | string[]

export type TrafficDirection = 'downstream' | 'upstream'

export type TrafficRecordInput = {
  direction: TrafficDirection
  phase: 'request' | 'response'
  method?: string
  url?: string
  status?: number
  headers?: Headers | Record<string, string>
  body?: unknown
}

export type DebugTrafficRecorder = {
  record(input: TrafficRecordInput): void
}

const sensitiveHeaderNames = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'api-key',
  'anthropic-api-key',
  'anthropic-auth-token',
  'proxy-authorization',
])

function timestampForFilename(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, '-')
}

function headerEntries(input: Headers | Record<string, string>): Array<[string, string]> {
  if (input instanceof Headers) {
    return [...input.entries()]
  }
  return Object.entries(input)
}

function sanitizeHeaders(input?: Headers | Record<string, string>): Record<string, HeaderValue> {
  if (!input) return {}
  const output: Record<string, HeaderValue> = {}
  for (const [rawName, value] of headerEntries(input)) {
    const name = rawName.toLowerCase()
    const sanitized = sensitiveHeaderNames.has(name) ? '[redacted]' : value
    const existing = output[name]
    if (existing === undefined) {
      output[name] = sanitized
    } else if (Array.isArray(existing)) {
      existing.push(sanitized)
    } else {
      output[name] = [existing, sanitized]
    }
  }
  return output
}

function objectKeys(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
  return Object.keys(value as Record<string, unknown>).sort()
}

function summarizeText(value: unknown): Record<string, JsonValue> {
  if (typeof value !== 'string') return { kind: typeof value }
  return {
    kind: 'string',
    length: value.length,
    hasBillingHeader: value.includes('x-anthropic-billing-header'),
    hasClaudeCodeMarker: value.includes('Claude Code'),
  }
}

function summarizeContent(value: unknown): Record<string, JsonValue> {
  if (typeof value === 'string') {
    return { kind: 'string', length: value.length }
  }
  if (!Array.isArray(value)) {
    return { kind: value === null ? 'null' : typeof value }
  }
  const blockTypes: Record<string, number> = {}
  for (const block of value) {
    const type =
      block && typeof block === 'object' && 'type' in block
        ? String((block as { type?: unknown }).type)
        : typeof block
    blockTypes[type] = (blockTypes[type] ?? 0) + 1
  }
  return {
    kind: 'blocks',
    count: value.length,
    blockTypes,
  }
}

function summarizeMessages(value: unknown): Record<string, JsonValue> {
  if (!Array.isArray(value)) return { kind: value === undefined ? 'missing' : typeof value }
  const roles: Record<string, number> = {}
  const contentKinds: Record<string, number> = {}
  for (const message of value) {
    if (!message || typeof message !== 'object') {
      contentKinds[typeof message] = (contentKinds[typeof message] ?? 0) + 1
      continue
    }
    const item = message as { role?: unknown; content?: unknown }
    const role = typeof item.role === 'string' ? item.role : 'unknown'
    roles[role] = (roles[role] ?? 0) + 1
    const summary = summarizeContent(item.content)
    const kind = String(summary.kind)
    contentKinds[kind] = (contentKinds[kind] ?? 0) + 1
  }
  return {
    kind: 'messages',
    count: value.length,
    roles,
    contentKinds,
  }
}

function summarizeSystem(value: unknown): Record<string, JsonValue> {
  if (value === undefined) return { kind: 'missing' }
  if (typeof value === 'string') return summarizeText(value)
  if (!Array.isArray(value)) return { kind: value === null ? 'null' : typeof value }
  return {
    kind: 'blocks',
    count: value.length,
    blockTypes: value.reduce<Record<string, number>>((acc, block) => {
      const type =
        block && typeof block === 'object' && 'type' in block
          ? String((block as { type?: unknown }).type)
          : typeof block
      acc[type] = (acc[type] ?? 0) + 1
      return acc
    }, {}),
    containsBillingHeader: value.some(block => {
      if (!block || typeof block !== 'object') return false
      const text = (block as { text?: unknown }).text
      return typeof text === 'string' && text.includes('x-anthropic-billing-header')
    }),
  }
}

function summarizeBody(body: unknown): Record<string, JsonValue> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { kind: body === null ? 'null' : typeof body }
  }
  const record = body as Record<string, unknown>
  return {
    kind: 'object',
    keys: objectKeys(record),
    model: typeof record.model === 'string' ? record.model : null,
    stream: typeof record.stream === 'boolean' ? record.stream : null,
    messageSummary: summarizeMessages(record.messages),
    systemSummary: summarizeSystem(record.system),
    toolCount: Array.isArray(record.tools) ? record.tools.length : null,
    hasMetadata: record.metadata !== undefined,
    metadataKeys: objectKeys(record.metadata),
    hasThinking: record.thinking !== undefined,
    hasBetas: record.betas !== undefined,
    betaCount: Array.isArray(record.betas) ? record.betas.length : null,
  }
}

export class JsonlDebugTrafficRecorder implements DebugTrafficRecorder {
  readonly filePath: string

  constructor(outputDir: string, now = new Date()) {
    mkdirSync(outputDir, { recursive: true })
    this.filePath = join(outputDir, `traffic-${timestampForFilename(now)}.jsonl`)
  }

  record(input: TrafficRecordInput): void {
    const event = {
      timestamp: new Date().toISOString(),
      direction: input.direction,
      phase: input.phase,
      method: input.method ?? null,
      url: input.url ?? null,
      status: input.status ?? null,
      headers: sanitizeHeaders(input.headers),
      bodySummary: input.body === undefined ? null : summarizeBody(input.body),
    }
    appendFileSync(this.filePath, `${JSON.stringify(event)}\n`)
  }
}

export function createDebugTrafficRecorderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): DebugTrafficRecorder | undefined {
  const enabled =
    env.CLAUDE_MGR_DEBUG_TRAFFIC === '1' || Boolean(env.CLAUDE_MGR_DEBUG_DIR)
  if (!enabled) return undefined
  return new JsonlDebugTrafficRecorder(env.CLAUDE_MGR_DEBUG_DIR ?? 'data/debug')
}

