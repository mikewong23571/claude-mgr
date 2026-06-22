import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { JsonlDebugTrafficRecorder } from '../src/debug/traffic-recorder.js'
import { UpstreamError } from '../src/errors.js'
import type { FetchLike } from '../src/http/fetch-types.js'
import { adaptMessagesRequest } from '../src/messages/adapter.js'
import { OAuthClient } from '../src/oauth/client.js'
import { oauthBetaHeader, prodOAuthConfig } from '../src/oauth/config.js'
import { TokenRefresher } from '../src/oauth/token-refresher.js'
import { quotaSnapshotFromHeaders } from '../src/quota/headers.js'
import { UpstreamMessagesClient } from '../src/upstream/messages-client.js'
import { AccountRouter } from '../src/routing/account-router.js'
import { SqliteStore } from '../src/storage/sqlite-store.js'

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: {
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  })
}

function createStore(): SqliteStore {
  const store = new SqliteStore(new DatabaseSync(':memory:'))
  store.initialize()
  return store
}

describe('OAuth client', () => {
  it('builds a Claude Code OAuth authorize URL with PKCE parameters', () => {
    const client = new OAuthClient()

    const url = new URL(
      client.buildAuthorizeUrl({
        state: 'state-1',
        codeVerifier: 'verifier-1',
        redirectUri: 'http://localhost:1455/callback',
      }),
    )

    expect(url.origin + url.pathname).toBe(prodOAuthConfig.authorizeUrl)
    expect(url.searchParams.get('client_id')).toBe(prodOAuthConfig.clientId)
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('scope')).toContain('user:inference')
  })

  it('exchanges an authorization code using the source-confirmed token body', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fetch: FetchLike = async (url, init) => {
      calls.push({ url: String(url), init })
      return jsonResponse({
        access_token: 'access-1',
        refresh_token: 'refresh-1',
        expires_in: 3600,
        scope: 'user:profile user:inference',
      })
    }
    const client = new OAuthClient({ fetch })

    const token = await client.exchangeCode({
      authorizationCode: 'code-1',
      state: 'state-1',
      codeVerifier: 'verifier-1',
      redirectUri: 'http://localhost:1455/callback',
    })

    expect(token.access_token).toBe('access-1')
    expect(calls[0].url).toBe(prodOAuthConfig.tokenUrl)
    const headers = calls[0].init?.headers as Record<string, string>
    expect(headers['anthropic-beta']).toBe(oauthBetaHeader)
    const body = JSON.parse(String(calls[0].init?.body)) as Record<string, string>
    expect(body).toMatchObject({
      grant_type: 'authorization_code',
      code: 'code-1',
      redirect_uri: 'http://localhost:1455/callback',
      client_id: prodOAuthConfig.clientId,
      code_verifier: 'verifier-1',
      state: 'state-1',
    })
  })

  it('installs token/profile data and preserves account identity across relogin', async () => {
    const store = createStore()
    const fetch: FetchLike = async () =>
      jsonResponse({
        account: {
          uuid: 'acc-oauth',
          email_address: 'owner@example.test',
          display_name: 'Owner',
        },
        organization: {
          uuid: 'org-oauth',
          organization_type: 'claude_pro',
          rate_limit_tier: 'standard',
        },
      })
    const client = new OAuthClient({ fetch })

    await client.installToken({
      store,
      label: 'oauth-main',
      sourceDevice: 'laptop',
      token: {
        access_token: 'access-1',
        refresh_token: 'refresh-1',
        expires_in: 3600,
        scope: 'user:profile user:inference',
      },
    })
    const firstIdentity = store.getAccount('acc-oauth').upstreamClientIdentityId

    await client.installToken({
      store,
      label: 'oauth-main',
      sourceDevice: 'laptop',
      token: {
        access_token: 'access-2',
        refresh_token: 'refresh-2',
        expires_in: 3600,
        scope: 'user:profile user:inference',
      },
    })

    expect(store.getAccount('acc-oauth').upstreamClientIdentityId).toBe(
      firstIdentity,
    )
    expect(store.getOAuthToken('oauth-main').accessToken).toBe('access-2')
  })

  it('fetches OAuth profile with the Claude Code OAuth beta header', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fetch: FetchLike = async (url, init) => {
      calls.push({ url: String(url), init })
      return jsonResponse({
        account: { uuid: 'acc-oauth' },
        organization: { uuid: 'org-oauth' },
      })
    }
    const client = new OAuthClient({ fetch })

    await client.fetchProfile('access-1')

    expect(calls[0].url).toBe(`${prodOAuthConfig.baseApiUrl}/api/oauth/profile`)
    const headers = calls[0].init?.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer access-1')
    expect(headers['anthropic-beta']).toBe(oauthBetaHeader)
  })

  it('refreshes OAuth tokens with the Claude Code OAuth beta header', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fetch: FetchLike = async (url, init) => {
      calls.push({ url: String(url), init })
      return jsonResponse({
        access_token: 'access-refreshed',
        refresh_token: 'refresh-refreshed',
        expires_in: 3600,
        scope: 'user:profile user:inference',
      })
    }
    const client = new OAuthClient({ fetch })

    await client.refreshToken({ refreshToken: 'refresh-1' })

    expect(calls[0].url).toBe(prodOAuthConfig.tokenUrl)
    const headers = calls[0].init?.headers as Record<string, string>
    expect(headers['anthropic-beta']).toBe(oauthBetaHeader)
  })

  it('does not install OAuth tokens when profile lookup fails', async () => {
    const store = createStore()
    const fetch: FetchLike = async () =>
      jsonResponse(
        {
          type: 'error',
          error: {
            type: 'authentication_error',
            message: 'profile denied',
          },
        },
        { status: 401, headers: { 'request-id': 'profile-401' } },
      )
    const client = new OAuthClient({ fetch })

    await expect(
      client.installToken({
        store,
        label: 'oauth-failed',
        sourceDevice: 'laptop',
        token: {
          access_token: 'access-failed',
          refresh_token: 'refresh-failed',
          expires_in: 3600,
          scope: 'user:profile user:inference',
        },
      }),
    ).rejects.toMatchObject({
      status: 401,
      upstreamType: 'authentication_error',
      requestId: 'profile-401',
    } satisfies Partial<UpstreamError>)

    expect(store.listAccounts()).toEqual([])
    expect(store.listOAuthTokens()).toEqual([])
  })
})

