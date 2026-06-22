import { createHash, randomBytes } from 'node:crypto'

export function createSecret(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString('base64url')}`
}

export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('base64url')
}
