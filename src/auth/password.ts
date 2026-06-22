import {
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto'

const keyLength = 64
const scryptOptions = {
  N: 16_384,
  r: 8,
  p: 1,
} as const

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('base64url')
  const hash = scryptSync(password, salt, keyLength, scryptOptions).toString(
    'base64url',
  )
  return `scrypt$${scryptOptions.N}$${scryptOptions.r}$${scryptOptions.p}$${salt}$${hash}`
}

export function verifyPassword(password: string, encoded: string): boolean {
  const parts = encoded.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const [, n, r, p, salt, expectedHash] = parts
  const expected = Buffer.from(expectedHash, 'base64url')
  const actual = scryptSync(password, salt, expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  })
  return (
    expected.length === actual.length &&
    timingSafeEqual(expected, actual)
  )
}
