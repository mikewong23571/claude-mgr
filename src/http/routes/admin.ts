import { randomUUID } from 'node:crypto'
import type { Hono } from 'hono'
import { hashPassword } from '../../auth/password.js'
import { requireRole } from '../../auth/permissions.js'
import { createSecret, hashSecret } from '../../auth/secrets.js'
import { requireUserFromRequest } from '../../auth/session.js'
import type { AppUser } from '../../domain/types.js'
import { GatewayError } from '../../errors.js'
import type { SqliteStore } from '../../storage/sqlite-store.js'
import type { AppOptions } from '../app.js'
import { json, requireStore } from '../responses.js'
import {
  AddPoolMemberBody,
  CreateClientBody,
  CreateClientTokenBody,
  CreatePoolBody,
  CreateUserBody,
  ResetUserPasswordBody,
  UpdateAccountBody,
  UpdateClientBody,
  UpdatePoolBody,
  UpdatePoolMemberBody,
  UpdateUserBody,
  parseJsonBody,
} from '../validation.js'

function requireAdminContext(
  request: Request,
  options: AppOptions,
  minimumRole: AppUser['role'] = 'viewer',
): { store: SqliteStore; user: AppUser } {
  const store = requireStore(options.store)
  const user = requireUserFromRequest(store, request)
  requireRole(user, minimumRole)
  return { store, user }
}

function canSee(user: AppUser, ownerUserId?: string | null): boolean {
  return user.role === 'owner' || ownerUserId === user.id
}

function assertPoolVisibleForWrite(
  store: SqliteStore,
  user: AppUser,
  poolId?: string | null,
): void {
  if (!poolId) return
  const pool = store.getPool(poolId)
  if (!canSee(user, pool.ownerUserId)) {
    throw new GatewayError('gateway_auth_error', 'Pool is not visible', 403)
  }
}

function userBody(user: AppUser) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName ?? null,
    role: user.role,
    enabled: user.enabled,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  }
}

function assertNotLastEnabledOwner(store: SqliteStore, user: AppUser, enabled?: boolean): void {
  if (user.role !== 'owner' || enabled !== false || store.countEnabledOwners() > 1) {
    return
  }
  throw new GatewayError(
    'gateway_auth_error',
    'Cannot disable the last enabled owner',
    400,
  )
}

