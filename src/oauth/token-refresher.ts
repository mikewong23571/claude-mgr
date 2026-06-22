import type { OAuthToken } from '../domain/types.js'
import { GatewayError } from '../errors.js'
import type { SqliteStore } from '../storage/sqlite-store.js'
import { OAuthClient } from './client.js'

function parseScopes(scope: string | undefined, fallback: string[]): string[] {
  return scope
    ? scope
        .split(/\s+/)
        .map(value => value.trim())
        .filter(Boolean)
    : fallback
}

export class TokenRefresher {
  private readonly locks = new Map<string, Promise<OAuthToken>>()

  constructor(
    private readonly store: SqliteStore,
    private readonly oauthClient = new OAuthClient(),
  ) {}

  async refreshToken(token: OAuthToken): Promise<OAuthToken> {
    if (!token.refreshToken) {
      throw new GatewayError(
        'gateway_no_eligible_token',
        `Token ${token.label} does not have a refresh token`,
        409,
      )
    }

    const existing = this.locks.get(token.label)
    if (existing) return await existing

    const refresh = this.refreshTokenUncached(token).finally(() => {
      this.locks.delete(token.label)
    })
    this.locks.set(token.label, refresh)
    return await refresh
  }

  private async refreshTokenUncached(token: OAuthToken): Promise<OAuthToken> {
    const refreshed = await this.oauthClient.refreshToken({
      refreshToken: token.refreshToken!,
      scopes: token.scopes,
    })
    return this.store.upsertOAuthToken({
      label: token.label,
      sourceDevice: token.sourceDevice,
      accountUuid: token.accountUuid,
      scopes: parseScopes(refreshed.scope, token.scopes),
      accessToken: refreshed.access_token,
      refreshToken: refreshed.refresh_token ?? token.refreshToken,
      expiresAt: refreshed.expires_in
        ? Date.now() + refreshed.expires_in * 1000
        : token.expiresAt,
    })
  }
}
