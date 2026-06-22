import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { hashSecret } from '../src/auth/secrets.js'
import { createNodeServer } from '../src/http/server.js'
import type { FetchLike } from '../src/http/fetch-types.js'
import { MessagesGateway } from '../src/messages/gateway.js'
import { SqliteStore } from '../src/storage/sqlite-store.js'
import { UpstreamMessagesClient } from '../src/upstream/messages-client.js'

const servers: Array<ReturnType<typeof createNodeServer>> = []

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
  store.createLocalClientToken({
    id: 'test-token-client-a',
    clientId: 'client-a',
    name: 'Test token',
    tokenHash: hashSecret('local-dummy-key'),
  })
  store.upsertOAuthToken({
    label: 'token-a',
    sourceDevice: 'laptop',
    accountUuid: 'acc-a',
    scopes: ['user:inference'],
    accessToken: 'access-a',
    expiresAt: Date.now() + 60_000,
  })
  return store
}

async function listen(server: ReturnType<typeof createNodeServer>): Promise<string> {
  servers.push(server)
  await new Promise<void>(resolve => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Expected TCP server address')
  }
  return `http://127.0.0.1:${address.port}`
}

async function closeServer(server: ReturnType<typeof createNodeServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close(error => (error ? reject(error) : resolve()))
  })
}

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop()
    if (server?.listening) {
      await closeServer(server)
    }
  }
})

describe('Node HTTP server', () => {
  it('survives upstream SSE stream errors', async () => {
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
    const server = createNodeServer({
      store,
      gateway: new MessagesGateway({
        store,
        upstream: new UpstreamMessagesClient({
          baseApiUrl: 'https://api.example.test',
          fetch,
        }),
      }),
    })
    const origin = await listen(server)

    await expect(
      fetchGlobal(`${origin}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-claude-mgr-client-id': 'client-a',
          'x-api-key': 'local-dummy-key',
        },
        body: JSON.stringify({
          model: 'claude-test',
          max_tokens: 8,
          stream: true,
          messages: [{ role: 'user', content: 'hello' }],
        }),
      }),
    ).rejects.toThrow()
    const health = await fetchGlobal(`${origin}/health`)
    expect(health.status).toBe(200)
    expect(await health.json()).toEqual({ ok: true })
  })
})

const fetchGlobal = globalThis.fetch.bind(globalThis)
