import type {
  Account,
  AdminState,
  AuthUser,
  AuditEvent,
  LocalClient,
  OAuthTokenMeta,
  Pool,
  PoolMember,
  QuotaSnapshot,
} from './types.js'

export class ApiError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export async function apiJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  })
  const body = (await response.json().catch(() => null)) as
    | { error?: { message?: string } }
    | T
    | null
  if (!response.ok) {
    const errorMessage =
      body && typeof body === 'object' && 'error' in body
        ? body.error?.message
        : null
    throw new ApiError(response.status, errorMessage ?? `Request failed: ${response.status}`)
  }
  return body as T
}

export async function loadCurrentUser(): Promise<AuthUser> {
  const response = await apiJson<{ user: AuthUser }>('/auth/me')
  return response.user
}

export async function loadAdminState(): Promise<AdminState> {
  const [accounts, pools, clients, tokens, auditEvents, quotaSnapshots] =
    await Promise.all([
      apiJson<Account[]>('/admin/accounts'),
      apiJson<Pool[]>('/admin/pools'),
      apiJson<LocalClient[]>('/admin/clients'),
      apiJson<OAuthTokenMeta[]>('/admin/tokens'),
      apiJson<AuditEvent[]>('/admin/audit-events'),
      apiJson<QuotaSnapshot[]>('/admin/quota-snapshots'),
    ])
  const memberEntries = await Promise.all(
    pools.map(async pool => [
      pool.id,
      await apiJson<PoolMember[]>(
        `/admin/pools/${encodeURIComponent(pool.id)}/members`,
      ),
    ] as const),
  )
  return {
    accounts,
    pools,
    clients,
    tokens,
    auditEvents,
    quotaSnapshots,
    poolMembers: Object.fromEntries(memberEntries),
  }
}
