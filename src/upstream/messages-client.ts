import type { DebugTrafficRecorder } from '../debug/traffic-recorder.js'
import type { AdaptedMessageRequest } from '../messages/adapter.js'
import { UpstreamError, parseUpstreamErrorBody } from '../errors.js'
import type { FetchLike } from '../http/fetch-types.js'

export type UpstreamMessagesClientOptions = {
  baseApiUrl?: string
  fetch?: FetchLike
  debugRecorder?: DebugTrafficRecorder
}

export type UpstreamMessagesResponse = {
  status: number
  headers: Headers
  body: unknown
  upstreamRequestId?: string
  clientRequestId: string
}

export type UpstreamMessagesStreamResponse = {
  status: number
  headers: Headers
  stream: ReadableStream<Uint8Array>
  upstreamRequestId?: string
  clientRequestId: string
}

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

function buildMessagesHeaders(request: AdaptedMessageRequest): Record<string, string> {
  const betas = request.body.betas
  const hasAnthropicBeta = Object.keys(request.headers).some(
    key => key.toLowerCase() === 'anthropic-beta',
  )
  return {
    ...request.headers,
    'Content-Type': 'application/json',
    ...(Object.keys(request.headers).some(
      key => key.toLowerCase() === 'anthropic-version',
    )
      ? {}
      : { 'anthropic-version': '2023-06-01' }),
    ...(betas !== undefined && !hasAnthropicBeta
      ? { 'anthropic-beta': String(betas) }
      : {}),
  }
}

function buildMessagesBody(
  request: AdaptedMessageRequest,
  stream: boolean,
): Record<string, unknown> {
  const { betas: _betas, ...body } = request.body
  return { ...body, stream }
}

export class UpstreamMessagesClient {
  private readonly baseApiUrl: string
  private readonly fetch: FetchLike
  private readonly debugRecorder?: DebugTrafficRecorder

  constructor(options: UpstreamMessagesClientOptions = {}) {
    this.baseApiUrl = options.baseApiUrl ?? 'https://api.anthropic.com'
    this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis)
    this.debugRecorder = options.debugRecorder
  }

  async sendJson(
    request: AdaptedMessageRequest,
  ): Promise<UpstreamMessagesResponse> {
    const url = `${this.baseApiUrl}/v1/messages?beta=true`
    const headers = buildMessagesHeaders(request)
    const body = buildMessagesBody(request, false)
    this.debugRecorder?.record({
      direction: 'upstream',
      phase: 'request',
      method: 'POST',
      url,
      headers,
      body,
    })
    const response = await this.fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: request.signal,
    })
    this.debugRecorder?.record({
      direction: 'upstream',
      phase: 'response',
      method: 'POST',
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
      upstreamRequestId:
        response.headers.get('request-id') ??
        response.headers.get('anthropic-request-id') ??
        undefined,
      clientRequestId: request.clientRequestId,
    }
  }

  async sendStream(
    request: AdaptedMessageRequest,
  ): Promise<UpstreamMessagesStreamResponse> {
    const url = `${this.baseApiUrl}/v1/messages?beta=true`
    const headers = {
      ...buildMessagesHeaders(request),
      Accept: 'text/event-stream',
    }
    const body = buildMessagesBody(request, true)
    this.debugRecorder?.record({
      direction: 'upstream',
      phase: 'request',
      method: 'POST',
      url,
      headers,
      body,
    })
    const response = await this.fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: request.signal,
    })
    this.debugRecorder?.record({
      direction: 'upstream',
      phase: 'response',
      method: 'POST',
      url,
      status: response.status,
      headers: response.headers,
    })

    if (!response.ok) {
      await parseErrorResponse(response)
    }
    if (!response.body) {
      throw new UpstreamError({
        status: 502,
        message: 'Upstream streaming response did not include a body',
        body: null,
      })
    }

    return {
      status: response.status,
      headers: response.headers,
      stream: response.body,
      upstreamRequestId:
        response.headers.get('request-id') ??
        response.headers.get('anthropic-request-id') ??
        undefined,
      clientRequestId: request.clientRequestId,
    }
  }
}
