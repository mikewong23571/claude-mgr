import type { Hono } from 'hono'
import { requireAuthenticatedLocalClient } from '../../auth/local-client.js'
import { GatewayError } from '../../errors.js'
import { ApiProxyGateway } from '../../api-proxy/gateway.js'
import type { ProxyEndpointKind } from '../../upstream/api-proxy-client.js'
import type { AppOptions } from '../app.js'
import { requireStore } from '../responses.js'

type ProxyRoute = {
  method: string
  path: string
  endpoint: string
  endpointKind: ProxyEndpointKind
  authOptional?: boolean
}

const routes: ProxyRoute[] = [
  {
    method: 'GET',
    path: '/v1/files',
    endpoint: '/v1/files',
    endpointKind: 'files',
  },
  {
    method: 'POST',
    path: '/v1/files',
    endpoint: '/v1/files',
    endpointKind: 'files',
  },
  {
    method: 'GET',
    path: '/v1/files/:fileId/content',
    endpoint: '/v1/files/:fileId/content',
    endpointKind: 'files',
  },
  {
    method: 'POST',
    path: '/api/event_logging/batch',
    endpoint: '/api/event_logging/batch',
    endpointKind: 'event_logging',
    authOptional: true,
  },
  {
    method: 'POST',
    path: '/api/auth/trusted_devices',
    endpoint: '/api/auth/trusted_devices',
    endpointKind: 'trusted_devices',
  },
]

function routePathWithSearch(request: Request): string {
  const url = new URL(request.url)
  return `${url.pathname}${url.search}`
}

function requestBody(request: Request): RequestInit['body'] {
  if (request.method === 'GET' || request.method === 'HEAD') return null
  return request.body
}

function localClientIdForRoute(
  request: Request,
  route: ProxyRoute,
): string | undefined {
  const localClientId = request.headers.get('x-claude-mgr-client-id') ?? undefined
  if (localClientId || route.authOptional) return localClientId
  throw new GatewayError(
    'gateway_auth_error',
    'Missing x-claude-mgr-client-id',
    401,
  )
}

function proxyGateway(options: AppOptions): ApiProxyGateway {
  return (
    options.apiProxyGateway ??
    new ApiProxyGateway({
      store: requireStore(options.store),
    })
  )
}

function registerProxyRoute(app: Hono, options: AppOptions, route: ProxyRoute): void {
  app.on(route.method, route.path, async c => {
    const request = c.req.raw
    const localClientId = localClientIdForRoute(request, route)
    if (localClientId) {
      requireAuthenticatedLocalClient({
        store: requireStore(options.store),
        request,
        localClientId,
      })
    }
    const result = await proxyGateway(options).forward({
      localClientId,
      poolId: request.headers.get('x-claude-mgr-pool-id') ?? undefined,
      endpoint: route.endpoint,
      endpointKind: route.endpointKind,
      method: request.method,
      pathWithSearch: routePathWithSearch(request),
      headers: request.headers,
      body: requestBody(request),
      signal: request.signal,
    })
    return new Response(result.response.body, {
      status: result.response.status,
      headers: result.response.headers,
    })
  })
}

export function registerApiProxyRoutes(app: Hono, options: AppOptions): void {
  for (const route of routes) {
    registerProxyRoute(app, options, route)
  }
}
