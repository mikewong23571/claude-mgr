import type { Hono } from 'hono'
import { hashPassword, verifyPassword } from '../../auth/password.js'
import {
  clearSessionCookie,
  createSession,
  deleteSessionFromRequest,
  requireUserFromRequest,
  sessionCookie,
} from '../../auth/session.js'
import { GatewayError } from '../../errors.js'
import type { AppOptions } from '../app.js'
import { json, requireStore } from '../responses.js'
import {
  ChangePasswordBody,
  LoginBody,
  parseJsonBody,
} from '../validation.js'

function userBody(user: {
  id: string
  username: string
  displayName?: string | null
  role: string
  enabled: boolean
}) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName ?? null,
    role: user.role,
    enabled: user.enabled,
  }
}

export function registerAuthRoutes(app: Hono, options: AppOptions): void {
  app.post('/auth/login', async c => {
    const store = requireStore(options.store)
    const body = await parseJsonBody(c.req.raw, LoginBody)
    const user = store.findAppUserByUsername(body.username)
    if (!user?.enabled) {
      throw new GatewayError('gateway_auth_error', 'Invalid username or password', 401)
    }
    const credential = store.findPasswordCredential(user.id)
    if (!credential || !verifyPassword(body.password, credential.passwordHash)) {
      throw new GatewayError('gateway_auth_error', 'Invalid username or password', 401)
    }
    const session = createSession({ store, userId: user.id })
    return json(
      { user: userBody(user) },
      {
        headers: {
          'Set-Cookie': sessionCookie(session.token, session.expiresAt),
        },
      },
    )
  })

  app.post('/auth/logout', c => {
    const store = requireStore(options.store)
    deleteSessionFromRequest(store, c.req.raw)
    return json(
      { ok: true },
      {
        headers: {
          'Set-Cookie': clearSessionCookie(),
        },
      },
    )
  })

  app.get('/auth/me', c => {
    const store = requireStore(options.store)
    return json({ user: userBody(requireUserFromRequest(store, c.req.raw)) })
  })

  app.post('/auth/change-password', async c => {
    const store = requireStore(options.store)
    const user = requireUserFromRequest(store, c.req.raw)
    const body = await parseJsonBody(c.req.raw, ChangePasswordBody)
    const credential = store.findPasswordCredential(user.id)
    if (!credential || !verifyPassword(body.current_password, credential.passwordHash)) {
      throw new GatewayError('gateway_auth_error', 'Current password is invalid', 401)
    }
    store.upsertPasswordCredential({
      userId: user.id,
      passwordHash: hashPassword(body.new_password),
    })
    return json({ ok: true })
  })
}