export function registerAdminRoutes(app: Hono, options: AppOptions): void {
  app.post('/admin/pools', async c => {
    const { store, user } = requireAdminContext(c.req.raw, options, 'admin')
    const body = await parseJsonBody(c.req.raw, CreatePoolBody)
    return json(
      store.createPool({
        id: body.id,
        name: body.name,
        purpose: body.purpose,
        ownerUserId: user.id,
      }),
      { status: 201 },
    )
  })

  app.get('/admin/pools', c => {
    const { store, user } = requireAdminContext(c.req.raw, options)
    return json(store.listPools().filter(pool => canSee(user, pool.ownerUserId)))
  })

  app.get('/admin/pools/:poolId', c => {
    const { store, user } = requireAdminContext(c.req.raw, options)
    const pool = store.getPool(c.req.param('poolId'))
    if (!canSee(user, pool.ownerUserId)) {
      throw new GatewayError('gateway_auth_error', 'Pool is not visible', 403)
    }
    return json(pool)
  })

  app.patch('/admin/pools/:poolId', async c => {
    const { store, user } = requireAdminContext(c.req.raw, options, 'admin')
    const existing = store.getPool(c.req.param('poolId'))
    if (!canSee(user, existing.ownerUserId)) {
      throw new GatewayError('gateway_auth_error', 'Pool is not visible', 403)
    }
    const body = await parseJsonBody(c.req.raw, UpdatePoolBody)
    return json(
      store.updatePool({
        id: c.req.param('poolId'),
        name: body.name,
        purpose: body.purpose,
      }),
    )
  })

  app.delete('/admin/pools/:poolId', c => {
    const { store, user } = requireAdminContext(c.req.raw, options, 'admin')
    const existing = store.getPool(c.req.param('poolId'))
    if (!canSee(user, existing.ownerUserId)) {
      throw new GatewayError('gateway_auth_error', 'Pool is not visible', 403)
    }
    store.deletePool(c.req.param('poolId'))
    return json({ deleted: true })
  })

  app.get('/admin/pools/:poolId/members', c => {
    const { store, user } = requireAdminContext(c.req.raw, options)
    const pool = store.getPool(c.req.param('poolId'))
    if (!canSee(user, pool.ownerUserId)) {
      throw new GatewayError('gateway_auth_error', 'Pool is not visible', 403)
    }
    return json(store.listPoolMembers(c.req.param('poolId')))
  })

  app.post('/admin/pools/:poolId/members', async c => {
    const { store, user } = requireAdminContext(c.req.raw, options, 'admin')
    const pool = store.getPool(c.req.param('poolId'))
    if (!canSee(user, pool.ownerUserId)) {
      throw new GatewayError('gateway_auth_error', 'Pool is not visible', 403)
    }
    const body = await parseJsonBody(c.req.raw, AddPoolMemberBody)
    const account = store.getAccount(body.account_uuid)
    if (!canSee(user, account.ownerUserId)) {
      throw new GatewayError('gateway_auth_error', 'Account is not visible', 403)
    }
    return json(
      store.addAccountToPool({
        poolId: c.req.param('poolId'),
        accountUuid: body.account_uuid,
        priority: body.priority,
        enabled: body.enabled,
      }),
      { status: 201 },
    )
  })

  app.patch('/admin/pools/:poolId/members/:accountUuid', async c => {
    const { store, user } = requireAdminContext(c.req.raw, options, 'admin')
    const pool = store.getPool(c.req.param('poolId'))
    if (!canSee(user, pool.ownerUserId)) {
      throw new GatewayError('gateway_auth_error', 'Pool is not visible', 403)
    }
    const body = await parseJsonBody(c.req.raw, UpdatePoolMemberBody)
    return json(
      store.updatePoolMember({
        poolId: c.req.param('poolId'),
        accountUuid: c.req.param('accountUuid'),
        priority: body.priority,
        enabled: body.enabled,
      }),
    )
  })

  app.delete('/admin/pools/:poolId/members/:accountUuid', c => {
    const { store, user } = requireAdminContext(c.req.raw, options, 'admin')
    const pool = store.getPool(c.req.param('poolId'))
    if (!canSee(user, pool.ownerUserId)) {
      throw new GatewayError('gateway_auth_error', 'Pool is not visible', 403)
    }
    store.removePoolMember(c.req.param('poolId'), c.req.param('accountUuid'))
    return json({ deleted: true })
  })

  app.post('/admin/clients', async c => {
    const { store, user } = requireAdminContext(c.req.raw, options, 'admin')
    const body = await parseJsonBody(c.req.raw, CreateClientBody)
    assertPoolVisibleForWrite(store, user, body.default_pool_id)
    return json(
      store.createLocalClient({
        id: body.id,
        name: body.name,
        ownerUserId: user.id,
        enabled: body.enabled,
        defaultPoolId: body.default_pool_id,
      }),
      { status: 201 },
    )
  })

  app.get('/admin/clients', c => {
    const { store, user } = requireAdminContext(c.req.raw, options)
    return json(
      store
        .listLocalClients()
        .filter(client => canSee(user, client.ownerUserId)),
    )
  })

  app.patch('/admin/clients/:clientId', async c => {
    const { store, user } = requireAdminContext(c.req.raw, options, 'admin')
    const existing = store.getLocalClient(c.req.param('clientId'))
    if (!canSee(user, existing.ownerUserId)) {
      throw new GatewayError('gateway_auth_error', 'Client is not visible', 403)
    }
    const body = await parseJsonBody(c.req.raw, UpdateClientBody)
    assertPoolVisibleForWrite(store, user, body.default_pool_id)
    return json(
      store.updateLocalClient({
        id: c.req.param('clientId'),
        name: body.name,
        enabled: body.enabled,
        defaultPoolId: body.default_pool_id,
      }),
    )
  })

  app.delete('/admin/clients/:clientId', c => {
    const { store, user } = requireAdminContext(c.req.raw, options, 'admin')
    const existing = store.getLocalClient(c.req.param('clientId'))
    if (!canSee(user, existing.ownerUserId)) {
      throw new GatewayError('gateway_auth_error', 'Client is not visible', 403)
    }
    store.deleteLocalClient(c.req.param('clientId'))
    return json({ deleted: true })
  })

  app.post('/admin/clients/:clientId/tokens', async c => {
    const { store, user } = requireAdminContext(c.req.raw, options, 'admin')
    const client = store.getLocalClient(c.req.param('clientId'))
    if (!canSee(user, client.ownerUserId)) {
      throw new GatewayError('gateway_auth_error', 'Client is not visible', 403)
    }
    const body = await parseJsonBody(c.req.raw, CreateClientTokenBody)
    const secret = createSecret('cmc')
    const token = store.createLocalClientToken({
      id: randomUUID(),
      clientId: client.id,
      name: body.name,
      tokenHash: hashSecret(secret),
      createdByUserId: user.id,
    })
    return json(
      {
        id: token.id,
        clientId: token.clientId,
        name: token.name,
        secret,
        createdAt: token.createdAt,
      },
      { status: 201 },
    )
  })

  app.get('/admin/clients/:clientId/tokens', c => {
    const { store, user } = requireAdminContext(c.req.raw, options)
    const client = store.getLocalClient(c.req.param('clientId'))
    if (!canSee(user, client.ownerUserId)) {
      throw new GatewayError('gateway_auth_error', 'Client is not visible', 403)
    }
    return json(
      store.listLocalClientTokens(client.id).map(token => ({
        id: token.id,
        clientId: token.clientId,
        name: token.name,
        createdByUserId: token.createdByUserId,
        createdAt: token.createdAt,
        lastUsedAt: token.lastUsedAt,
        revokedAt: token.revokedAt,
      })),
    )
  })

  app.delete('/admin/clients/:clientId/tokens/:tokenId', c => {
    const { store, user } = requireAdminContext(c.req.raw, options, 'admin')
    const client = store.getLocalClient(c.req.param('clientId'))
    if (!canSee(user, client.ownerUserId)) {
      throw new GatewayError('gateway_auth_error', 'Client is not visible', 403)
    }
    const token = store.getLocalClientToken(c.req.param('tokenId'))
    if (token.clientId !== client.id) {
      throw new GatewayError('gateway_validation_error', 'Token does not belong to client', 400)
    }
    return json(store.revokeLocalClientToken(token.id))
  })

  app.get('/admin/accounts', c => {
    const { store, user } = requireAdminContext(c.req.raw, options)
    return json(
      store.listAccounts().filter(account => canSee(user, account.ownerUserId)),
    )
  })

  app.patch('/admin/accounts/:accountUuid', async c => {
    const { store, user } = requireAdminContext(c.req.raw, options, 'admin')
    const existing = store.getAccount(c.req.param('accountUuid'))
    if (!canSee(user, existing.ownerUserId)) {
      throw new GatewayError('gateway_auth_error', 'Account is not visible', 403)
    }
    const body = await parseJsonBody(c.req.raw, UpdateAccountBody)
    return json(
      store.updateAccount({
        accountUuid: c.req.param('accountUuid'),
        enabled: body.enabled,
      }),
    )
  })

  app.get('/admin/tokens', c => {
    const { store, user } = requireAdminContext(c.req.raw, options)
    return json(
      store
        .listOAuthTokens()
        .filter(token => canSee(user, token.ownerUserId))
        .map(token => ({
          label: token.label,
          sourceDevice: token.sourceDevice,
          accountUuid: token.accountUuid,
          ownerUserId: token.ownerUserId,
          scopes: token.scopes,
          expiresAt: token.expiresAt,
          lastUsedAt: token.lastUsedAt,
          createdAt: token.createdAt,
          updatedAt: token.updatedAt,
        })),
    )
  })

  app.delete('/admin/tokens/:label', c => {
    const { store, user } = requireAdminContext(c.req.raw, options, 'admin')
    const token = store.getOAuthToken(c.req.param('label'))
    if (!canSee(user, token.ownerUserId)) {
      throw new GatewayError('gateway_auth_error', 'Token is not visible', 403)
    }
    store.deleteOAuthToken(token.label)
    return json({ deleted: true })
  })

  app.get('/admin/audit-events', c => {
    const { store, user } = requireAdminContext(c.req.raw, options)
    if (user.role === 'owner') return json(store.listAuditEvents())
    const visibleAccounts = new Set(
      store
        .listAccounts()
        .filter(account => canSee(user, account.ownerUserId))
        .map(account => account.accountUuid),
    )
    const visibleClients = new Set(
      store
        .listLocalClients()
        .filter(client => canSee(user, client.ownerUserId))
        .map(client => client.id),
    )
    return json(
      store.listAuditEvents().filter(event =>
        (event.accountUuid ? visibleAccounts.has(event.accountUuid) : false) ||
        visibleClients.has(event.clientId),
      ),
    )
  })

  app.get('/admin/quota-snapshots', c => {
    const { store, user } = requireAdminContext(c.req.raw, options)
    if (user.role === 'owner') return json(store.listQuotaSnapshots())
    const visibleAccounts = new Set(
      store
        .listAccounts()
        .filter(account => canSee(user, account.ownerUserId))
        .map(account => account.accountUuid),
    )
    return json(
      store
        .listQuotaSnapshots()
        .filter(snapshot => visibleAccounts.has(snapshot.accountUuid)),
    )
  })

  app.get('/admin/users', c => {
    const { store, user } = requireAdminContext(c.req.raw, options, 'owner')
    return json(store.listAppUsers().map(item => userBody(item)))
  })

  app.post('/admin/users', async c => {
    const { store } = requireAdminContext(c.req.raw, options, 'owner')
    const body = await parseJsonBody(c.req.raw, CreateUserBody)
    const user = store.createAppUser({
      id: randomUUID(),
      username: body.username,
      displayName: body.display_name,
      role: body.role,
      enabled: body.enabled,
    })
    store.upsertPasswordCredential({
      userId: user.id,
      passwordHash: hashPassword(body.password),
    })
    return json(userBody(user), { status: 201 })
  })

  app.patch('/admin/users/:userId', async c => {
    const { store, user: actor } = requireAdminContext(c.req.raw, options, 'owner')
    const target = store.getAppUser(c.req.param('userId'))
    const body = await parseJsonBody(c.req.raw, UpdateUserBody)
    assertNotLastEnabledOwner(store, target, body.enabled)
    if (target.role === 'owner' && target.id !== actor.id) {
      throw new GatewayError(
        'gateway_auth_error',
        'Only the owner user can modify another owner',
        403,
      )
    }
    return json(
      userBody(
        store.updateAppUser({
          id: target.id,
          username: body.username,
          displayName: body.display_name,
          role: body.role,
          enabled: body.enabled,
        }),
      ),
    )
  })

  app.post('/admin/users/:userId/reset-password', async c => {
    const { store } = requireAdminContext(c.req.raw, options, 'owner')
    const target = store.getAppUser(c.req.param('userId'))
    const body = await parseJsonBody(c.req.raw, ResetUserPasswordBody)
    store.upsertPasswordCredential({
      userId: target.id,
      passwordHash: hashPassword(body.password),
    })
    return json({ ok: true })
  })

  app.post('/admin/users/:userId/disable', c => {
    const { store, user: actor } = requireAdminContext(c.req.raw, options, 'owner')
    const target = store.getAppUser(c.req.param('userId'))
    if (target.role === 'owner' && target.id !== actor.id) {
      throw new GatewayError(
        'gateway_auth_error',
        'Only the owner user can disable another owner',
        403,
      )
    }
    assertNotLastEnabledOwner(store, target, false)
    return json(userBody(store.updateAppUser({ id: target.id, enabled: false })))
  })
}
