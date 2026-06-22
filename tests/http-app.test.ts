import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ApiProxyGateway } from '../src/api-proxy/gateway.js'
import { ClaudeCliGateway } from '../src/claude-cli/gateway.js'
import { JsonlDebugTrafficRecorder } from '../src/debug/traffic-recorder.js'
import { createFetchHandler } from '../src/http/app.js'
import type { FetchLike } from '../src/http/fetch-types.js'
import { MessagesGateway } from '../src/messages/gateway.js'
import { OAuthClient } from '../src/oauth/client.js'
import { TokenRefresher } from '../src/oauth/token-refresher.js'
import { AccountRouter } from '../src/routing/account-router.js'
import { SqliteStore } from '../src/storage/sqlite-store.js'
import { ApiProxyClient } from '../src/upstream/api-proxy-client.js'
import { UpstreamClaudeCliClient } from '../src/upstream/claude-cli-client.js'
import { UpstreamMessagesClient } from '../src/upstream/messages-client.js'

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: {
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  })
}

function seedStore(): SqliteStore {
  const store = new SqliteStore(new DatabaseSync(':memory:'))
  store.initialize()
  store.upsertAccount({
    accountUuid: 'acc-a',
    organizationUuid: 'org-a',
    upstreamClientIdentityId: 'identity-a',
  })
  store.createPool({ id: 'pool-main', name: 'Main' })
  store.addAccountToPool({ poolId: 'pool-main', accountUuid: 'acc-a' })
  store.createLocalClient({
    id: 'client-a',
    name: 'Client A',
    defaultPoolId: 'pool-main',
  })
  store.upsertOAuthToken({
    label: 'token-a',
    sourceDevice: 'laptop',
    accountUuid: 'acc-a',
    scopes: ['user:profile', 'user:inference'],
    accessToken: 'access-a',
    refreshToken: 'refresh-a',
    expiresAt: Date.now() + 60_000,
  })
  return store
}

function createHandler(store: SqliteStore, fetch: FetchLike) {
  return createFetchHandler({
    gateway: new MessagesGateway({
      store,
      upstream: new UpstreamMessagesClient({
        baseApiUrl: 'https://api.example.test',
        fetch,
      }),
      userAgent: 'claude-mgr/0.1.0',
    }),
    store,
  })
}

function createClaudeCliHandler(store: SqliteStore, fetch: FetchLike) {
  return createFetchHandler({
    gateway: new MessagesGateway({
      store,
      upstream: new UpstreamMessagesClient({
        baseApiUrl: 'https://messages.example.test',
        fetch: async () => jsonResponse({ id: 'unused', usage: {} }),
      }),
    }),
    claudeCliGateway: new ClaudeCliGateway({
      store,
      upstream: new UpstreamClaudeCliClient({
        baseApiUrl: 'https://api.example.test',
        fetch,
      }),
      userAgent: 'claude-mgr/0.1.0',
    }),
    store,
  })
}

function createApiProxyHandler(store: SqliteStore, fetch: FetchLike) {
  return createFetchHandler({
    gateway: new MessagesGateway({
      store,
      upstream: new UpstreamMessagesClient({
        baseApiUrl: 'https://messages.example.test',
        fetch: async () => jsonResponse({ id: 'unused', usage: {} }),
      }),
    }),
    apiProxyGateway: new ApiProxyGateway({
      store,
      upstream: new ApiProxyClient({
        baseApiUrl: 'https://api.example.test',
        fetch,
      }),
    }),
    store,
  })
}

async function waitForAuditStatus(
  store: SqliteStore,
  status: 'pending' | 'success' | 'error' | 'interrupted',
): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (store.listAuditEvents()[0]?.status === status) return
    await new Promise(resolve => setTimeout(resolve, 0))
  }
}

