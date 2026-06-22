import type { Hono } from 'hono'
import type { AppOptions } from '../app.js'
import { json, requireStore } from '../responses.js'
import {
  AddPoolMemberBody,
  CreateClientBody,
  CreatePoolBody,
  UpdateAccountBody,
  UpdateClientBody,
  UpdatePoolBody,
  UpdatePoolMemberBody,
  parseJsonBody,
} from '../validation.js'

export function registerAdminRoutes(app: Hono, options: AppOptions): void {
  app.post('/admin/pools', async c => {
    const store = requireStore(options.store)
    const body = await parseJsonBody(c.req.raw, CreatePoolBody)
    return json(
      store.createPool({
        id: body.id,
        name: body.name,
        purpose: body.purpose,
      }),
      { status: 201 },
    )
  })

  app.get('/admin/pools', () => json(requireStore(options.store).listPools()))

  app.get('/admin/pools/:poolId', c => {
    return json(requireStore(options.store).getPool(c.req.param('poolId')))
  })

  app.patch('/admin/pools/:poolId', async c => {
    const body = await parseJsonBody(c.req.raw, UpdatePoolBody)
    return json(
      requireStore(options.store).updatePool({
        id: c.req.param('poolId'),
        name: body.name,
        purpose: body.purpose,
      }),
    )
  })

  app.delete('/admin/pools/:poolId', c => {
    requireStore(options.store).deletePool(c.req.param('poolId'))
    return json({ deleted: true })
  })

  app.get('/admin/pools/:poolId/members', c => {
    return json(requireStore(options.store).listPoolMembers(c.req.param('poolId')))
  })

  app.post('/admin/pools/:poolId/members', async c => {
    const body = await parseJsonBody(c.req.raw, AddPoolMemberBody)
    return json(
      requireStore(options.store).addAccountToPool({
        poolId: c.req.param('poolId'),
        accountUuid: body.account_uuid,
        priority: body.priority,
        enabled: body.enabled,
      }),
      { status: 201 },
    )
  })

  app.patch('/admin/pools/:poolId/members/:accountUuid', async c => {
    const body = await parseJsonBody(c.req.raw, UpdatePoolMemberBody)
    return json(
      requireStore(options.store).updatePoolMember({
        poolId: c.req.param('poolId'),
        accountUuid: c.req.param('accountUuid'),
        priority: body.priority,
        enabled: body.enabled,
      }),
    )
  })

  app.delete('/admin/pools/:poolId/members/:accountUuid', c => {
    requireStore(options.store).removePoolMember(
      c.req.param('poolId'),
      c.req.param('accountUuid'),
    )
    return json({ deleted: true })
  })

  app.post('/admin/clients', async c => {
    const store = requireStore(options.store)
    const body = await parseJsonBody(c.req.raw, CreateClientBody)
    return json(
      store.createLocalClient({
        id: body.id,
        name: body.name,
        enabled: body.enabled,
        defaultPoolId: body.default_pool_id,
      }),
      { status: 201 },
    )
  })

  app.get('/admin/clients', () => {
    return json(requireStore(options.store).listLocalClients())
  })

  app.patch('/admin/clients/:clientId', async c => {
    const body = await parseJsonBody(c.req.raw, UpdateClientBody)
    return json(
      requireStore(options.store).updateLocalClient({
        id: c.req.param('clientId'),
        name: body.name,
        enabled: body.enabled,
        defaultPoolId: body.default_pool_id,
      }),
    )
  })

  app.delete('/admin/clients/:clientId', c => {
    requireStore(options.store).deleteLocalClient(c.req.param('clientId'))
    return json({ deleted: true })
  })

  app.get('/admin/accounts', () => {
    return json(requireStore(options.store).listAccounts())
  })

  app.patch('/admin/accounts/:accountUuid', async c => {
    const body = await parseJsonBody(c.req.raw, UpdateAccountBody)
    return json(
      requireStore(options.store).updateAccount({
        accountUuid: c.req.param('accountUuid'),
        enabled: body.enabled,
      }),
    )
  })

  app.get('/admin/tokens', () => {
    return json(
      requireStore(options.store).listOAuthTokens().map(token => ({
        label: token.label,
        sourceDevice: token.sourceDevice,
        accountUuid: token.accountUuid,
        scopes: token.scopes,
        expiresAt: token.expiresAt,
        lastUsedAt: token.lastUsedAt,
        createdAt: token.createdAt,
        updatedAt: token.updatedAt,
      })),
    )
  })

  app.get('/admin/audit-events', () => {
    return json(requireStore(options.store).listAuditEvents())
  })

  app.get('/admin/quota-snapshots', () => {
    return json(requireStore(options.store).listQuotaSnapshots())
  })
}
