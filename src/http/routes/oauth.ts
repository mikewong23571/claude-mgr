import type { Hono } from 'hono'
import { GatewayError } from '../../errors.js'
import { OAuthClient } from '../../oauth/client.js'
import { createCodeVerifier, createOAuthState } from '../../oauth/pkce.js'
import type { AppOptions } from '../app.js'
import { json, requireStore } from '../responses.js'
import { OAuthCallbackBody, parseJsonBody } from '../validation.js'

type PendingOAuthLogin = {
  state: string
  codeVerifier: string
  redirectUri: string
  label: string
  sourceDevice: string
  poolId?: string
}

export function registerOAuthRoutes(app: Hono, options: AppOptions): void {
  const pendingOAuth = new Map<string, PendingOAuthLogin>()
  const oauthClient = options.oauthClient ?? new OAuthClient()

  async function completeOAuthCallback(input: {
    code: string
    state: string
  }): Promise<Response> {
    const store = requireStore(options.store)
    const pending = pendingOAuth.get(input.state)
    if (!pending) {
      throw new GatewayError(
        'gateway_auth_error',
        'OAuth state was not found or already consumed',
        401,
      )
    }
    pendingOAuth.delete(input.state)
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
      token,
    })
    if (pending.poolId) {
      store.addAccountToPool({
        poolId: pending.poolId,
        accountUuid: installed.account.accountUuid,
      })
    }
    return json({
      account_uuid: installed.account.accountUuid,
      organization_uuid: installed.account.organizationUuid,
      token_label: installed.token.label,
      scopes: installed.token.scopes,
    })
  }

  app.get('/oauth/authorize', c => {
    const url = new URL(c.req.raw.url)
    const label = url.searchParams.get('label')
    const sourceDevice = url.searchParams.get('source_device')
    const redirectUri =
      url.searchParams.get('redirect_uri') ?? `${url.origin}/callback`
    const poolId = url.searchParams.get('pool_id') ?? undefined
    if (!label || !sourceDevice) {
      throw new GatewayError(
        'gateway_validation_error',
        'label and source_device are required',
        400,
      )
    }
    const state = createOAuthState()
    const codeVerifier = createCodeVerifier()
    pendingOAuth.set(state, {
      state,
      codeVerifier,
      redirectUri,
      label,
      sourceDevice,
      poolId,
    })
    return json({
      authorize_url: oauthClient.buildAuthorizeUrl({
        state,
        codeVerifier,
        redirectUri,
      }),
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
    return await completeOAuthCallback({ code, state })
  }

  app.get('/callback', c => completeCallbackFromQuery(c.req.raw))
  app.get('/oauth/callback', c => completeCallbackFromQuery(c.req.raw))

  app.post('/oauth/callback', async c => {
    const body = await parseJsonBody(c.req.raw, OAuthCallbackBody)
    return await completeOAuthCallback({ code: body.code, state: body.state })
  })
}
