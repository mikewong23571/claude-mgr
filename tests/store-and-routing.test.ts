import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { GatewayError } from '../src/errors.js'
import { adaptMessagesRequest } from '../src/messages/adapter.js'
import { AccountRouter } from '../src/routing/account-router.js'
import { SqliteStore } from '../src/storage/sqlite-store.js'

function createStore(): SqliteStore {
  const store = new SqliteStore(new DatabaseSync(':memory:'))
  store.initialize()
  return store
}

function seedStore(store: SqliteStore): void {
  store.upsertAccount({
    accountUuid: 'acc-a',
    organizationUuid: 'org-a',
    email: 'a@example.test',
    displayName: 'Account A',
    upstreamClientIdentityId: 'identity-a',
    subscriptionType: 'pro',
    rateLimitTier: 'standard',
  })
  store.upsertAccount({
    accountUuid: 'acc-b',
    organizationUuid: 'org-b',
    email: 'b@example.test',
    displayName: 'Account B',
    upstreamClientIdentityId: 'identity-b',
    subscriptionType: 'pro',
    rateLimitTier: 'standard',
  })
  store.createPool({ id: 'pool-main', name: 'main' })
  store.addAccountToPool({
    poolId: 'pool-main',
    accountUuid: 'acc-a',
    priority: 10,
  })
  store.addAccountToPool({
    poolId: 'pool-main',
    accountUuid: 'acc-b',
    priority: 20,
  })
  store.createLocalClient({
    id: 'client-laptop',
    name: 'Laptop',
    defaultPoolId: 'pool-main',
  })
}

