import type { AppUser } from '../domain/types.js'
import type { SqliteStore } from '../storage/sqlite-store.js'

export const defaultPoolId = 'default'
export const defaultClientId = 'default'

function firstEnabledOwner(store: SqliteStore): AppUser | null {
  return (
    store
      .listAppUsers()
      .find(user => user.enabled && user.role === 'owner') ?? null
  )
}

export function ensureDefaultOwnerResources(store: SqliteStore): void {
  const owner = firstEnabledOwner(store)
  if (!owner) return

  const hasDefaultPool = store.listPools().some(pool => pool.id === defaultPoolId)
  if (!hasDefaultPool) {
    store.createPool({
      id: defaultPoolId,
      name: 'Default',
      purpose: 'Default account pool for first-run setup',
      ownerUserId: owner.id,
    })
  }

  const hasDefaultClient = store
    .listLocalClients()
    .some(client => client.id === defaultClientId)
  if (!hasDefaultClient) {
    store.createLocalClient({
      id: defaultClientId,
      name: 'Default Client',
      ownerUserId: owner.id,
      enabled: true,
      defaultPoolId,
    })
  }
}
