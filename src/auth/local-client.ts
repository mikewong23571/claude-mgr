import { GatewayError } from '../errors.js'
import type { SqliteStore } from '../storage/sqlite-store.js'
import { hashSecret } from './secrets.js'

export function readLocalClientSecret(request: Request): string | null {
  const apiKey = request.headers.get('x-api-key')
  if (apiKey) return apiKey
  const authorization = request.headers.get('authorization')
  if (authorization?.toLowerCase().startsWith('bearer ')) {
    return authorization.slice('bearer '.length).trim()
  }
  return null
}

export function requireAuthenticatedLocalClient(input: {
  store: SqliteStore
  request: Request
  localClientId: string
}): void {
  const client = input.store.getLocalClient(input.localClientId)
  if (!client.enabled) {
    throw new GatewayError(
      'gateway_auth_error',
      `Local client is disabled: ${input.localClientId}`,
      401,
    )
  }
  const secret = readLocalClientSecret(input.request)
  if (!secret) {
    throw new GatewayError(
      'gateway_auth_error',
      'Missing local client secret',
      401,
    )
  }
  const token = input.store.findLocalClientTokenByHash(hashSecret(secret))
  if (!token || token.clientId !== input.localClientId || token.revokedAt) {
    throw new GatewayError(
      'gateway_auth_error',
      'Invalid local client secret',
      401,
    )
  }
  input.store.markLocalClientTokenUsed(token.id)
}