describe('HTTP app', () => {
  it('serves the local admin console without credential field names', async () => {
    const store = seedStore()
    const handle = createHandler(store, async () => {
      throw new Error('must not call upstream')
    })

    const index = await handle(new Request('http://localhost/admin/'))
    expect(index.status).toBe(200)
    expect(index.headers.get('Content-Type')).toContain('text/html')
    const html = await index.text()
    expect(html).toContain('<div id="root"></div>')
    expect(html).toContain('/admin/assets/')

    const scriptPath = html.match(/src="([^"]+\.js)"/)?.[1]
    expect(scriptPath).toBeDefined()
    const script = await handle(new Request(`http://localhost${scriptPath}`))
    expect(script.status).toBe(200)
    const source = await script.text()
    expect(source).toContain('/admin/accounts')
    expect(source).toContain('claude-mgr.admin.locale')
    expect(source).toContain('Conduit · 网关控制台')
    expect(source).toContain('antd')
    expect(source).not.toContain('accessToken')
    expect(source).not.toContain('refreshToken')
  })

  it('proxies non-streaming Messages and writes audit metadata', async () => {
    const store = seedStore()
    const upstreamCalls: RequestInit[] = []
    const fetch: FetchLike = async (_url, init) => {
      upstreamCalls.push(init ?? {})
      return jsonResponse(
        {
          id: 'msg-1',
          type: 'message',
          usage: { input_tokens: 4, output_tokens: 5 },
          content: [],
        },
        {
          headers: {
            'request-id': 'upstream-1',
            'anthropic-ratelimit-unified-status': 'allowed',
          },
        },
      )
    }
    const handle = createHandler(store, fetch)

    const response = await handle(
      new Request('http://localhost/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-claude-mgr-client-id': 'client-a',
        },
        body: JSON.stringify({
          model: 'claude-test',
          max_tokens: 8,
          messages: [{ role: 'user', content: 'hello' }],
        }),
      }),
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('request-id')).toBe('upstream-1')
    const body = (await response.json()) as { id: string }
    expect(body.id).toBe('msg-1')

    const upstreamBody = JSON.parse(
      String(upstreamCalls[0].body),
    ) as Record<string, unknown>
    expect(upstreamBody.stream).toBe(false)
    expect(upstreamBody.metadata).toBeTypeOf('object')

    const audits = store.listAuditEvents()
    expect(audits).toHaveLength(1)
    expect(audits[0]).toMatchObject({
      clientId: 'client-a',
      accountUuid: 'acc-a',
      tokenLabel: 'token-a',
      model: 'claude-test',
      upstreamRequestId: 'upstream-1',
      status: 'success',
      inputTokens: 4,
      outputTokens: 5,
    })

    const quotaResponse = await handle(
      new Request('http://localhost/admin/quota-snapshots'),
    )
    expect(await quotaResponse.json()).toMatchObject([
      {
        accountUuid: 'acc-a',
        tokenLabel: 'token-a',
        status: 'allowed',
      },
    ])
  })

  it('forwards Claude Code compatibility headers while keeping local routing headers local', async () => {
    const store = seedStore()
    const upstreamCalls: RequestInit[] = []
    const fetch: FetchLike = async (_url, init) => {
      upstreamCalls.push(init ?? {})
      return jsonResponse({ id: 'msg-headers', usage: {} })
    }
    const handle = createHandler(store, fetch)

    const response = await handle(
      new Request('http://localhost/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': 'local-dummy-key',
          'x-claude-mgr-client-id': 'client-a',
          'x-claude-mgr-pool-id': 'pool-main',
          'user-agent': 'claude-cli/2.1.185 (external, sdk-cli)',
          'anthropic-version': '2023-06-01',
          'anthropic-beta':
            'claude-code-20250219,interleaved-thinking-2025-05-14',
          'anthropic-dangerous-direct-browser-access': 'true',
          'anthropic-new-feature': 'enabled',
          'anthropic-api-key': 'must-not-forward',
          'anthropic-auth-token': 'must-not-forward',
          'anthropic-organization-id': 'must-not-forward',
          'x-stainless-lang': 'js',
          'x-stainless-runtime': 'node',
          'x-stainless-package-version': '0.94.0',
        },
        body: JSON.stringify({
          model: 'claude-test',
          max_tokens: 8,
          messages: [{ role: 'user', content: 'hello' }],
        }),
      }),
    )

    expect(response.status).toBe(200)
    const headers = upstreamCalls[0].headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer access-a')
    expect(headers['User-Agent']).toBe('claude-cli/2.1.185 (external, sdk-cli)')
    expect(headers['anthropic-version']).toBe('2023-06-01')
    expect(headers['anthropic-beta']).toBe(
      'claude-code-20250219,interleaved-thinking-2025-05-14',
    )
    expect(headers['anthropic-dangerous-direct-browser-access']).toBe('true')
    expect(headers['anthropic-new-feature']).toBe('enabled')
    expect(headers['x-stainless-lang']).toBe('js')
    expect(headers['x-stainless-runtime']).toBe('node')
    expect(headers['x-stainless-package-version']).toBe('0.94.0')
    expect(headers).not.toHaveProperty('x-api-key')
    expect(headers).not.toHaveProperty('x-claude-mgr-client-id')
    expect(headers).not.toHaveProperty('x-claude-mgr-pool-id')
    expect(headers).not.toHaveProperty('anthropic-api-key')
    expect(headers).not.toHaveProperty('anthropic-auth-token')
    expect(headers).not.toHaveProperty('anthropic-organization-id')
  })

  it('records sanitized downstream debug traffic when enabled', async () => {
    const store = seedStore()
    const debugDir = mkdtempSync(join(tmpdir(), 'claude-mgr-debug-test.'))
    const debugRecorder = new JsonlDebugTrafficRecorder(debugDir)
    const handle = createFetchHandler({
      gateway: new MessagesGateway({
        store,
        upstream: new UpstreamMessagesClient({
          baseApiUrl: 'https://api.example.test',
          fetch: async () => jsonResponse({ id: 'msg-debug', usage: {} }),
        }),
      }),
      store,
      debugRecorder,
    })

    try {
      const response = await handle(
        new Request('http://localhost/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-claude-mgr-client-id': 'client-a',
            'x-api-key': 'local-secret',
          },
          body: JSON.stringify({
            model: 'claude-test',
            max_tokens: 8,
            messages: [{ role: 'user', content: 'sensitive prompt text' }],
          }),
        }),
      )

      expect(response.status).toBe(200)
      const debugOutput = readFileSync(debugRecorder.filePath, 'utf8')
      expect(debugOutput).toContain('"direction":"downstream"')
      expect(debugOutput).toContain('"x-api-key":"[redacted]"')
      expect(debugOutput).toContain('"messageSummary"')
      expect(debugOutput).not.toContain('local-secret')
      expect(debugOutput).not.toContain('sensitive prompt text')
    } finally {
      rmSync(debugDir, { recursive: true, force: true })
    }
  })

  it('uses Claude Code session headers for local account affinity without forwarding them', async () => {
    const store = new SqliteStore(new DatabaseSync(':memory:'))
    store.initialize()
    store.upsertAccount({
      accountUuid: 'acc-a',
      organizationUuid: 'org-a',
      upstreamClientIdentityId: 'identity-a',
    })
    store.upsertAccount({
      accountUuid: 'acc-b',
      organizationUuid: 'org-b',
      upstreamClientIdentityId: 'identity-b',
    })
    store.createPool({ id: 'pool-main', name: 'Main' })
    store.addAccountToPool({
      poolId: 'pool-main',
      accountUuid: 'acc-a',
      priority: 10,
    })
    store.addAccountToPool({
      poolId: 'pool-main',
      accountUuid: 'acc-b',
      priority: 10,
    })
    store.createLocalClient({
      id: 'client-a',
      name: 'Client A',
      defaultPoolId: 'pool-main',
    })
    store.upsertOAuthToken({
      label: 'token-a',
      sourceDevice: 'laptop',
      accountUuid: 'acc-a',
      scopes: ['user:inference'],
      accessToken: 'access-a',
      expiresAt: Date.now() + 60_000,
    })
    store.upsertOAuthToken({
      label: 'token-b',
      sourceDevice: 'desktop',
      accountUuid: 'acc-b',
      scopes: ['user:inference'],
      accessToken: 'access-b',
      expiresAt: Date.now() + 60_000,
    })

    const upstreamCalls: RequestInit[] = []
    const fetch: FetchLike = async (_url, init) => {
      upstreamCalls.push(init ?? {})
      return jsonResponse({ id: `msg-${upstreamCalls.length}`, usage: {} })
    }
    const handle = createHandler(store, fetch)
    const body = JSON.stringify({
      model: 'claude-test',
      max_tokens: 8,
      messages: [{ role: 'user', content: 'hello' }],
    })

    const first = await handle(
      new Request('http://localhost/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-claude-mgr-client-id': 'client-a',
          'X-Claude-Code-Session-Id': 'official-session-1',
        },
        body,
      }),
    )
    const second = await handle(
      new Request('http://localhost/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-claude-mgr-client-id': 'client-a',
          'X-Claude-Code-Session-Id': 'official-session-1',
        },
        body,
      }),
    )
    const unbound = await handle(
      new Request('http://localhost/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-claude-mgr-client-id': 'client-a',
        },
        body,
      }),
    )

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(unbound.status).toBe(200)
    const firstHeaders = upstreamCalls[0].headers as Record<string, string>
    const secondHeaders = upstreamCalls[1].headers as Record<string, string>
    const unboundHeaders = upstreamCalls[2].headers as Record<string, string>
    expect(firstHeaders.Authorization).toBe('Bearer access-a')
    expect(secondHeaders.Authorization).toBe('Bearer access-a')
    expect(unboundHeaders.Authorization).toBe('Bearer access-b')
    expect(firstHeaders['X-Claude-Code-Session-Id']).toBe(
      secondHeaders['X-Claude-Code-Session-Id'],
    )
    expect(firstHeaders['X-Claude-Code-Session-Id']).not.toBe(
      'official-session-1',
    )

    const firstBody = JSON.parse(String(upstreamCalls[0].body)) as {
      metadata: { user_id: string }
    }
    const firstUserId = JSON.parse(firstBody.metadata.user_id) as {
      account_uuid: string
      session_id: string
    }
    expect(firstUserId.account_uuid).toBe('acc-a')
    expect(firstUserId.session_id).toBe(firstHeaders['X-Claude-Code-Session-Id'])
    expect(store.listMessageSessionBindings()).toMatchObject([
      {
        inboundSessionId: 'official-session-1',
        accountUuid: 'acc-a',
        upstreamSessionId: firstHeaders['X-Claude-Code-Session-Id'],
      },
    ])
  })

  it('proxies Claude CLI usage with profile scope credentials', async () => {
    const store = seedStore()
    const upstreamCalls: Array<{ input: string | URL | Request; init?: RequestInit }> =
      []
    const fetch: FetchLike = async (input, init) => {
      upstreamCalls.push({ input, init })
      return jsonResponse(
        {
          five_hour: { utilization: 23, resets_at: '2026-06-22T12:00:00Z' },
        },
        { headers: { 'request-id': 'usage-1' } },
      )
    }
    const handle = createClaudeCliHandler(store, fetch)

    const response = await handle(
      new Request('http://localhost/api/oauth/usage', {
        headers: {
          'x-claude-mgr-client-id': 'client-a',
          'x-claude-mgr-pool-id': 'pool-main',
        },
      }),
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('request-id')).toBe('usage-1')
    expect(await response.json()).toMatchObject({
      five_hour: { utilization: 23 },
    })
    expect(String(upstreamCalls[0].input)).toBe(
      'https://api.example.test/api/oauth/usage',
    )
    const headers = upstreamCalls[0].init?.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer access-a')
    expect(headers['anthropic-beta']).toBe('oauth-2025-04-20')
    expect(headers['User-Agent']).toBe('claude-mgr/0.1.0')
    expect(headers).not.toHaveProperty('x-claude-mgr-client-id')
    expect(headers).not.toHaveProperty('x-claude-mgr-pool-id')
    expect(store.listAuditEvents()).toMatchObject([
      {
        clientId: 'client-a',
        poolId: 'pool-main',
        accountUuid: 'acc-a',
        tokenLabel: 'token-a',
        endpoint: '/api/oauth/usage',
        upstreamRequestId: 'usage-1',
        status: 'success',
      },
    ])
  })

  it('proxies Claude CLI bootstrap and preserves upstream errors', async () => {
    const store = seedStore()
    const fetch: FetchLike = async () =>
      jsonResponse(
        {
          error: {
            type: 'permission_error',
            message: 'profile access denied',
          },
        },
        {
          status: 403,
          headers: { 'request-id': 'bootstrap-denied' },
        },
      )
    const handle = createClaudeCliHandler(store, fetch)

    const response = await handle(
      new Request('http://localhost/api/claude_cli/bootstrap', {
        headers: { 'x-claude-mgr-client-id': 'client-a' },
      }),
    )

    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({
      error: {
        type: 'permission_error',
        message: 'profile access denied',
        upstream_request_id: 'bootstrap-denied',
      },
    })
    expect(store.listAuditEvents()).toMatchObject([
      {
        clientId: 'client-a',
        poolId: 'pool-main',
        endpoint: '/api/claude_cli/bootstrap',
        status: 'error',
        errorType: 'permission_error',
        upstreamRequestId: 'bootstrap-denied',
      },
    ])
  })

  it('requires profile scoped tokens for Claude CLI service endpoints', async () => {
    const store = seedStore()
    store.upsertOAuthToken({
      label: 'token-a',
      sourceDevice: 'laptop',
      accountUuid: 'acc-a',
      scopes: ['user:inference'],
      accessToken: 'access-a',
      refreshToken: null,
      expiresAt: Date.now() + 60_000,
    })
    const handle = createClaudeCliHandler(store, async () => {
      throw new Error('must not call upstream')
    })

    const response = await handle(
      new Request('http://localhost/api/oauth/usage', {
        headers: { 'x-claude-mgr-client-id': 'client-a' },
      }),
    )

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({
      error: { type: 'gateway_no_eligible_token' },
    })
    expect(store.listAuditEvents()).toMatchObject([
      {
        clientId: 'client-a',
        poolId: 'pool-main',
        endpoint: '/api/oauth/usage',
        status: 'error',
        errorType: 'gateway_no_eligible_token',
      },
    ])
  })

  it('proxies Files API requests without parsing content and replaces auth headers', async () => {
    const store = seedStore()
    store.upsertOAuthToken({
      label: 'token-a',
      sourceDevice: 'laptop',
      accountUuid: 'acc-a',
      scopes: ['user:inference'],
      accessToken: 'access-a',
      refreshToken: null,
      expiresAt: Date.now() + 60_000,
    })
    const upstreamCalls: Array<{ input: string | URL | Request; init?: RequestInit }> =
      []
    const fetch: FetchLike = async (input, init) => {
      upstreamCalls.push({ input, init })
      return new Response('file-bytes', {
        status: 200,
        headers: {
          'Content-Type': 'application/octet-stream',
          'request-id': 'file-1',
        },
      })
    }
    const handle = createApiProxyHandler(store, fetch)

    const response = await handle(
      new Request('http://localhost/v1/files/file_123/content?download=true', {
        headers: {
          authorization: 'Bearer downstream-secret',
          'x-api-key': 'downstream-key',
          'x-claude-mgr-client-id': 'client-a',
          'x-claude-mgr-pool-id': 'pool-main',
          'anthropic-version': '2023-06-01',
          'user-agent': 'claude-cli/2.1.185',
        },
      }),
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('application/octet-stream')
    expect(response.headers.get('request-id')).toBe('file-1')
    expect(await response.text()).toBe('file-bytes')
    expect(String(upstreamCalls[0].input)).toBe(
      'https://api.example.test/v1/files/file_123/content?download=true',
    )
    const headers = upstreamCalls[0].init?.headers as Headers
    expect(headers.get('Authorization')).toBe('Bearer access-a')
    expect(headers.get('anthropic-version')).toBe('2023-06-01')
    expect(headers.get('anthropic-beta')).toBe(
      'files-api-2025-04-14,oauth-2025-04-20',
    )
    expect(headers.get('user-agent')).toBe('claude-cli/2.1.185')
    expect(headers.has('x-api-key')).toBe(false)
    expect(headers.has('x-claude-mgr-client-id')).toBe(false)
    expect(headers.has('x-claude-mgr-pool-id')).toBe(false)
    expect(store.listAuditEvents()).toMatchObject([
      {
        clientId: 'client-a',
        poolId: 'pool-main',
        accountUuid: 'acc-a',
        tokenLabel: 'token-a',
        endpoint: '/v1/files/:fileId/content',
        upstreamRequestId: 'file-1',
        status: 'success',
      },
    ])
  })

  it('proxies Files API uploads as raw multipart bodies', async () => {
    const store = seedStore()
    const upstreamCalls: RequestInit[] = []
    const fetch: FetchLike = async (_input, init) => {
      upstreamCalls.push(init ?? {})
      return jsonResponse(
        { id: 'file_123', filename: 'example.txt' },
        { status: 201, headers: { 'request-id': 'file-upload-1' } },
      )
    }
    const handle = createApiProxyHandler(store, fetch)

    const response = await handle(
      new Request('http://localhost/v1/files', {
        method: 'POST',
        headers: {
          'Content-Type': 'multipart/form-data; boundary=test-boundary',
          'x-claude-mgr-client-id': 'client-a',
        },
        body: '--test-boundary\r\nfile-content\r\n--test-boundary--\r\n',
      }),
    )

    expect(response.status).toBe(201)
    const headers = upstreamCalls[0].headers as Headers
    expect(headers.get('Authorization')).toBe('Bearer access-a')
    expect(headers.get('Content-Type')).toBe(
      'multipart/form-data; boundary=test-boundary',
    )
    expect(await new Response(upstreamCalls[0].body).text()).toContain(
      'file-content',
    )
  })

  it('proxies event logging without requiring local auth headers', async () => {
    const store = seedStore()
    const upstreamCalls: RequestInit[] = []
    const fetch: FetchLike = async (_input, init) => {
      upstreamCalls.push(init ?? {})
      return jsonResponse({ ok: true }, { status: 200 })
    }
    const handle = createApiProxyHandler(store, fetch)

    const response = await handle(
      new Request('http://localhost/api/event_logging/batch', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-service-name': 'claude-code',
        },
        body: JSON.stringify({ events: [] }),
      }),
    )

    expect(response.status).toBe(200)
    const headers = upstreamCalls[0].headers as Headers
    expect(headers.has('Authorization')).toBe(false)
    expect(headers.get('x-service-name')).toBe('claude-code')
    expect(await new Response(upstreamCalls[0].body).json()).toEqual({
      events: [],
    })
    expect(store.listAuditEvents()).toMatchObject([
      {
        clientId: '__anonymous__',
        endpoint: '/api/event_logging/batch',
        status: 'success',
      },
    ])
  })

  it('proxies trusted-device enrollment with selected OAuth credentials', async () => {
    const store = seedStore()
    const upstreamCalls: RequestInit[] = []
    const fetch: FetchLike = async (_input, init) => {
      upstreamCalls.push(init ?? {})
      return jsonResponse(
        { device_id: 'dev-1', device_token: 'opaque-token' },
        { status: 201, headers: { 'request-id': 'trusted-1' } },
      )
    }
    const handle = createApiProxyHandler(store, fetch)

    const response = await handle(
      new Request('http://localhost/api/auth/trusted_devices', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-claude-mgr-client-id': 'client-a',
        },
        body: JSON.stringify({ display_name: 'Claude Code on test' }),
      }),
    )

    expect(response.status).toBe(201)
    expect(await response.json()).toMatchObject({ device_id: 'dev-1' })
    const headers = upstreamCalls[0].headers as Headers
    expect(headers.get('Authorization')).toBe('Bearer access-a')
    expect(headers.get('Content-Type')).toBe('application/json')
    expect(await new Response(upstreamCalls[0].body).json()).toEqual({
      display_name: 'Claude Code on test',
    })
    expect(store.listAuditEvents()).toMatchObject([
      {
        clientId: 'client-a',
        endpoint: '/api/auth/trusted_devices',
        upstreamRequestId: 'trusted-1',
        status: 'success',
      },
    ])
  })

  it('proxies SSE Messages without buffering and marks audit success after stream closes', async () => {
    const store = seedStore()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('event: ping\n\n'))
        controller.close()
      },
    })
    const fetch: FetchLike = async () =>
      new Response(stream, {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream',
          'request-id': 'stream-1',
        },
      })
    const handle = createHandler(store, fetch)

    const response = await handle(
      new Request('http://localhost/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-claude-mgr-client-id': 'client-a',
        },
        body: JSON.stringify({
          model: 'claude-test',
          max_tokens: 8,
          stream: true,
          messages: [{ role: 'user', content: 'hello' }],
        }),
      }),
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('text/event-stream')
    expect(store.listAuditEvents()[0]).toMatchObject({
      status: 'pending',
      upstreamRequestId: 'stream-1',
    })

    const text = await response.text()
    expect(text).toBe('event: ping\n\n')
    await waitForAuditStatus(store, 'success')
    expect(store.listAuditEvents()[0]).toMatchObject({
      status: 'success',
      upstreamRequestId: 'stream-1',
    })
  })

  it('marks SSE audit events interrupted when stream reading fails', async () => {
    const store = seedStore()
    const stream = new ReadableStream<Uint8Array>({
      pull() {
        throw new Error('stream broke')
      },
    })
    const fetch: FetchLike = async () =>
      new Response(stream, {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream',
          'request-id': 'stream-broken',
        },
      })
    const handle = createHandler(store, fetch)

    const response = await handle(
      new Request('http://localhost/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-claude-mgr-client-id': 'client-a',
        },
        body: JSON.stringify({
          model: 'claude-test',
          max_tokens: 8,
          stream: true,
          messages: [{ role: 'user', content: 'hello' }],
        }),
      }),
    )

    await expect(response.text()).rejects.toThrow('stream broke')
    await waitForAuditStatus(store, 'interrupted')
    expect(store.listAuditEvents()[0]).toMatchObject({
      status: 'interrupted',
      errorType: 'gateway_stream_parse_error',
      upstreamRequestId: 'stream-broken',
    })
  })

  it('returns gateway auth errors when local client identity is missing', async () => {
    const store = seedStore()
    const handle = createHandler(store, async () => {
      throw new Error('must not call upstream')
    })

    const response = await handle(
      new Request('http://localhost/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-test',
          messages: [{ role: 'user', content: 'hello' }],
        }),
      }),
    )

    expect(response.status).toBe(401)
    const body = (await response.json()) as {
      error: { type: string; upstream_request_id: string | null }
    }
    expect(body.error.type).toBe('gateway_auth_error')
    expect(body.error.upstream_request_id).toBeNull()
    expect(store.listAuditEvents()).toMatchObject([
      {
        clientId: '__missing__',
        endpoint: '/v1/messages',
        status: 'error',
        errorType: 'gateway_auth_error',
      },
    ])
  })

  it('maps SQLite driver errors to gateway storage errors', async () => {
    const store = seedStore()
    const handle = createHandler(store, async () => {
      throw new Error('must not call upstream')
    })

    const response = await handle(
      new Request('http://localhost/admin/pools', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 'pool-main',
          name: 'Main',
        }),
      }),
    )

    expect(response.status).toBe(500)
    const body = (await response.json()) as {
      error: { type: string; upstream_request_id: string | null }
    }
    expect(body.error.type).toBe('gateway_storage_error')
    expect(body.error.upstream_request_id).toBeNull()
  })

  it('returns gateway auth errors and writes audit metadata when local client is disabled', async () => {
    const store = seedStore()
    store.updateLocalClient({ id: 'client-a', enabled: false })
    const handle = createHandler(store, async () => {
      throw new Error('must not call upstream')
    })

    const response = await handle(
      new Request('http://localhost/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-claude-mgr-client-id': 'client-a',
        },
        body: JSON.stringify({
          model: 'claude-test',
          messages: [{ role: 'user', content: 'hello' }],
        }),
      }),
    )

    expect(response.status).toBe(401)
    const body = (await response.json()) as {
      error: { type: string; upstream_request_id: string | null }
    }
    expect(body.error.type).toBe('gateway_auth_error')
    expect(body.error.upstream_request_id).toBeNull()
    expect(store.listAuditEvents()).toMatchObject([
      {
        clientId: 'client-a',
        poolId: 'pool-main',
        endpoint: '/v1/messages',
        model: 'claude-test',
        status: 'error',
        errorType: 'gateway_auth_error',
      },
    ])
  })

  it('writes audit metadata when no eligible token is available', async () => {
    const store = new SqliteStore(new DatabaseSync(':memory:'))
    store.initialize()
    store.upsertAccount({
      accountUuid: 'acc-no-token',
      organizationUuid: 'org-no-token',
      upstreamClientIdentityId: 'identity-no-token',
    })
    store.createPool({ id: 'pool-no-token', name: 'No Token Pool' })
    store.addAccountToPool({
      poolId: 'pool-no-token',
      accountUuid: 'acc-no-token',
    })
    store.createLocalClient({
      id: 'client-no-token',
      name: 'No Token Client',
      defaultPoolId: 'pool-no-token',
    })
    const handle = createHandler(store, async () => {
      throw new Error('must not call upstream')
    })

    const response = await handle(
      new Request('http://localhost/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-claude-mgr-client-id': 'client-no-token',
        },
        body: JSON.stringify({
          model: 'claude-test',
          messages: [{ role: 'user', content: 'hello' }],
        }),
      }),
    )

    expect(response.status).toBe(409)
    expect(store.listAuditEvents()).toMatchObject([
      {
        clientId: 'client-no-token',
        poolId: 'pool-no-token',
        endpoint: '/v1/messages',
        model: 'claude-test',
        status: 'error',
        errorType: 'gateway_no_eligible_token',
      },
    ])
  })

  it('writes audit metadata when no eligible account is available', async () => {
    const store = new SqliteStore(new DatabaseSync(':memory:'))
    store.initialize()
    store.createPool({ id: 'pool-empty', name: 'Empty Pool' })
    store.createLocalClient({
      id: 'client-empty',
      name: 'Empty Client',
      defaultPoolId: 'pool-empty',
    })
    const handle = createHandler(store, async () => {
      throw new Error('must not call upstream')
    })

    const response = await handle(
      new Request('http://localhost/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-claude-mgr-client-id': 'client-empty',
        },
        body: JSON.stringify({
          model: 'claude-test',
          messages: [{ role: 'user', content: 'hello' }],
        }),
      }),
    )

    expect(response.status).toBe(409)
    const body = (await response.json()) as {
      error: { type: string; upstream_request_id: string | null }
    }
    expect(body.error.type).toBe('gateway_no_eligible_account')
    expect(body.error.upstream_request_id).toBeNull()
    expect(store.listAuditEvents()).toMatchObject([
      {
        clientId: 'client-empty',
        poolId: 'pool-empty',
        endpoint: '/v1/messages',
        model: 'claude-test',
        status: 'error',
        errorType: 'gateway_no_eligible_account',
      },
    ])
  })

  it('preserves upstream error type, status and request id', async () => {
    const store = seedStore()
    const handle = createHandler(store, async () =>
      jsonResponse(
        {
          type: 'error',
          error: {
            type: 'overloaded_error',
            message: 'overloaded',
          },
        },
        { status: 529, headers: { 'request-id': 'upstream-529' } },
      ),
    )

    const response = await handle(
      new Request('http://localhost/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-claude-mgr-client-id': 'client-a',
        },
        body: JSON.stringify({
          model: 'claude-test',
          max_tokens: 8,
          messages: [{ role: 'user', content: 'hello' }],
        }),
      }),
    )

    expect(response.status).toBe(529)
    const body = (await response.json()) as {
      error: { type: string; upstream_request_id: string }
    }
    expect(body.error.type).toBe('overloaded_error')
    expect(body.error.upstream_request_id).toBe('upstream-529')
    expect(store.listAuditEvents()[0]).toMatchObject({
      status: 'error',
      errorType: 'overloaded_error',
      upstreamRequestId: 'upstream-529',
    })
  })

  it('returns gateway upstream unreachable errors and writes audit metadata when fetch fails', async () => {
    const store = seedStore()
    const handle = createHandler(store, async () => {
      throw new Error('network down')
    })

    const response = await handle(
      new Request('http://localhost/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-claude-mgr-client-id': 'client-a',
        },
        body: JSON.stringify({
          model: 'claude-test',
          max_tokens: 8,
          messages: [{ role: 'user', content: 'hello' }],
        }),
      }),
    )

    expect(response.status).toBe(502)
    const body = (await response.json()) as {
      error: { type: string; upstream_request_id: string | null }
    }
    expect(body.error.type).toBe('gateway_upstream_unreachable')
    expect(body.error.upstream_request_id).toBeNull()
    expect(store.listAuditEvents()).toMatchObject([
      {
        clientId: 'client-a',
        poolId: 'pool-main',
        accountUuid: 'acc-a',
        tokenLabel: 'token-a',
        endpoint: '/v1/messages',
        model: 'claude-test',
        status: 'error',
        errorType: 'gateway_upstream_unreachable',
      },
    ])
  })

  it('supports OAuth authorize/callback install and redacted token listing', async () => {
    const store = new SqliteStore(new DatabaseSync(':memory:'))
    store.initialize()
    store.createPool({ id: 'pool-oauth', name: 'OAuth Pool' })
    const fetch: FetchLike = async url => {
      if (String(url).endsWith('/v1/oauth/token')) {
        return jsonResponse({
          access_token: 'access-installed',
          refresh_token: 'refresh-installed',
          expires_in: 3600,
          scope: 'user:profile user:inference',
        })
      }
      return jsonResponse({
        account: {
          uuid: 'acc-installed',
          email_address: 'owner@example.test',
          display_name: 'Owner',
        },
        organization: {
          uuid: 'org-installed',
          organization_type: 'claude_pro',
          rate_limit_tier: 'standard',
        },
      })
    }
    const handle = createFetchHandler({
      store,
      oauthClient: new OAuthClient({ fetch }),
      gateway: new MessagesGateway({
        store,
        upstream: new UpstreamMessagesClient({ fetch }),
      }),
    })

    const authorize = await handle(
      new Request(
        'http://localhost/oauth/authorize?label=main&source_device=laptop&redirect_uri=http://localhost/callback&pool_id=pool-oauth',
      ),
    )
    expect(authorize.status).toBe(200)
    const authorizeBody = (await authorize.json()) as {
      authorize_url: string
      state: string
    }
    expect(authorizeBody.authorize_url).toContain('user%3Ainference')

    const callback = await handle(
      new Request('http://localhost/oauth/callback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: 'code-installed',
          state: authorizeBody.state,
        }),
      }),
    )
    expect(callback.status).toBe(200)
    expect(await callback.json()).toMatchObject({
      account_uuid: 'acc-installed',
      organization_uuid: 'org-installed',
      token_label: 'main',
    })

    const tokens = await handle(new Request('http://localhost/admin/tokens'))
    const tokenList = (await tokens.json()) as Array<Record<string, unknown>>
    expect(tokenList[0]).toMatchObject({
      label: 'main',
      accountUuid: 'acc-installed',
      sourceDevice: 'laptop',
    })
    expect(tokenList[0]).not.toHaveProperty('accessToken')
    expect(tokenList[0]).not.toHaveProperty('refreshToken')
  })

  it('defaults OAuth redirect URI to browser GET /callback', async () => {
    const store = new SqliteStore(new DatabaseSync(':memory:'))
    store.initialize()
    const exchangeBodies: Array<Record<string, string>> = []
    const fetch: FetchLike = async (url, init) => {
      if (String(url).endsWith('/v1/oauth/token')) {
        exchangeBodies.push(JSON.parse(String(init?.body)) as Record<string, string>)
        return jsonResponse({
          access_token: 'access-browser',
          refresh_token: 'refresh-browser',
          expires_in: 3600,
          scope: 'user:profile user:inference',
        })
      }
      return jsonResponse({
        account: {
          uuid: 'acc-browser',
          email_address: 'browser@example.test',
          display_name: 'Browser',
        },
        organization: {
          uuid: 'org-browser',
          organization_type: 'claude_pro',
        },
      })
    }
    const handle = createFetchHandler({
      store,
      oauthClient: new OAuthClient({ fetch }),
      gateway: new MessagesGateway({
        store,
        upstream: new UpstreamMessagesClient({ fetch }),
      }),
    })

    const authorize = await handle(
      new Request(
        'http://127.0.0.1:8787/oauth/authorize?label=browser&source_device=laptop',
      ),
    )
    const authorizeBody = (await authorize.json()) as {
      authorize_url: string
      state: string
    }
    const authorizeUrl = new URL(authorizeBody.authorize_url)
    expect(authorizeUrl.searchParams.get('redirect_uri')).toBe(
      'http://127.0.0.1:8787/callback',
    )

    const callback = await handle(
      new Request(
        `http://127.0.0.1:8787/callback?code=browser-code&state=${authorizeBody.state}`,
      ),
    )
    expect(callback.status).toBe(200)
    expect(await callback.json()).toMatchObject({
      account_uuid: 'acc-browser',
      token_label: 'browser',
    })
    expect(exchangeBodies[0].redirect_uri).toBe(
      'http://127.0.0.1:8787/callback',
    )
  })

  it('manages account pools and pool members through admin routes', async () => {
    const store = new SqliteStore(new DatabaseSync(':memory:'))
    store.initialize()
    store.upsertAccount({
      accountUuid: 'acc-admin',
      organizationUuid: 'org-admin',
      upstreamClientIdentityId: 'identity-admin',
    })
    const handle = createFetchHandler({
      store,
      gateway: new MessagesGateway({
        store,
        upstream: new UpstreamMessagesClient({
          fetch: async () => jsonResponse({ id: 'unused' }),
        }),
      }),
    })

    const createdPool = await handle(
      new Request('http://localhost/admin/pools', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 'admin-pool',
          name: 'Admin Pool',
          purpose: 'tests',
        }),
      }),
    )
    expect(createdPool.status).toBe(201)

    const addedMember = await handle(
      new Request('http://localhost/admin/pools/admin-pool/members', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          account_uuid: 'acc-admin',
          priority: 10,
          enabled: true,
        }),
      }),
    )
    expect(addedMember.status).toBe(201)
    expect(await addedMember.json()).toMatchObject({
      poolId: 'admin-pool',
      accountUuid: 'acc-admin',
      priority: 10,
      enabled: true,
    })

    const updatedMember = await handle(
      new Request('http://localhost/admin/pools/admin-pool/members/acc-admin', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: false, priority: 50 }),
      }),
    )
    expect(await updatedMember.json()).toMatchObject({
      enabled: false,
      priority: 50,
    })

    const members = await handle(
      new Request('http://localhost/admin/pools/admin-pool/members'),
    )
    expect(await members.json()).toHaveLength(1)

    const removed = await handle(
      new Request('http://localhost/admin/pools/admin-pool/members/acc-admin', {
        method: 'DELETE',
      }),
    )
    expect(await removed.json()).toEqual({ deleted: true })

    const deletedPool = await handle(
      new Request('http://localhost/admin/pools/admin-pool', {
        method: 'DELETE',
      }),
    )
    expect(await deletedPool.json()).toEqual({ deleted: true })
  })

  it('manages local clients through admin routes', async () => {
    const store = new SqliteStore(new DatabaseSync(':memory:'))
    store.initialize()
    store.createPool({ id: 'pool-clients', name: 'Clients Pool' })
    const handle = createFetchHandler({
      store,
      gateway: new MessagesGateway({
        store,
        upstream: new UpstreamMessagesClient({
          fetch: async () => jsonResponse({ id: 'unused' }),
        }),
      }),
    })

    const created = await handle(
      new Request('http://localhost/admin/clients', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 'client-admin',
          name: 'Client Admin',
          default_pool_id: 'pool-clients',
        }),
      }),
    )
    expect(created.status).toBe(201)
    expect(await created.json()).toMatchObject({
      id: 'client-admin',
      enabled: true,
      defaultPoolId: 'pool-clients',
    })

    const updated = await handle(
      new Request('http://localhost/admin/clients/client-admin', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Client Admin Disabled',
          enabled: false,
          default_pool_id: null,
        }),
      }),
    )
    expect(await updated.json()).toMatchObject({
      id: 'client-admin',
      name: 'Client Admin Disabled',
      enabled: false,
      defaultPoolId: null,
    })

    const deleted = await handle(
      new Request('http://localhost/admin/clients/client-admin', {
        method: 'DELETE',
      }),
    )
    expect(await deleted.json()).toEqual({ deleted: true })
    expect(store.listLocalClients()).toEqual([])
  })

  it('disables Claude accounts through admin routes without removing other accounts', async () => {
    const store = new SqliteStore(new DatabaseSync(':memory:'))
    store.initialize()
    store.upsertAccount({
      accountUuid: 'acc-disabled',
      organizationUuid: 'org-disabled',
      upstreamClientIdentityId: 'identity-disabled',
    })
    store.upsertAccount({
      accountUuid: 'acc-active',
      organizationUuid: 'org-active',
      upstreamClientIdentityId: 'identity-active',
    })
    store.createPool({ id: 'pool-accounts', name: 'Accounts Pool' })
    store.addAccountToPool({
      poolId: 'pool-accounts',
      accountUuid: 'acc-disabled',
      priority: 1,
    })
    store.addAccountToPool({
      poolId: 'pool-accounts',
      accountUuid: 'acc-active',
      priority: 2,
    })
    store.createLocalClient({
      id: 'client-accounts',
      name: 'Accounts Client',
      defaultPoolId: 'pool-accounts',
    })
    store.upsertOAuthToken({
      label: 'token-disabled',
      sourceDevice: 'laptop',
      accountUuid: 'acc-disabled',
      scopes: ['user:inference'],
      accessToken: 'access-disabled',
      expiresAt: Date.now() + 60_000,
    })
    store.upsertOAuthToken({
      label: 'token-active',
      sourceDevice: 'desktop',
      accountUuid: 'acc-active',
      scopes: ['user:inference'],
      accessToken: 'access-active',
      expiresAt: Date.now() + 60_000,
    })
    const handle = createFetchHandler({
      store,
      gateway: new MessagesGateway({
        store,
        upstream: new UpstreamMessagesClient({
          fetch: async () => jsonResponse({ id: 'unused' }),
        }),
      }),
    })

    const disabled = await handle(
      new Request('http://localhost/admin/accounts/acc-disabled', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      }),
    )
    expect(await disabled.json()).toMatchObject({
      accountUuid: 'acc-disabled',
      enabled: false,
    })

    const selected = new AccountRouter(store).resolveCredential({
      localClientId: 'client-accounts',
    })
    expect(selected.account.accountUuid).toBe('acc-active')
    expect(store.listAccounts().map(account => account.accountUuid)).toEqual([
      'acc-disabled',
      'acc-active',
    ])
  })

  it('refreshes an expired OAuth token before proxying Messages', async () => {
    const store = new SqliteStore(new DatabaseSync(':memory:'))
    store.initialize()
    store.upsertAccount({
      accountUuid: 'acc-expired',
      organizationUuid: 'org-expired',
      upstreamClientIdentityId: 'identity-expired',
    })
    store.createPool({ id: 'pool-expired', name: 'Expired Pool' })
    store.addAccountToPool({
      poolId: 'pool-expired',
      accountUuid: 'acc-expired',
    })
    store.createLocalClient({
      id: 'client-expired',
      name: 'Expired Client',
      defaultPoolId: 'pool-expired',
    })
    store.upsertOAuthToken({
      label: 'expired-token',
      sourceDevice: 'laptop',
      accountUuid: 'acc-expired',
      scopes: ['user:inference'],
      accessToken: 'old-access',
      refreshToken: 'refresh-expired',
      expiresAt: Date.now() - 1,
    })

    const oauthFetch: FetchLike = async () =>
      jsonResponse({
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        expires_in: 3600,
        scope: 'user:inference',
      })
    const upstreamCalls: RequestInit[] = []
    const upstreamFetch: FetchLike = async (_url, init) => {
      upstreamCalls.push(init ?? {})
      return jsonResponse({ id: 'msg-refreshed', usage: {} })
    }
    const handle = createFetchHandler({
      store,
      gateway: new MessagesGateway({
        store,
        tokenRefresher: new TokenRefresher(
          store,
          new OAuthClient({ fetch: oauthFetch }),
        ),
        upstream: new UpstreamMessagesClient({ fetch: upstreamFetch }),
      }),
    })

    const response = await handle(
      new Request('http://localhost/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-claude-mgr-client-id': 'client-expired',
        },
        body: JSON.stringify({
          model: 'claude-test',
          max_tokens: 8,
          messages: [{ role: 'user', content: 'hello' }],
        }),
      }),
    )

    expect(response.status).toBe(200)
    expect(store.getOAuthToken('expired-token')).toMatchObject({
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
    })
    const headers = upstreamCalls[0].headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer new-access')
  })

  it('writes refresh failure audit metadata when expired token refresh fails', async () => {
    const store = new SqliteStore(new DatabaseSync(':memory:'))
    store.initialize()
    store.upsertAccount({
      accountUuid: 'acc-refresh-fail',
      organizationUuid: 'org-refresh-fail',
      upstreamClientIdentityId: 'identity-refresh-fail',
    })
    store.createPool({ id: 'pool-refresh-fail', name: 'Refresh Fail Pool' })
    store.addAccountToPool({
      poolId: 'pool-refresh-fail',
      accountUuid: 'acc-refresh-fail',
    })
    store.createLocalClient({
      id: 'client-refresh-fail',
      name: 'Refresh Fail Client',
      defaultPoolId: 'pool-refresh-fail',
    })
    store.upsertOAuthToken({
      label: 'refresh-fail-token',
      sourceDevice: 'laptop',
      accountUuid: 'acc-refresh-fail',
      scopes: ['user:inference'],
      accessToken: 'old-access',
      refreshToken: 'bad-refresh',
      expiresAt: Date.now() - 1,
    })

    const oauthFetch: FetchLike = async () =>
      jsonResponse(
        {
          type: 'error',
          error: {
            type: 'authentication_error',
            message: 'refresh denied',
          },
        },
        { status: 401, headers: { 'request-id': 'refresh-401' } },
      )
    const handle = createFetchHandler({
      store,
      gateway: new MessagesGateway({
        store,
        tokenRefresher: new TokenRefresher(
          store,
          new OAuthClient({ fetch: oauthFetch }),
        ),
        upstream: new UpstreamMessagesClient({
          fetch: async () => jsonResponse({ id: 'must-not-call' }),
        }),
      }),
    })

    const response = await handle(
      new Request('http://localhost/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-claude-mgr-client-id': 'client-refresh-fail',
        },
        body: JSON.stringify({
          model: 'claude-test',
          max_tokens: 8,
          messages: [{ role: 'user', content: 'hello' }],
        }),
      }),
    )

    expect(response.status).toBe(401)
    const body = (await response.json()) as {
      error: { type: string; upstream_request_id: string | null }
    }
    expect(body.error.type).toBe('authentication_error')
    expect(body.error.upstream_request_id).toBe('refresh-401')
    expect(store.listAuditEvents()).toMatchObject([
      {
        clientId: 'client-refresh-fail',
        poolId: 'pool-refresh-fail',
        endpoint: '/v1/messages',
        model: 'claude-test',
        status: 'error',
        errorType: 'authentication_error',
      },
      {
        clientId: 'client-refresh-fail',
        poolId: 'pool-refresh-fail',
        accountUuid: 'acc-refresh-fail',
        tokenLabel: 'refresh-fail-token',
        endpoint: '/v1/oauth/token',
        status: 'error',
        errorType: 'authentication_error',
        upstreamRequestId: 'refresh-401',
      },
    ])
  })

  it('refreshes and retries once when upstream returns 401', async () => {
    const store = new SqliteStore(new DatabaseSync(':memory:'))
    store.initialize()
    store.upsertAccount({
      accountUuid: 'acc-401',
      organizationUuid: 'org-401',
      upstreamClientIdentityId: 'identity-401',
    })
    store.createPool({ id: 'pool-401', name: '401 Pool' })
    store.addAccountToPool({
      poolId: 'pool-401',
      accountUuid: 'acc-401',
    })
    store.createLocalClient({
      id: 'client-401',
      name: '401 Client',
      defaultPoolId: 'pool-401',
    })
    store.upsertOAuthToken({
      label: 'token-401',
      sourceDevice: 'laptop',
      accountUuid: 'acc-401',
      scopes: ['user:inference'],
      accessToken: 'old-access',
      refreshToken: 'refresh-401',
      expiresAt: Date.now() + 60_000,
    })

    const oauthFetch: FetchLike = async () =>
      jsonResponse({
        access_token: 'new-access-401',
        refresh_token: 'new-refresh-401',
        expires_in: 3600,
        scope: 'user:inference',
      })
    const upstreamAuthHeaders: string[] = []
    const upstreamFetch: FetchLike = async (_url, init) => {
      const headers = init?.headers as Record<string, string>
      upstreamAuthHeaders.push(headers.Authorization)
      if (headers.Authorization === 'Bearer old-access') {
        return jsonResponse(
          {
            type: 'error',
            error: {
              type: 'authentication_error',
              message: 'expired token',
            },
          },
          { status: 401, headers: { 'request-id': 'upstream-401' } },
        )
      }
      return jsonResponse({ id: 'msg-after-401', usage: {} })
    }
    const handle = createFetchHandler({
      store,
      gateway: new MessagesGateway({
        store,
        tokenRefresher: new TokenRefresher(
          store,
          new OAuthClient({ fetch: oauthFetch }),
        ),
        upstream: new UpstreamMessagesClient({ fetch: upstreamFetch }),
      }),
    })

    const response = await handle(
      new Request('http://localhost/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-claude-mgr-client-id': 'client-401',
        },
        body: JSON.stringify({
          model: 'claude-test',
          max_tokens: 8,
          messages: [{ role: 'user', content: 'hello' }],
        }),
      }),
    )

    expect(response.status).toBe(200)
    expect(upstreamAuthHeaders).toEqual([
      'Bearer old-access',
      'Bearer new-access-401',
    ])
    expect(store.getOAuthToken('token-401')).toMatchObject({
      accessToken: 'new-access-401',
      refreshToken: 'new-refresh-401',
    })
    expect(store.listAuditEvents().map(event => event.endpoint)).toEqual([
      '/v1/messages',
      '/v1/oauth/token',
    ])
  })
})
