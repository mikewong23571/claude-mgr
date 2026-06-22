import { randomUUID } from 'node:crypto'
import type { Hono } from 'hono'
import { GatewayError } from '../../errors.js'
import type { AppOptions } from '../app.js'
import { json, readJson } from '../responses.js'

export function registerMessagesRoutes(app: Hono, options: AppOptions): void {
  app.post('/v1/messages', async c => {
    const request = c.req.raw
    const url = new URL(request.url)
    const localClientId = request.headers.get('x-claude-mgr-client-id')
    if (!localClientId) {
      options.store?.insertAuditEvent({
        id: randomUUID(),
        clientId: '__missing__',
        poolId: request.headers.get('x-claude-mgr-pool-id') ?? null,
        endpoint: '/v1/messages',
        status: 'error',
        errorType: 'gateway_auth_error',
      })
      throw new GatewayError(
        'gateway_auth_error',
        'Missing x-claude-mgr-client-id',
        401,
      )
    }
    const poolId = request.headers.get('x-claude-mgr-pool-id') ?? undefined
    const sessionId =
      request.headers.get('x-claude-mgr-session-id') ??
      request.headers.get('x-claude-code-session-id') ??
      undefined
    const body = await readJson(request)
    const stream = body.stream === true
    options.debugRecorder?.record({
      direction: 'downstream',
      phase: 'request',
      method: request.method,
      url: url.pathname,
      headers: request.headers,
      body,
    })

    if (stream) {
      const result = await options.gateway.sendStream({
        localClientId,
        poolId,
        sessionId,
        headers: request.headers,
        body,
        signal: request.signal,
      })
      return new Response(result.response.stream, {
        status: result.response.status,
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'x-client-request-id': result.response.clientRequestId,
          ...(result.response.upstreamRequestId
            ? { 'request-id': result.response.upstreamRequestId }
            : {}),
        },
      })
    }

    const result = await options.gateway.sendJson({
      localClientId,
      poolId,
      sessionId,
      headers: request.headers,
      body,
      signal: request.signal,
    })
    return json(result.response.body, {
      status: result.response.status,
      headers: {
        'x-client-request-id': result.response.clientRequestId,
        ...(result.response.upstreamRequestId
          ? { 'request-id': result.response.upstreamRequestId }
          : {}),
      },
    })
  })
}