describe('sqlite store and account routing', () => {
  it('stores OAuth credentials in plaintext SQLite fields', () => {
    const store = createStore()
    seedStore(store)

    const token = store.upsertOAuthToken({
      label: 'token-a',
      sourceDevice: 'laptop',
      accountUuid: 'acc-a',
      scopes: ['user:profile', 'user:inference'],
      accessToken: 'access-plain',
      refreshToken: 'refresh-plain',
      expiresAt: Date.now() + 60_000,
    })

    expect(token.accessToken).toBe('access-plain')
    expect(token.refreshToken).toBe('refresh-plain')
    expect(store.getOAuthToken('token-a').scopes).toContain('user:inference')
  })

  it('selects an eligible token from the local client default account pool', () => {
    const store = createStore()
    seedStore(store)
    const now = Date.now()
    store.upsertOAuthToken({
      label: 'token-b',
      sourceDevice: 'desktop',
      accountUuid: 'acc-b',
      scopes: ['user:profile', 'user:inference'],
      accessToken: 'access-b',
      refreshToken: 'refresh-b',
      expiresAt: now + 60_000,
    })
    store.upsertOAuthToken({
      label: 'token-a',
      sourceDevice: 'laptop',
      accountUuid: 'acc-a',
      scopes: ['user:profile', 'user:inference'],
      accessToken: 'access-a',
      refreshToken: 'refresh-a',
      expiresAt: now + 60_000,
    })

    const selected = new AccountRouter(store).resolveCredential({
      localClientId: 'client-laptop',
      nowMs: now,
    })

    expect(selected.account.accountUuid).toBe('acc-a')
    expect(selected.token.label).toBe('token-a')
    expect(selected.poolId).toBe('pool-main')
    expect(store.getOAuthToken('token-a').lastUsedAt).toBe(now)
  })

  it('rejects tokens without user inference scope or unexpired access', () => {
    const store = createStore()
    seedStore(store)
    const now = Date.now()
    store.upsertOAuthToken({
      label: 'profile-only',
      sourceDevice: 'laptop',
      accountUuid: 'acc-a',
      scopes: ['user:profile'],
      accessToken: 'access-a',
      refreshToken: 'refresh-a',
      expiresAt: now + 60_000,
    })
    store.upsertOAuthToken({
      label: 'expired',
      sourceDevice: 'desktop',
      accountUuid: 'acc-b',
      scopes: ['user:profile', 'user:inference'],
      accessToken: 'access-b',
      refreshToken: 'refresh-b',
      expiresAt: now - 1,
    })

    expect(() =>
      new AccountRouter(store).resolveCredential({
        localClientId: 'client-laptop',
        nowMs: now,
      }),
    ).toThrowError(GatewayError)
  })

  it('distinguishes no eligible accounts from no eligible tokens', () => {
    const emptyPoolStore = createStore()
    emptyPoolStore.createPool({ id: 'pool-empty', name: 'empty' })
    emptyPoolStore.createLocalClient({
      id: 'client-empty',
      name: 'Empty Client',
      defaultPoolId: 'pool-empty',
    })
    expect(() =>
      new AccountRouter(emptyPoolStore).resolveCredential({
        localClientId: 'client-empty',
      }),
    ).toThrowError(
      expect.objectContaining({
        type: 'gateway_no_eligible_account',
      }),
    )

    const noTokenStore = createStore()
    noTokenStore.upsertAccount({
      accountUuid: 'acc-no-token',
      organizationUuid: 'org-no-token',
      upstreamClientIdentityId: 'identity-no-token',
    })
    noTokenStore.createPool({ id: 'pool-no-token', name: 'no token' })
    noTokenStore.addAccountToPool({
      poolId: 'pool-no-token',
      accountUuid: 'acc-no-token',
    })
    noTokenStore.createLocalClient({
      id: 'client-no-token',
      name: 'No Token Client',
      defaultPoolId: 'pool-no-token',
    })
    expect(() =>
      new AccountRouter(noTokenStore).resolveCredential({
        localClientId: 'client-no-token',
      }),
    ).toThrowError(
      expect.objectContaining({
        type: 'gateway_no_eligible_token',
      }),
    )
  })

  it('honors pool member enablement and priority updates', () => {
    const store = createStore()
    seedStore(store)
    const now = Date.now()
    store.upsertOAuthToken({
      label: 'token-a',
      sourceDevice: 'laptop',
      accountUuid: 'acc-a',
      scopes: ['user:inference'],
      accessToken: 'access-a',
      refreshToken: 'refresh-a',
      expiresAt: now + 60_000,
    })
    store.upsertOAuthToken({
      label: 'token-b',
      sourceDevice: 'desktop',
      accountUuid: 'acc-b',
      scopes: ['user:inference'],
      accessToken: 'access-b',
      refreshToken: 'refresh-b',
      expiresAt: now + 60_000,
    })

    store.updatePoolMember({
      poolId: 'pool-main',
      accountUuid: 'acc-a',
      enabled: false,
    })
    expect(
      new AccountRouter(store).resolveCredential({
        localClientId: 'client-laptop',
        nowMs: now,
      }).account.accountUuid,
    ).toBe('acc-b')

    store.updatePoolMember({
      poolId: 'pool-main',
      accountUuid: 'acc-a',
      enabled: true,
      priority: 1,
    })
    expect(
      new AccountRouter(store).resolveCredential({
        localClientId: 'client-laptop',
        nowMs: now + 1,
      }).account.accountUuid,
    ).toBe('acc-a')
  })

  it('does not route through disabled Claude accounts', () => {
    const store = createStore()
    seedStore(store)
    const now = Date.now()
    store.upsertOAuthToken({
      label: 'token-a',
      sourceDevice: 'laptop',
      accountUuid: 'acc-a',
      scopes: ['user:inference'],
      accessToken: 'access-a',
      refreshToken: 'refresh-a',
      expiresAt: now + 60_000,
    })
    store.upsertOAuthToken({
      label: 'token-b',
      sourceDevice: 'desktop',
      accountUuid: 'acc-b',
      scopes: ['user:inference'],
      accessToken: 'access-b',
      refreshToken: 'refresh-b',
      expiresAt: now + 60_000,
    })

    expect(store.updateAccount({ accountUuid: 'acc-a', enabled: false })).toMatchObject({
      accountUuid: 'acc-a',
      enabled: false,
    })
    expect(
      new AccountRouter(store).resolveCredential({
        localClientId: 'client-laptop',
        nowMs: now,
      }).account.accountUuid,
    ).toBe('acc-b')

    store.updateAccount({ accountUuid: 'acc-a', enabled: true })
    expect(
      new AccountRouter(store).resolveCredential({
        localClientId: 'client-laptop',
        nowMs: now + 1,
      }).account.accountUuid,
    ).toBe('acc-a')
  })

  it('uses recent quota snapshots to avoid accounts rejected until reset', () => {
    const store = createStore()
    seedStore(store)
    const now = Date.now()
    store.upsertOAuthToken({
      label: 'token-a',
      sourceDevice: 'laptop',
      accountUuid: 'acc-a',
      scopes: ['user:inference'],
      accessToken: 'access-a',
      refreshToken: 'refresh-a',
      expiresAt: now + 60_000,
    })
    store.upsertOAuthToken({
      label: 'token-b',
      sourceDevice: 'desktop',
      accountUuid: 'acc-b',
      scopes: ['user:inference'],
      accessToken: 'access-b',
      refreshToken: 'refresh-b',
      expiresAt: now + 60_000,
    })
    store.insertQuotaSnapshot({
      id: 'quota-a-rejected',
      accountUuid: 'acc-a',
      tokenLabel: 'token-a',
      status: 'rejected',
      rateLimitType: 'five_hour',
      utilization: 1,
      resetsAt: now + 30_000,
      createdAt: now,
    })

    expect(
      new AccountRouter(store).resolveCredential({
        localClientId: 'client-laptop',
        nowMs: now + 1,
      }).account.accountUuid,
    ).toBe('acc-b')

    expect(
      new AccountRouter(store).resolveCredential({
        localClientId: 'client-laptop',
        nowMs: now + 30_001,
      }).account.accountUuid,
    ).toBe('acc-a')
  })

  it('binds an inbound Claude Code session to the initially selected account', () => {
    const store = createStore()
    seedStore(store)
    const now = Date.now()
    store.updatePoolMember({
      poolId: 'pool-main',
      accountUuid: 'acc-b',
      priority: 10,
    })
    store.upsertOAuthToken({
      label: 'token-a',
      sourceDevice: 'laptop',
      accountUuid: 'acc-a',
      scopes: ['user:inference'],
      accessToken: 'access-a',
      refreshToken: 'refresh-a',
      expiresAt: now + 60_000,
    })
    store.upsertOAuthToken({
      label: 'token-b',
      sourceDevice: 'desktop',
      accountUuid: 'acc-b',
      scopes: ['user:inference'],
      accessToken: 'access-b',
      refreshToken: 'refresh-b',
      expiresAt: now + 60_000,
    })
    const router = new AccountRouter(store)

    const first = router.resolveCredential({
      localClientId: 'client-laptop',
      sessionId: 'official-session-1',
      nowMs: now,
    })
    const second = router.resolveCredential({
      localClientId: 'client-laptop',
      sessionId: 'official-session-1',
      nowMs: now + 1,
    })
    const unbound = router.resolveCredential({
      localClientId: 'client-laptop',
      nowMs: now + 2,
    })

    expect(first.account.accountUuid).toBe('acc-a')
    expect(second.account.accountUuid).toBe('acc-a')
    expect(second.upstreamSessionId).toBe(first.upstreamSessionId)
    expect(second.upstreamSessionId).not.toBe('official-session-1')
    expect(unbound.account.accountUuid).toBe('acc-b')
    expect(store.listMessageSessionBindings()).toMatchObject([
      {
        localClientId: 'client-laptop',
        poolId: 'pool-main',
        inboundSessionId: 'official-session-1',
        accountUuid: 'acc-a',
        upstreamSessionId: first.upstreamSessionId,
      },
    ])
  })

  it('does not silently move a bound session to another account', () => {
    const store = createStore()
    seedStore(store)
    const now = Date.now()
    store.upsertOAuthToken({
      label: 'token-a',
      sourceDevice: 'laptop',
      accountUuid: 'acc-a',
      scopes: ['user:inference'],
      accessToken: 'access-a',
      refreshToken: 'refresh-a',
      expiresAt: now + 60_000,
    })
    store.upsertOAuthToken({
      label: 'token-b',
      sourceDevice: 'desktop',
      accountUuid: 'acc-b',
      scopes: ['user:inference'],
      accessToken: 'access-b',
      refreshToken: 'refresh-b',
      expiresAt: now + 60_000,
    })
    const router = new AccountRouter(store)
    expect(
      router.resolveCredential({
        localClientId: 'client-laptop',
        sessionId: 'official-session-1',
        nowMs: now,
      }).account.accountUuid,
    ).toBe('acc-a')

    store.updateAccount({ accountUuid: 'acc-a', enabled: false })

    expect(() =>
      router.resolveCredential({
        localClientId: 'client-laptop',
        sessionId: 'official-session-1',
        nowMs: now + 1,
      }),
    ).toThrowError(
      expect.objectContaining({
        type: 'gateway_no_eligible_account',
      }),
    )
  })

  it('rejects disabled local clients as gateway auth errors', () => {
    const store = createStore()
    seedStore(store)
    const now = Date.now()
    store.upsertOAuthToken({
      label: 'token-a',
      sourceDevice: 'laptop',
      accountUuid: 'acc-a',
      scopes: ['user:inference'],
      accessToken: 'access-a',
      refreshToken: 'refresh-a',
      expiresAt: now + 60_000,
    })

    expect(
      store.updateLocalClient({
        id: 'client-laptop',
        enabled: false,
      }),
    ).toMatchObject({
      id: 'client-laptop',
      enabled: false,
    })
    expect(() =>
      new AccountRouter(store).resolveCredential({
        localClientId: 'client-laptop',
        nowMs: now,
      }),
    ).toThrowError(GatewayError)

    store.updateLocalClient({ id: 'client-laptop', enabled: true })
    expect(
      new AccountRouter(store).resolveCredential({
        localClientId: 'client-laptop',
        nowMs: now + 1,
      }).account.accountUuid,
    ).toBe('acc-a')
  })

  it('removes pool membership and clears local client defaults when deleting pools', () => {
    const store = createStore()
    seedStore(store)

    store.removePoolMember('pool-main', 'acc-a')
    expect(store.listPoolMembers('pool-main').map(member => member.accountUuid)).toEqual([
      'acc-b',
    ])

    store.deletePool('pool-main')
    expect(store.listPools()).toEqual([])
    expect(store.getLocalClient('client-laptop').defaultPoolId).toBeNull()
  })

  it('builds upstream Messages headers and metadata without local routing fields', () => {
    const store = createStore()
    seedStore(store)
    store.upsertOAuthToken({
      label: 'token-a',
      sourceDevice: 'laptop',
      accountUuid: 'acc-a',
      scopes: ['user:profile', 'user:inference'],
      accessToken: 'access-a',
      refreshToken: 'refresh-a',
      expiresAt: Date.now() + 60_000,
    })
    const credential = new AccountRouter(store).resolveCredential({
      localClientId: 'client-laptop',
    })

    const adapted = adaptMessagesRequest({
      credential: {
        ...credential,
        upstreamSessionId: 'mapped-session-1',
      },
      userAgent: 'claude-mgr/0.1.0',
      clientRequestId: 'request-1',
      body: {
        model: 'claude-test',
        max_tokens: 8,
        messages: [{ role: 'user', content: 'hello' }],
        metadata: {
          local_client_id: 'client-laptop',
          pool_id: 'pool-main',
        },
        context_management: {
          edits: [],
        },
      },
    })

    expect(adapted.headers.Authorization).toBe('Bearer access-a')
    expect(adapted.headers['x-client-request-id']).toBe('request-1')
    expect(adapted.headers['X-Claude-Code-Session-Id']).toBe('mapped-session-1')
    expect(adapted.headers).not.toHaveProperty('pool_id')
    expect(adapted.headers).not.toHaveProperty('token_label')

    const metadata = adapted.body.metadata as Record<string, string>
    const userId = JSON.parse(metadata.user_id) as Record<string, string>
    expect(userId.account_uuid).toBe('acc-a')
    expect(userId.device_id).toBe('identity-a')
    expect(userId.session_id).toBe('mapped-session-1')
    expect(metadata).not.toHaveProperty('local_client_id')
    expect(metadata).not.toHaveProperty('pool_id')
    expect(adapted.body).not.toHaveProperty('pool_id')
    expect(adapted.body).not.toHaveProperty('token_label')
    expect(adapted.body).not.toHaveProperty('context_management')
  })
})
