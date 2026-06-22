import type { Hono } from 'hono'
import {
  optionalUserFromRequest,
  requireUserFromRequest,
} from '../../auth/session.js'
import { requireRole } from '../../auth/permissions.js'
import { defaultPoolId } from '../../bootstrap/default-resources.js'
import { GatewayError } from '../../errors.js'
import { OAuthClient } from '../../oauth/client.js'
import { createCodeVerifier, createOAuthState } from '../../oauth/pkce.js'
import type { AppOptions } from '../app.js'
import { json, requireStore } from '../responses.js'
import { OAuthCallbackBody, parseJsonBody } from '../validation.js'

const pendingOAuthTtlMs = 10 * 60 * 1000
const oauthFlows = ['callback', 'manual'] as const
type OAuthFlow = (typeof oauthFlows)[number]
type OAuthCallbackResult = {
  account_uuid: string
  organization_uuid: string
  token_label: string
  scopes: string[]
}

function defaultRedirectUri(requestUrl: URL): string {
  const host = requestUrl.hostname
  if (
    requestUrl.protocol === 'http:' &&
    (host === '127.0.0.1' || host === '0.0.0.0' || host === '::1')
  ) {
    return `http://localhost:${requestUrl.port || '80'}/callback`
  }
  return `${requestUrl.origin}/callback`
}

function oauthFlowFromParam(value: string | null): OAuthFlow {
  if (!value) return 'callback'
  if ((oauthFlows as readonly string[]).includes(value)) return value as OAuthFlow
  throw new GatewayError(
    'gateway_validation_error',
    'flow must be callback or manual',
    400,
  )
}