describe('upstream Messages client', () => {
  function adaptedRequest(overrides: Record<string, unknown> = {}) {
    const store = createStore()
    store.upsertAccount({
      accountUuid: 'acc-a',
      organizationUuid: 'org-a',
      upstreamClientIdentityId: 'identity-a',
    })
    store.createPool({ id: 'pool-a', name: 'Pool A' })
    store.addAccountToPool({ poolId: 'pool-a', accountUuid: 'acc-a' })
    store.createLocalClient({
      id: 'client-a',
      name: 'Client A',
      defaultPoolId: 'pool-a',
    })
    store.upsertOAuthToken({
      label: 'token-a',
      sourceDevice: 'laptop',
      accountUuid: 'acc-a',
      scopes: ['user:inference'],
      accessToken: 'access-a',
      refreshToken: 'refresh-a',
      expiresAt: Date.now() + 60_000,
    })
    const credential = new AccountRouter(store).resolveCredential({
      localClientId: 'client-a',
    })
    return adaptMessagesRequest({
      credential,
      userAgent: 'claude-mgr/0.1.0',
      clientRequestId: 'client-request-1',
      body: {
        model: 'claude-test',
        max_tokens: 8,
        messages: [{ role: 'user', content: 'hello' }],
        ...overrides,
      },
    })
  }

  it('sends non-streaming Messages as a JSON POST', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fetch: FetchLike = async (url, init) => {
      calls.push({ url: String(url), init })
      return jsonResponse(
        { id: 'msg-1', type: 'message', content: [] },
        { headers: { 'request-id': 'upstream-1' } },
      )
    }
    const client = new UpstreamMessagesClient({
      baseApiUrl: 'https://api.example.test',
      fetch,
    })

    const response = await client.sendJson(adaptedRequest())

    expect(response.upstreamRequestId).toBe('upstream-1')
    expect(calls[0].url).toBe('https://api.example.test/v1/messages?beta=true')
    expect(calls[0].init?.method).toBe('POST')
    const headers = calls[0].init?.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer access-a')
    expect(headers['anthropic-version']).toBe('2023-06-01')
    const body = JSON.parse(String(calls[0].init?.body)) as Record<string, unknown>
    expect(body.stream).toBe(false)
  })

  it('translates beta body flags to the SDK-compatible anthropic-beta header', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fetch: FetchLike = async (url, init) => {
      calls.push({ url: String(url), init })
      return jsonResponse({ id: 'msg-1', type: 'message', content: [] })
    }
    const client = new UpstreamMessagesClient({
      baseApiUrl: 'https://api.example.test',
      fetch,
    })

    await client.sendJson(
      adaptedRequest({
        betas: ['beta-a', 'beta-b'],
      }),
    )

    const headers = calls[0].init?.headers as Record<string, string>
    expect(headers['anthropic-beta']).toBe('beta-a,beta-b')
    const body = JSON.parse(String(calls[0].init?.body)) as Record<string, unknown>
    expect(body).not.toHaveProperty('betas')
  })

  it('records sanitized upstream debug traffic when enabled', async () => {
    const debugDir = mkdtempSync(join(tmpdir(), 'claude-mgr-debug-upstream.'))
    const debugRecorder = new JsonlDebugTrafficRecorder(debugDir)
    const fetch: FetchLike = async () =>
      jsonResponse(
        { id: 'msg-debug', type: 'message', content: [] },
        { headers: { 'request-id': 'upstream-debug-1' } },
      )
    const client = new UpstreamMessagesClient({
      baseApiUrl: 'https://api.example.test',
      fetch,
      debugRecorder,
    })

    try {
      await client.sendJson(
        adaptedRequest({
          messages: [{ role: 'user', content: 'sensitive upstream prompt' }],
        }),
      )

      const debugOutput = readFileSync(debugRecorder.filePath, 'utf8')
      expect(debugOutput).toContain('"direction":"upstream"')
      expect(debugOutput).toContain('"phase":"request"')
      expect(debugOutput).toContain('"authorization":"[redacted]"')
      expect(debugOutput).toContain('"anthropic-version":"2023-06-01"')
      expect(debugOutput).toContain('"phase":"response"')
      expect(debugOutput).toContain('"request-id":"upstream-debug-1"')
      expect(debugOutput).not.toContain('Bearer access-a')
      expect(debugOutput).not.toContain('sensitive upstream prompt')
    } finally {
      rmSync(debugDir, { recursive: true, force: true })
    }
  })

  it('returns the upstream SSE body without buffering it', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('event: message_start\n\n'))
        controller.close()
      },
    })
    const fetch: FetchLike = async () =>
      new Response(stream, {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream',
          'request-id': 'upstream-stream-1',
        },
      })
    const client = new UpstreamMessagesClient({ fetch })

    const response = await client.sendStream(adaptedRequest())

    expect(response.upstreamRequestId).toBe('upstream-stream-1')
    expect(response.stream).toBe(stream)
  })

  it('preserves upstream error status, type, message and request id', async () => {
    const fetch: FetchLike = async () =>
      jsonResponse(
        {
          type: 'error',
          error: {
            type: 'rate_limit_error',
            message: 'rate limited',
          },
        },
        { status: 429, headers: { 'request-id': 'upstream-429' } },
      )
    const client = new UpstreamMessagesClient({ fetch })

    await expect(client.sendJson(adaptedRequest())).rejects.toMatchObject({
      status: 429,
      upstreamType: 'rate_limit_error',
      requestId: 'upstream-429',
    } satisfies Partial<UpstreamError>)
  })
})

