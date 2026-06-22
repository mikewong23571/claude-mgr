export type UnixMillis = number

export type ClaudeAccount = {
  accountUuid: string
  organizationUuid: string
  email?: string | null
  displayName?: string | null
  upstreamClientIdentityId: string
  enabled: boolean
  subscriptionType?: string | null
  rateLimitTier?: string | null
  createdAt: UnixMillis
  updatedAt: UnixMillis
}

export type OAuthToken = {
  label: string
  sourceDevice: string
  accountUuid: string
  scopes: string[]
  accessToken: string
  refreshToken?: string | null
  expiresAt?: UnixMillis | null
  lastUsedAt?: UnixMillis | null
  createdAt: UnixMillis
  updatedAt: UnixMillis
}

export type AccountPool = {
  id: string
  name: string
  purpose?: string | null
  createdAt: UnixMillis
  updatedAt: UnixMillis
}

export type AccountPoolMember = {
  poolId: string
  accountUuid: string
  priority: number
  enabled: boolean
  createdAt: UnixMillis
}

export type LocalClient = {
  id: string
  name: string
  enabled: boolean
  defaultPoolId?: string | null
  createdAt: UnixMillis
  updatedAt: UnixMillis
}

export type AuditStatus = 'pending' | 'success' | 'error' | 'interrupted'

export type AuditEvent = {
  id: string
  clientId: string
  poolId?: string | null
  accountUuid?: string | null
  tokenLabel?: string | null
  endpoint?: string | null
  model?: string | null
  upstreamRequestId?: string | null
  clientRequestId?: string | null
  status: AuditStatus
  errorType?: string | null
  inputTokens?: number | null
  outputTokens?: number | null
  quotaSnapshotId?: string | null
  createdAt: UnixMillis
}

export type QuotaSnapshot = {
  id: string
  accountUuid: string
  tokenLabel?: string | null
  status: string
  rateLimitType?: string | null
  utilization?: number | null
  resetsAt?: UnixMillis | null
  createdAt: UnixMillis
}

export type MessageSessionBinding = {
  localClientId: string
  poolId?: string | null
  inboundSessionId: string
  accountUuid: string
  upstreamSessionId: string
  createdAt: UnixMillis
  lastUsedAt: UnixMillis
}

export type SelectedCredential = {
  account: ClaudeAccount
  token: OAuthToken
  poolId?: string | null
  upstreamSessionId?: string | null
}
