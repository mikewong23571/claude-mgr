import { randomUUID } from 'node:crypto'
import type { Hono } from 'hono'
import { GatewayError } from '../../errors.js'
import type { ClaudeCliEndpoint } from '../../upstream/claude-cli-client.js'
import { ClaudeCliGateway } from '../../claude-cli/gateway.js'
import type { AppOptions } from '../app.js'
import { json, requireStore } from '../responses.js'

function requireLocalClientId(request: Request, options: AppOptions, endpoint: string): string {
  const localClientId = request.headers.get('x-claude-mgr-client-id')
  if (localClientId) return localClientId

  options.store?.insertAuditEvent({
    id: randomUUID(),
    clientId: '__missing__',
    poolId: request.headers.get('x-claude-mgr-pool-id') ?? null,
    endpoint,
    status: 'error',
    errorType: 'gateway_auth_error',
  })
  throw new GatewayError(
    'gateway_auth_error',
    'Missing x-claude-mgr-client-id',
    401,
  )
}

function registerClaudeCliGet(
  app: Hono,
  options: AppOptions,
  path: string,
  endpoint: ClaudeCliEndpoint,
): void {
  app.get(path, async c => {
    const request = c.req.raw
    const localClientId = requireLocalClientId(request, options, path)
    const poolId = request.headers.get('x-claude-mgr-pool-id') ?? undefined
    const gateway =
      options.claudeCliGateway ??
      new ClaudeCliGateway({
        store: requireStore(options.store),
      })
    const result = await gateway.get({
      localClientId,
      poolId,
      endpoint,
      signal: request.signal,
    })
    return json(result.response.body, {
      status: result.response.status,
      headers: {
        ...(result.response.upstreamRequestId
          ? { 'request-id': result.response.upstreamRequestId }
          : {}),
      },
    })
  })
}

export function registerClaudeCliRoutes(app: Hono, options: AppOptions): void {
  registerClaudeCliGet(app, options, '/api/oauth/usage', 'usage')
  registerClaudeCliGet(app, options, '/api/claude_cli/bootstrap', 'bootstrap')
}
