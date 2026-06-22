import type { DebugTrafficRecorder } from '../debug/traffic-recorder.js'
import type { FetchLike } from '../http/fetch-types.js'

export type ProxyEndpointKind =
  | 'files'
  | 'event_logging'
  | 'trusted_devices'

export type ApiProxyClientOptions = {
  baseApiUrl?: string
  fetch?: FetchLike
  debugRecorder?: DebugTrafficRecorder
  userAgent?: string
}

export type ApiProxyRequest = {
  method: string
  pathWithSearch: string
  endpointKind: ProxyEndpointKind
  headers: Headers
  body?: RequestInit['body']
  accessToken?: string
  signal?: AbortSignal
}

export type ApiProxyResponse = {
  status: number
  headers: Headers
  body: ReadableStream<Uint8Array> | null
  upstreamRequestId?: string
}

const hopByHopHeaders = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

const downstreamOnlyHeaders = new Set([
  'host',
  'content-length',
  'x-claude-mgr-client-id',
  'x-claude-mgr-pool-id',
  'x-claude-mgr-session-id',
  'x-claude-code-session-id',
])

const replacedAuthHeaders = new Set([
  'authorization',
  'x-api-key',
  'api-key',
  'anthropic-api-key',
  'anthropic-auth-token',
  'anthropic-organization-id',
])

function requestIdFromHeaders(headers: Headers): string | undefined {
  return (
    headers.get('request-id') ??
    headers.get('anthropic-request-id') ??
    undefined
  )
}

function shouldForwardRequestHeader(name: string): boolean {
  const lower = name.toLowerCase()
  return (
    !hopByHopHeaders.has(lower) &&
    !downstreamOnlyHeaders.has(lower) &&
    !replacedAuthHeaders.has(lower)
  )
}

function shouldForwardResponseHeader(name: string): boolean {
  const lower = name.toLowerCase()
  return !hopByHopHeaders.has(lower) && lower !== 'content-length'
}

function buildHeaders(input: {
  endpointKind: ProxyEndpointKind
  downstreamHeaders: Headers
  accessToken?: string
  userAgent: string
}): Headers {
  const headers = new Headers()
  for (const [name, value] of input.downstreamHeaders.entries()) {
    if (shouldForwardRequestHeader(name)) {
      headers.set(name, value)
    }
  }

  if (input.accessToken) {
    headers.set('Authorization', `Bearer ${input.accessToken}`)
  }
  if (!headers.has('User-Agent')) {
    headers.set('User-Agent', input.userAgent)
  }

  if (input.endpointKind === 'files') {
    if (!headers.has('anthropic-version')) {
      headers.set('anthropic-version', '2023-06-01')
    }
    if (!headers.has('anthropic-beta')) {
      headers.set('anthropic-beta', 'files-api-2025-04-14,oauth-2025-04-20')
    }
  }

  if (
    (input.endpointKind === 'event_logging' ||
      input.endpointKind === 'trusted_devices') &&
    !headers.has('Content-Type')
  ) {
    headers.set('Content-Type', 'application/json')
  }

  return headers
}

function responseHeadersFromUpstream(headers: Headers): Headers {
  const output = new Headers()
  for (const [name, value] of headers.entries()) {
    if (shouldForwardResponseHeader(name)) {
      output.set(name, value)
    }
  }
  return output
}

export class ApiProxyClient {
  private readonly baseApiUrl: string
  private readonly fetch: FetchLike
  private readonly debugRecorder?: DebugTrafficRecorder
  private readonly userAgent: string

  constructor(options: ApiProxyClientOptions = {}) {
    this.baseApiUrl = options.baseApiUrl ?? 'https://api.anthropic.com'
    this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis)
    this.debugRecorder = options.debugRecorder
    this.userAgent = options.userAgent ?? 'claude-mgr/0.1.0'
  }

  async forward(request: ApiProxyRequest): Promise<ApiProxyResponse> {
    const url = `${this.baseApiUrl}${request.pathWithSearch}`
    const headers = buildHeaders({
      endpointKind: request.endpointKind,
      downstreamHeaders: request.headers,
      accessToken: request.accessToken,
      userAgent: this.userAgent,
    })

    this.debugRecorder?.record({
      direction: 'upstream',
      phase: 'request',
      method: request.method,
      url,
      headers,
    })

    const init: RequestInit & { duplex?: 'half' } = {
      method: request.method,
      headers,
      body: request.body ?? null,
      signal: request.signal,
    }
    if (request.body) {
      init.duplex = 'half'
    }
    const response = await this.fetch(url, init)

    this.debugRecorder?.record({
      direction: 'upstream',
      phase: 'response',
      method: request.method,
      url,
      status: response.status,
      headers: response.headers,
    })

    return {
      status: response.status,
      headers: responseHeadersFromUpstream(response.headers),
      body: response.body,
      upstreamRequestId: requestIdFromHeaders(response.headers),
    }
  }
}
