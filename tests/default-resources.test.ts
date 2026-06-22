import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import {
  defaultClientId,
  defaultPoolId,
  ensureDefaultOwnerResources,
} from '../src/bootstrap/default-resources.js'
import { SqliteStore } from '../src/storage/sqlite-store.js'

function createStore(): SqliteStore {
  const store = new SqliteStore(new DatabaseSync(':memory:'))
  store.initialize()
  return store
}

describe('default owner resources', () => {
  it('creates a default pool and local client for a fresh owner database', () => {
    const store = createStore()
    store.createAppUser({
      id: 'owner-test',
      username: 'owner',
      role: 'owner',
      enabled: true,
    })

    ensureDefaultOwnerResources(store)

    expect(store.getPool(defaultPoolId)).toMatchObject({
      id: defaultPoolId,
      ownerUserId: 'owner-test',
    })
    expect(store.getLocalClient(defaultClientId)).toMatchObject({
      id: defaultClientId,
      ownerUserId: 'owner-test',
      enabled: true,
      defaultPoolId,
    })
  })

  it('does not overwrite existing default resources', () => {
    const store = createStore()
    store.createAppUser({
      id: 'owner-test',
      username: 'owner',
      role: 'owner',
      enabled: true,
    })
    store.createPool({
      id: defaultPoolId,
      name: 'User Edited Pool',
      ownerUserId: 'owner-test',
    })
    store.createLocalClient({
      id: defaultClientId,
      name: 'User Edited Client',
      enabled: false,
      defaultPoolId: null,
      ownerUserId: 'owner-test',
    })

    ensureDefaultOwnerResources(store)

    expect(store.getPool(defaultPoolId)).toMatchObject({
      name: 'User Edited Pool',
    })
    expect(store.getLocalClient(defaultClientId)).toMatchObject({
      name: 'User Edited Client',
      enabled: false,
      defaultPoolId: null,
    })
  })
})
