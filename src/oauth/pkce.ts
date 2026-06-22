import { createHash, randomBytes } from 'node:crypto'

function base64Url(buffer: Buffer): string {
  return buffer
    .toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '')
}

export function createCodeVerifier(): string {
  return base64Url(randomBytes(32))
}

export function createCodeChallenge(verifier: string): string {
  return base64Url(createHash('sha256').update(verifier).digest())
}

export function createOAuthState(): string {
  return base64Url(randomBytes(24))
}
