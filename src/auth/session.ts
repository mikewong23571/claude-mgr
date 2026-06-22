import { randomUUID } from 'node:crypto'
import type { AppUser } from '../domain/types.js'
import { GatewayError } from '../errors.js'
import type { SqliteStore } from '../storage/sqlite-store.js'
import { createSecret, hashSecret } from './secrets.js'

export const sessionCookieName = 'claude_mgr_session'
export const sessionTtlMs = 7 * 24 * 60 * 60 * 1000

export type AuthenticatedUser = AppUser

export function parseCookies(header: string | null): Map<string, string> {
  const cookies = new Map<string, string>()
  if (!header) return cookies
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index === -1) continue
    const name = part.slice(0, index).trim()
    const value = part.slice(index + 1).trim()
    if (name) cookies.set(name, decodeURIComponent(value))
  }
  return cookies
}

export function sessionCookie(token: string, expiresAt: number): string {
  const maxAge = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000))
  return [
    `${sessionCookieName}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ].join('; ')
}

export function clearSessionCookie(): string {
  return [
    `${sessionCookieName}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
  ].join('; ')
}

export function createSession(input: {
  store: SqliteStore
  userId: string
  nowMs?: number
}): { token: string; expiresAt: number } {
  const nowMs = input.nowMs ?? Date.now()
  const token = createSecret('cms')
  const expiresAt = nowMs + sessionTtlMs
  input.store.createUserSession({
    id: randomUUID(),
    userId: input.userId,
    sessionHash: hashSecret(token),
    expiresAt,
  })
  return { token, expiresAt }
}

export function optionalUserFromRequest(
  store: SqliteStore,
  request: Request,
): AuthenticatedUser | null {
  const token = parseCookies(request.headers.get('cookie')).get(sessionCookieName)
  if (!token) return null
  const session = store.findUserSessionByHash(hashSecret(token))
  if (!session || session.expiresAt <= Date.now()) return null
  const user = store.findAppUser(session.userId)
  if (!user?.enabled) return null
  store.touchUserSession(session.id)
  return user
}

export function requireUserFromRequest(
  store: SqliteStore,
  request: Request,
): AuthenticatedUser {
  const user = optionalUserFromRequest(store, request)
  if (!user) {
    throw new GatewayError('gateway_auth_error', 'Login required', 401)
  }
  return user
}

export function deleteSessionFromRequest(
  store: SqliteStore,
  request: Request,
): void {
  const token = parseCookies(request.headers.get('cookie')).get(sessionCookieName)
  if (!token) return
  const session = store.findUserSessionByHash(hashSecret(token))
  if (session) store.deleteUserSession(session.id)
}
