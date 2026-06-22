import { Hono } from 'hono'
import type { ApiProxyGateway } from '../api-proxy/gateway.js'
import type { ClaudeCliGateway } from '../claude-cli/gateway.js'
import type { DebugTrafficRecorder } from '../debug/traffic-recorder.js'
import { MessagesGateway } from '../messages/gateway.js'
import { OAuthClient } from '../oauth/client.js'
import type { SqliteStore } from '../storage/sqlite-store.js'
import { errorResponse, notFoundResponse } from './responses.js'
import { registerAdminRoutes } from './routes/admin.js'
import { registerApiProxyRoutes } from './routes/api-proxy.js'
import { registerAuthRoutes } from './routes/auth.js'
import { registerClaudeCliRoutes } from './routes/claude-cli.js'
import { registerHealthRoutes } from './routes/health.js'
import { registerMessagesRoutes } from './routes/messages.js'
import { registerOAuthRoutes } from './routes/oauth.js'
import { registerStaticAdminRoutes } from './routes/static-admin.js'

export type AppOptions = {
  gateway: MessagesGateway
  claudeCliGateway?: ClaudeCliGateway
  apiProxyGateway?: ApiProxyGateway
  store?: SqliteStore
  oauthClient?: OAuthClient
  debugRecorder?: DebugTrafficRecorder
}

export function createHonoApp(options: AppOptions): Hono {
  const app = new Hono()

  app.onError(error => errorResponse(error))
  app.notFound(() => notFoundResponse())

  registerHealthRoutes(app)
  registerAuthRoutes(app, options)
  registerOAuthRoutes(app, options)
  registerAdminRoutes(app, options)
  registerClaudeCliRoutes(app, options)
  registerApiProxyRoutes(app, options)
  registerMessagesRoutes(app, options)
  registerStaticAdminRoutes(app)

  return app
}

export function createFetchHandler(options: AppOptions) {
  const app = createHonoApp(options)
  return async (request: Request): Promise<Response> => await app.fetch(request)
}
