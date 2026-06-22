import type { DebugTrafficRecorder } from '../debug/traffic-recorder.js'
import type { OAuthToken } from '../domain/types.js'
import { UpstreamError, parseUpstreamErrorBody } from '../errors.js'
import type { FetchLike } from '../http/fetch-types.js'

export type UpstreamClaudeCliClientOptions = {
  baseApiUrl?: string
  fetch?: FetchLike
  debugRecorder?: DebugTrafficRecorder
  timeoutMs?: number
}

export type UpstreamClaudeCliResponse = {
  status: number
  headers: Headers
  body: unknown
  upstreamRequestId?: string
}

export type ClaudeCliEndpoint = 'bootstrap' | 'usage'

async function parseErrorResponse(response: Response): Promise<never> {
  const text = await response.text()
  let body: unknown = text
  if (text) {
    try {
      body = JSON.parse(text) as unknown
    } catch {
      body = text
    }
  }
  const parsed = parseUpstreamErrorBody(body)
  throw new UpstreamError({
    status: response.status,
    message: parsed.message,
    body,
    requestId:
      response.headers.get('request-id') ??
      response.headers.get('anthropic-request-id') ??
      undefined,
    upstreamType: parsed.type,
  })
}

function requestIdFromHeaders(headers: Headers): string | undefined {
  return (
    headers.get('request-id') ??
    headers.get('anthropic-request-id') ??
    undefined
  )
}

function timeoutSignal(parent: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const signal = AbortSignal.timeout(timeoutMs)
  return parent ? AbortSignal.any([parent, signal]) : signal
}

function endpointPath(endpoint: ClaudeCliEndpoint): string {
  switch (endpoint) {
    case 'bootstrap':
      return '/api/claude_cli/bootstrap'
    case 'usage':
      return '/api/oauth/usage'
  }
}

function buildHeaders(input: {
  token: OAuthToken
  userAgent: string
}): Record<string, string> {
  return {
    Authorization: `Bearer ${input.token.accessToken}`,
    'Content-Type': 'application/json',
    'User-Agent': input.userAgent,
    'anthropic-beta': 'oauth-2025-04-20',
  }
}

export class UpstreamClaudeCliClient {
  private readonly baseApiUrl: string
  private readonly fetch: FetchLike
  private readonly debugRecorder?: DebugTrafficRecorder
  private readonly timeoutMs: number

  constructor(options: UpstreamClaudeCliClientOptions = {}) {
    this.baseApiUrl = options.baseApiUrl ?? 'https://api.anthropic.com'
    this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis)
    this.debugRecorder = options.debugRecorder
    this.timeoutMs = options.timeoutMs ?? 5000
  }

  async get(input: {
    endpoint: ClaudeCliEndpoint
    token: OAuthToken
    userAgent: string
    signal?: AbortSignal
  }): Promise<UpstreamClaudeCliResponse> {
    const url = `${this.baseApiUrl}${endpointPath(input.endpoint)}`
    const headers = buildHeaders({
      token: input.token,
      userAgent: input.userAgent,
    })
    this.debugRecorder?.record({
      direction: 'upstream',
      phase: 'request',
      method: 'GET',
      url,
      headers,
    })
    const response = await this.fetch(url, {
      method: 'GET',
      headers,
      signal: timeoutSignal(input.signal, this.timeoutMs),
    })
    this.debugRecorder?.record({
      direction: 'upstream',
      phase: 'response',
      method: 'GET',
      url,
      status: response.status,
      headers: response.headers,
    })

    if (!response.ok) {
      await parseErrorResponse(response)
    }

    return {
      status: response.status,
      headers: response.headers,
      body: await response.json(),
      upstreamRequestId: requestIdFromHeaders(response.headers),
    }
  }
}
