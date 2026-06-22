export type Locale = 'en' | 'zh'

export type AppUserRole = 'owner' | 'admin' | 'viewer'

export type AuthUser = {
  id: string
  username: string
  displayName: string | null
  role: AppUserRole
  enabled: boolean
  createdAt?: number
  updatedAt?: number
}

export type Account = {
  accountUuid: string
  organizationUuid: string
  email: string | null
  displayName: string | null
  upstreamClientIdentityId: string
  enabled: boolean
  subscriptionType: string | null
  rateLimitTier: string | null
  createdAt: number
  updatedAt: number
}

export type Pool = {
  id: string
  name: string
  purpose: string | null
  createdAt: number
  updatedAt: number
}

export type PoolMember = {
  poolId: string
  accountUuid: string
  priority: number
  enabled: boolean
  createdAt: number
}

export type LocalClient = {
  id: string
  name: string
  enabled: boolean
  defaultPoolId: string | null
  createdAt: number
  updatedAt: number
}

export type LocalClientTokenMeta = {
  id: string
  clientId: string
  name: string
  createdByUserId: string | null
  createdAt: number
  lastUsedAt: number | null
  revokedAt: number | null
}

export type OAuthTokenMeta = {
  label: string
  sourceDevice: string
  accountUuid: string
  scopes: string[]
  expiresAt: number | null
  lastUsedAt: number | null
  createdAt: number
  updatedAt: number
}

export type AuditEvent = {
  id: string
  clientId: string
  poolId: string | null
  accountUuid: string | null
  tokenLabel: string | null
  endpoint: string | null
  model: string | null
  upstreamRequestId: string | null
  clientRequestId: string | null
  status: string
  errorType: string | null
  inputTokens: number | null
  outputTokens: number | null
  quotaSnapshotId: string | null
  createdAt: number
}

export type QuotaSnapshot = {
  id: string
  accountUuid: string
  tokenLabel: string | null
  status: string
  rateLimitType: string | null
  utilization: number | null
  resetsAt: number | null
  createdAt: number
}

export type AdminState = {
  accounts: Account[]
  pools: Pool[]
  poolMembers: Record<string, PoolMember[]>
  clients: LocalClient[]
  tokens: OAuthTokenMeta[]
  auditEvents: AuditEvent[]
  quotaSnapshots: QuotaSnapshot[]
}