function callbackSuccessPage(result: OAuthCallbackResult, state: string): Response {
  const tokenLabel = result.token_label.replace(/[&<>"']/g, char => {
    switch (char) {
      case '&':
        return '&amp;'
      case '<':
        return '&lt;'
      case '>':
        return '&gt;'
      case '"':
        return '&quot;'
      default:
        return '&#39;'
    }
  })
  return new Response(
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>OAuth login complete</title>
    <style>
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        font: 14px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        color: #1f2937;
        background: #f8fafc;
      }
      main {
        max-width: 360px;
        padding: 24px;
        text-align: center;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>OAuth login complete</h1>
      <p>Token ${tokenLabel} has been installed. This window will close automatically.</p>
    </main>
    <script>
      try {
        if (window.opener) {
          window.opener.postMessage({ type: 'claude-mgr-oauth-complete', state: ${JSON.stringify(state)} }, window.location.origin);
        }
      } catch {}
      setTimeout(() => window.close(), 800);
    </script>
  </body>
</html>`,
    { headers: { 'Content-Type': 'text/html; charset=utf-8' } },
  )
}

export function registerOAuthRoutes(app: Hono, options: AppOptions): void {
  const oauthClient = options.oauthClient ?? new OAuthClient()

  function visibleDefaultPoolId(
    store: ReturnType<typeof requireStore>,
    user: ReturnType<typeof requireUserFromRequest>,
  ): string | undefined {
    const pool = store
      .listPools()
      .find(item => item.id === defaultPoolId)
    if (!pool) return undefined
    return user.role === 'owner' || pool.ownerUserId === user.id ? pool.id : undefined
  }

  async function completeOAuthCallback(input: {
    code: string
    state: string
    request: Request
    requireSession: boolean
  }): Promise<OAuthCallbackResult> {
    const store = requireStore(options.store)
    const sessionUser = input.requireSession
      ? requireUserFromRequest(store, input.request)
      : optionalUserFromRequest(store, input.request)
    const pending = store.getPendingOAuthLogin(input.state)
    if (pending.consumedAt || pending.expiresAt <= Date.now()) {
      throw new GatewayError(
        'gateway_auth_error',
        'OAuth state was not found or already consumed',
        401,
      )
    }
    if (sessionUser && sessionUser.id !== pending.initiatedByUserId) {
      throw new GatewayError(
        'gateway_auth_error',
        'OAuth state belongs to a different user',
        403,
      )
    }
    const token = await oauthClient.exchangeCode({
      authorizationCode: input.code,
      state: input.state,
      codeVerifier: pending.codeVerifier,
      redirectUri: pending.redirectUri,
    })
    const installed = await oauthClient.installToken({
      store,
      label: pending.label,
      sourceDevice: pending.sourceDevice,
      ownerUserId: pending.initiatedByUserId,
      token,
    })
    if (pending.poolId) {
      store.addAccountToPool({
        poolId: pending.poolId,
        accountUuid: installed.account.accountUuid,
      })
    }
    store.consumePendingOAuthLogin(input.state)
    return {
      account_uuid: installed.account.accountUuid,
      organization_uuid: installed.account.organizationUuid,
      token_label: installed.token.label,
      scopes: installed.token.scopes,
    }
  }

  app.get('/oauth/authorize', c => {
    const store = requireStore(options.store)
    const user = requireUserFromRequest(store, c.req.raw)
    requireRole(user, 'admin')
    const url = new URL(c.req.raw.url)
    const label = url.searchParams.get('label')
    const sourceDevice = url.searchParams.get('source_device')
    const flow = oauthFlowFromParam(url.searchParams.get('flow'))
    const redirectUri =
      flow === 'manual'
        ? oauthClient.manualRedirectUri()
        : url.searchParams.get('redirect_uri') ?? defaultRedirectUri(url)
    const poolId =
      url.searchParams.get('pool_id') ?? visibleDefaultPoolId(store, user)
    if (poolId) {
      const pool = store.getPool(poolId)
      if (user.role !== 'owner' && pool.ownerUserId !== user.id) {
        throw new GatewayError('gateway_auth_error', 'Pool is not visible', 403)
      }
    }
    if (!label || !sourceDevice) {
      throw new GatewayError(
        'gateway_validation_error',
        'label and source_device are required',
        400,
      )
    }
    const state = createOAuthState()
    const codeVerifier = createCodeVerifier()
    store.createPendingOAuthLogin({
      state,
      codeVerifier,
      redirectUri,
      label,
      sourceDevice,
      poolId,
      initiatedByUserId: user.id,
      expiresAt: Date.now() + pendingOAuthTtlMs,
    })
    return json({
      authorize_url: oauthClient.buildAuthorizeUrl({
        state,
        codeVerifier,
        redirectUri,
      }),
      flow,
      redirect_uri: redirectUri,
      state,
    })
  })

  const completeCallbackFromQuery = async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    const code = url.searchParams.get('code')
    const state = url.searchParams.get('state')
    if (!code || !state) {
      throw new GatewayError(
        'gateway_validation_error',
        'code and state are required',
        400,
      )
    }
    const result = await completeOAuthCallback({
      code,
      state,
      request,
      requireSession: false,
    })
    return callbackSuccessPage(result, state)
  }

  app.get('/callback', c => completeCallbackFromQuery(c.req.raw))
  app.get('/oauth/callback', c => completeCallbackFromQuery(c.req.raw))

  app.post('/oauth/callback', async c => {
    const body = await parseJsonBody(c.req.raw, OAuthCallbackBody)
    return json(await completeOAuthCallback({
      code: body.code,
      state: body.state,
      request: c.req.raw,
      requireSession: true,
    }))
  })

  app.get('/oauth/status', c => {
    const store = requireStore(options.store)
    const user = requireUserFromRequest(store, c.req.raw)
    requireRole(user, 'admin')
    const url = new URL(c.req.raw.url)
    const state = url.searchParams.get('state')
    if (!state) {
      throw new GatewayError(
        'gateway_validation_error',
        'state is required',
        400,
      )
    }
    const pending = store.getPendingOAuthLogin(state)
    if (user.id !== pending.initiatedByUserId) {
      throw new GatewayError(
        'gateway_auth_error',
        'OAuth state belongs to a different user',
        403,
      )
    }
    const status = pending.consumedAt
      ? 'success'
      : pending.expiresAt <= Date.now()
        ? 'expired'
        : 'pending'
    return json({
      state: pending.state,
      status,
      label: pending.label,
      source_device: pending.sourceDevice,
    })
  })
}