describe('token refresher', () => {
  it('coalesces concurrent refreshes for the same token label', async () => {
    const store = createStore()
    store.upsertAccount({
      accountUuid: 'acc-refresh',
      organizationUuid: 'org-refresh',
      upstreamClientIdentityId: 'identity-refresh',
    })
    const token = store.upsertOAuthToken({
      label: 'token-refresh',
      sourceDevice: 'laptop',
      accountUuid: 'acc-refresh',
      scopes: ['user:profile', 'user:inference'],
      accessToken: 'old-access',
      refreshToken: 'refresh-token',
      expiresAt: Date.now() - 1,
    })

    let fetchCalls = 0
    const fetchGate: { resolve?: () => void } = {}
    const fetch: FetchLike = async () => {
      fetchCalls += 1
      await new Promise<void>(resolve => {
        fetchGate.resolve = resolve
      })
      return jsonResponse({
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        expires_in: 3600,
        scope: 'user:profile user:inference',
      })
    }
    const refresher = new TokenRefresher(store, new OAuthClient({ fetch }))

    const first = refresher.refreshToken(token)
    const second = refresher.refreshToken(token)
    await Promise.resolve()
    expect(fetchCalls).toBe(1)
    fetchGate.resolve?.()

    const [firstResult, secondResult] = await Promise.all([first, second])
    expect(firstResult.accessToken).toBe('new-access')
    expect(secondResult.accessToken).toBe('new-access')
    expect(store.getOAuthToken('token-refresh')).toMatchObject({
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
      scopes: ['user:profile', 'user:inference'],
    })
    expect(fetchCalls).toBe(1)
  })
})

describe('quota headers', () => {
  it('creates account-scoped quota snapshots from Anthropic headers', () => {
    const snapshot = quotaSnapshotFromHeaders({
      accountUuid: 'acc-a',
      tokenLabel: 'token-a',
      headers: new Headers({
        'anthropic-ratelimit-unified-status': 'allowed',
        'anthropic-ratelimit-unified-type': 'subscription',
        'anthropic-ratelimit-unified-utilization': '0.42',
        'anthropic-ratelimit-unified-reset': '2026-06-22T00:00:00.000Z',
      }),
      nowMs: 100,
    })

    expect(snapshot).toMatchObject({
      accountUuid: 'acc-a',
      tokenLabel: 'token-a',
      status: 'allowed',
      rateLimitType: 'subscription',
      utilization: 0.42,
      createdAt: 100,
    })
  })
})
