import { randomUUID } from 'node:crypto'
import type { FetchLike } from '../http/fetch-types.js'
import { UpstreamError, parseUpstreamErrorBody } from '../errors.js'
import type { SqliteStore } from '../storage/sqlite-store.js'
import type { ClaudeAccount, OAuthToken } from '../domain/types.js'
import {
  claudeAiOAuthScopes,
  oauthBetaHeader,
  type OAuthConfig,
  prodOAuthConfig,
} from './config.js'
import { createCodeChallenge } from './pkce.js'

export type TokenExchangeResponse = {
  access_token: string
  refresh_token?: string
  expires_in?: number
  scope?: string
  account?: {
    uuid?: string
    email_address?: string
  }
  organization?: {
    uuid?: string
  }
}

export type OAuthProfileResponse = {
  account?: {
    uuid?: string
    email_address?: string
    display_name?: string
    created_at?: string
  }
  organization?: {
    uuid?: string
    organization_type?: string
    rate_limit_tier?: string
    billing_type?: string
    subscription_created_at?: string
  }
}

export type LoginState = {
  state: string
  codeVerifier: string
  redirectUri: string
}

export type OAuthClientOptions = {
  config?: OAuthConfig
  fetch?: FetchLike
}

function parseScopes(scope?: string): string[] {
  return scope
    ? scope
        .split(/\s+/)
        .map(value => value.trim())
        .filter(Boolean)
    : [...claudeAiOAuthScopes]
}

function subscriptionType(profile: OAuthProfileResponse): string | null {
  switch (profile.organization?.organization_type) {
    case 'claude_max':
      return 'max'
    case 'claude_pro':
      return 'pro'
    case 'claude_enterprise':
      return 'enterprise'
    case 'claude_team':
      return 'team'
    default:
      return null
  }
}

async function readJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}

async function assertOkJson<T>(response: Response): Promise<T> {
  const body = await readJsonResponse(response)
  if (!response.ok) {
    const parsed = parseUpstreamErrorBody(body)
    throw new UpstreamError({
      status: response.status,
      message: parsed.message,
      body,
      requestId: response.headers.get('request-id') ?? undefined,
      upstreamType: parsed.type,
    })
  }
  return body as T
}

export class OAuthClient {
  private readonly config: OAuthConfig
  private readonly fetch: FetchLike

  constructor(options: OAuthClientOptions = {}) {
    this.config = options.config ?? prodOAuthConfig
    this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis)
  }

  buildAuthorizeUrl(input: {
    state: string
    codeVerifier: string
    redirectUri: string
    scopes?: readonly string[]
    loginMethod?: string
  }): string {
    const url = new URL(this.config.authorizeUrl)
    url.searchParams.set('code', 'true')
    url.searchParams.set('client_id', this.config.clientId)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('redirect_uri', input.redirectUri)
    url.searchParams.set('scope', (input.scopes ?? claudeAiOAuthScopes).join(' '))
    url.searchParams.set('code_challenge', createCodeChallenge(input.codeVerifier))
    url.searchParams.set('code_challenge_method', 'S256')
    url.searchParams.set('state', input.state)
    if (input.loginMethod) {
      url.searchParams.set('login_method', input.loginMethod)
    }
    return url.toString()
  }

  async exchangeCode(input: {
    authorizationCode: string
    state: string
    codeVerifier: string
    redirectUri: string
    expiresIn?: number
  }): Promise<TokenExchangeResponse> {
    const body: Record<string, string | number> = {
      grant_type: 'authorization_code',
      code: input.authorizationCode,
      redirect_uri: input.redirectUri,
      client_id: this.config.clientId,
      code_verifier: input.codeVerifier,
      state: input.state,
    }
    if (input.expiresIn !== undefined) {
      body.expires_in = input.expiresIn
    }

    const response = await this.fetch(this.config.tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-beta': oauthBetaHeader,
      },
      body: JSON.stringify(body),
    })
    return await assertOkJson<TokenExchangeResponse>(response)
  }

  async refreshToken(input: {
    refreshToken: string
    scopes?: readonly string[]
  }): Promise<TokenExchangeResponse> {
    const response = await this.fetch(this.config.tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-beta': oauthBetaHeader,
      },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: input.refreshToken,
        client_id: this.config.clientId,
        scope: (input.scopes ?? claudeAiOAuthScopes).join(' '),
      }),
    })
    return await assertOkJson<TokenExchangeResponse>(response)
  }

  async fetchProfile(accessToken: string): Promise<OAuthProfileResponse> {
    const response = await this.fetch(`${this.config.baseApiUrl}/api/oauth/profile`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'anthropic-beta': oauthBetaHeader,
      },
    })
    return await assertOkJson<OAuthProfileResponse>(response)
  }

  async installToken(input: {
    store: SqliteStore
    label: string
    sourceDevice: string
    token: TokenExchangeResponse
    profile?: OAuthProfileResponse
  }): Promise<{ account: ClaudeAccount; token: OAuthToken }> {
    const profile =
      input.profile ?? (await this.fetchProfile(input.token.access_token))
    const accountUuid = profile.account?.uuid ?? input.token.account?.uuid
    const organizationUuid =
      profile.organization?.uuid ?? input.token.organization?.uuid
    if (!accountUuid || !organizationUuid) {
      throw new UpstreamError({
        status: 502,
        message: 'OAuth profile did not include account and organization UUIDs',
        body: profile,
      })
    }

    const existingAccount = input.store.findAccount(accountUuid)
    const account = input.store.upsertAccount({
      accountUuid,
      organizationUuid,
      email: profile.account?.email_address ?? input.token.account?.email_address,
      displayName: profile.account?.display_name,
      upstreamClientIdentityId:
        existingAccount?.upstreamClientIdentityId ??
        `acct-${accountUuid}-${randomUUID()}`,
      subscriptionType: subscriptionType(profile),
      rateLimitTier: profile.organization?.rate_limit_tier,
    })
    const token = input.store.upsertOAuthToken({
      label: input.label,
      sourceDevice: input.sourceDevice,
      accountUuid,
      scopes: parseScopes(input.token.scope),
      accessToken: input.token.access_token,
      refreshToken: input.token.refresh_token ?? null,
      expiresAt: input.token.expires_in
        ? Date.now() + input.token.expires_in * 1000
        : null,
    })
    return { account, token }
  }
}
