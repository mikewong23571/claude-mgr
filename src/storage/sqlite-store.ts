import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type {
  AccountPool,
  AccountPoolMember,
  AppUser,
  AuditEvent,
  ClaudeAccount,
  LocalClient,
  LocalClientToken,
  MessageSessionBinding,
  OAuthToken,
  PasswordCredential,
  PendingOAuthLogin,
  QuotaSnapshot,
  UserSession,
  UnixMillis,
} from '../domain/types.js'
import { GatewayError } from '../errors.js'
import { sqliteSchema } from './schema.js'

type Row = Record<string, unknown>

function now(): UnixMillis {
  return Date.now()
}

function readString(row: Row, key: string): string {
  const value = row[key]
  if (typeof value !== 'string') {
    throw new GatewayError(
      'gateway_storage_error',
      `Expected string column ${key}`,
    )
  }
  return value
}

function readNullableString(row: Row, key: string): string | null {
  const value = row[key]
  return typeof value === 'string' ? value : null
}

function readNumber(row: Row, key: string): number {
  const value = row[key]
  if (typeof value !== 'number') {
    throw new GatewayError(
      'gateway_storage_error',
      `Expected number column ${key}`,
    )
  }
  return value
}

function readNullableNumber(row: Row, key: string): number | null {
  const value = row[key]
  return typeof value === 'number' ? value : null
}

function accountFromRow(row: Row): ClaudeAccount {
  return {
    accountUuid: readString(row, 'account_uuid'),
    organizationUuid: readString(row, 'organization_uuid'),
    email: readNullableString(row, 'email'),
    displayName: readNullableString(row, 'display_name'),
    upstreamClientIdentityId: readString(row, 'upstream_client_identity_id'),
    ownerUserId: readNullableString(row, 'owner_user_id'),
    enabled: row.enabled === undefined ? true : readNumber(row, 'enabled') === 1,
    subscriptionType: readNullableString(row, 'subscription_type'),
    rateLimitTier: readNullableString(row, 'rate_limit_tier'),
    createdAt: readNumber(row, 'created_at'),
    updatedAt: readNumber(row, 'updated_at'),
  }
}

function tokenFromRow(row: Row): OAuthToken {
  return {
    label: readString(row, 'label'),
    sourceDevice: readString(row, 'source_device'),
    accountUuid: readString(row, 'account_uuid'),
    ownerUserId: readNullableString(row, 'owner_user_id'),
    scopes: JSON.parse(readString(row, 'scopes_json')) as string[],
    accessToken: readString(row, 'access_token'),
    refreshToken: readNullableString(row, 'refresh_token'),
    expiresAt: readNullableNumber(row, 'expires_at'),
    lastUsedAt: readNullableNumber(row, 'last_used_at'),
    createdAt: readNumber(row, 'created_at'),
    updatedAt: readNumber(row, 'updated_at'),
  }
}

function poolFromRow(row: Row): AccountPool {
  return {
    id: readString(row, 'id'),
    name: readString(row, 'name'),
    purpose: readNullableString(row, 'purpose'),
    ownerUserId: readNullableString(row, 'owner_user_id'),
    createdAt: readNumber(row, 'created_at'),
    updatedAt: readNumber(row, 'updated_at'),
  }
}

function localClientFromRow(row: Row): LocalClient {
  return {
    id: readString(row, 'id'),
    name: readString(row, 'name'),
    ownerUserId: readNullableString(row, 'owner_user_id'),
    enabled: row.enabled === undefined ? true : readNumber(row, 'enabled') === 1,
    defaultPoolId: readNullableString(row, 'default_pool_id'),
    createdAt: readNumber(row, 'created_at'),
    updatedAt: readNumber(row, 'updated_at'),
  }
}

function poolMemberFromRow(row: Row): AccountPoolMember {
  return {
    poolId: readString(row, 'pool_id'),
    accountUuid: readString(row, 'account_uuid'),
    priority: readNumber(row, 'priority'),
    enabled: readNumber(row, 'enabled') === 1,
    createdAt: readNumber(row, 'created_at'),
  }
}

function messageSessionBindingFromRow(row: Row): MessageSessionBinding {
  return {
    localClientId: readString(row, 'local_client_id'),
    poolId: readNullableString(row, 'pool_id'),
    inboundSessionId: readString(row, 'inbound_session_id'),
    accountUuid: readString(row, 'account_uuid'),
    upstreamSessionId: readString(row, 'upstream_session_id'),
    createdAt: readNumber(row, 'created_at'),
    lastUsedAt: readNumber(row, 'last_used_at'),
  }
}

function auditFromRow(row: Row): AuditEvent {
  return {
    id: readString(row, 'id'),
    clientId: readString(row, 'client_id'),
    poolId: readNullableString(row, 'pool_id'),
    accountUuid: readNullableString(row, 'account_uuid'),
    tokenLabel: readNullableString(row, 'token_label'),
    endpoint: readNullableString(row, 'endpoint'),
    model: readNullableString(row, 'model'),
    upstreamRequestId: readNullableString(row, 'upstream_request_id'),
    clientRequestId: readNullableString(row, 'client_request_id'),
    status: readString(row, 'status') as AuditEvent['status'],
    errorType: readNullableString(row, 'error_type'),
    inputTokens: readNullableNumber(row, 'input_tokens'),
    outputTokens: readNullableNumber(row, 'output_tokens'),
    quotaSnapshotId: readNullableString(row, 'quota_snapshot_id'),
    createdAt: readNumber(row, 'created_at'),
  }
}

function quotaFromRow(row: Row): QuotaSnapshot {
  return {
    id: readString(row, 'id'),
    accountUuid: readString(row, 'account_uuid'),
    tokenLabel: readNullableString(row, 'token_label'),
    status: readString(row, 'status'),
    rateLimitType: readNullableString(row, 'rate_limit_type'),
    utilization: readNullableNumber(row, 'utilization'),
    resetsAt: readNullableNumber(row, 'resets_at'),
    createdAt: readNumber(row, 'created_at'),
  }
}

function appUserFromRow(row: Row): AppUser {
  return {
    id: readString(row, 'id'),
    username: readString(row, 'username'),
    displayName: readNullableString(row, 'display_name'),
    role: readString(row, 'role') as AppUser['role'],
    enabled: readNumber(row, 'enabled') === 1,
    createdAt: readNumber(row, 'created_at'),
    updatedAt: readNumber(row, 'updated_at'),
  }
}

function passwordCredentialFromRow(row: Row): PasswordCredential {
  return {
    userId: readString(row, 'user_id'),
    passwordHash: readString(row, 'password_hash'),
    updatedAt: readNumber(row, 'updated_at'),
  }
}

function userSessionFromRow(row: Row): UserSession {
  return {
    id: readString(row, 'id'),
    userId: readString(row, 'user_id'),
    sessionHash: readString(row, 'session_hash'),
    expiresAt: readNumber(row, 'expires_at'),
    createdAt: readNumber(row, 'created_at'),
    lastSeenAt: readNullableNumber(row, 'last_seen_at'),
  }
}

function pendingOAuthLoginFromRow(row: Row): PendingOAuthLogin {
  return {
    state: readString(row, 'state'),
    codeVerifier: readString(row, 'code_verifier'),
    redirectUri: readString(row, 'redirect_uri'),
    label: readString(row, 'label'),
    sourceDevice: readString(row, 'source_device'),
    poolId: readNullableString(row, 'pool_id'),
    initiatedByUserId: readString(row, 'initiated_by_user_id'),
    expiresAt: readNumber(row, 'expires_at'),
    consumedAt: readNullableNumber(row, 'consumed_at'),
    createdAt: readNumber(row, 'created_at'),
  }
}

function localClientTokenFromRow(row: Row): LocalClientToken {
  return {
    id: readString(row, 'id'),
    clientId: readString(row, 'client_id'),
    name: readString(row, 'name'),
    tokenHash: readString(row, 'token_hash'),
    createdByUserId: readNullableString(row, 'created_by_user_id'),
    createdAt: readNumber(row, 'created_at'),
    lastUsedAt: readNullableNumber(row, 'last_used_at'),
    revokedAt: readNullableNumber(row, 'revoked_at'),
  }
}

function poolScope(poolId?: string | null): string {
  return poolId ?? ''
}

export class SqliteStore {
  readonly db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.db = db
  }

  static open(path: string): SqliteStore {
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true })
    }
    return new SqliteStore(new DatabaseSync(path))
  }

  initialize(): void {
    this.db.exec('PRAGMA foreign_keys = ON')
    for (const statement of sqliteSchema) {
      this.db.exec(statement)
    }
    this.ensureColumn({
      table: 'claude_accounts',
      column: 'owner_user_id',
      definition: 'TEXT',
    })
    this.ensureColumn({
      table: 'claude_accounts',
      column: 'enabled',
      definition: 'INTEGER NOT NULL DEFAULT 1',
    })
    this.ensureColumn({
      table: 'account_pools',
      column: 'owner_user_id',
      definition: 'TEXT',
    })
    this.ensureColumn({
      table: 'local_clients',
      column: 'owner_user_id',
      definition: 'TEXT',
    })
    this.ensureColumn({
      table: 'local_clients',
      column: 'enabled',
      definition: 'INTEGER NOT NULL DEFAULT 1',
    })
    this.ensureColumn({
      table: 'oauth_tokens',
      column: 'owner_user_id',
      definition: 'TEXT',
    })
  }

  close(): void {
    this.db.close()
  }

  private ensureColumn(input: {
    table: string
    column: string
    definition: string
  }): void {
    const rows = this.db.prepare(`PRAGMA table_info(${input.table})`).all() as Row[]
    const hasColumn = rows.some(row => row.name === input.column)
    if (!hasColumn) {
      this.db.exec(
        `ALTER TABLE ${input.table} ADD COLUMN ${input.column} ${input.definition}`,
      )
    }
  }

  createAppUser(input: {
    id: string
    username: string
    displayName?: string | null
    role: AppUser['role']
    enabled?: boolean
  }): AppUser {
    const timestamp = now()
    this.db
      .prepare(
        `INSERT INTO app_users (
          id, username, display_name, role, enabled, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.username,
        input.displayName ?? null,
        input.role,
        input.enabled === false ? 0 : 1,
        timestamp,
        timestamp,
      )
    return this.getAppUser(input.id)
  }

  updateAppUser(input: {
    id: string
    username?: string
    displayName?: string | null
    role?: AppUser['role']
    enabled?: boolean
  }): AppUser {
    const existing = this.getAppUser(input.id)
    const timestamp = now()
    this.db
      .prepare(
        `UPDATE app_users
         SET username = ?, display_name = ?, role = ?, enabled = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        input.username ?? existing.username,
        input.displayName === undefined
          ? (existing.displayName ?? null)
          : input.displayName,
        input.role ?? existing.role,
        input.enabled === undefined
          ? existing.enabled
            ? 1
            : 0
          : input.enabled
            ? 1
            : 0,
        timestamp,
        input.id,
      )
    return this.getAppUser(input.id)
  }

  getAppUser(id: string): AppUser {
    const row = this.db
      .prepare('SELECT * FROM app_users WHERE id = ?')
      .get(id) as Row | undefined
    if (!row) {
      throw new GatewayError(
        'gateway_auth_error',
        `App user not found: ${id}`,
        404,
      )
    }
    return appUserFromRow(row)
  }

  findAppUser(id: string): AppUser | null {
    const row = this.db
      .prepare('SELECT * FROM app_users WHERE id = ?')
      .get(id) as Row | undefined
    return row ? appUserFromRow(row) : null
  }

  findAppUserByUsername(username: string): AppUser | null {
    const row = this.db
      .prepare('SELECT * FROM app_users WHERE username = ?')
      .get(username) as Row | undefined
    return row ? appUserFromRow(row) : null
  }

  listAppUsers(): AppUser[] {
    return this.db
      .prepare('SELECT * FROM app_users ORDER BY created_at ASC')
      .all()
      .map(row => appUserFromRow(row as Row))
  }

  countEnabledOwners(): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM app_users
         WHERE role = 'owner' AND enabled = 1`,
      )
      .get() as Row
    return readNumber(row, 'count')
  }

  upsertPasswordCredential(input: {
    userId: string
    passwordHash: string
  }): PasswordCredential {
    this.getAppUser(input.userId)
    const timestamp = now()
    this.db
      .prepare(
        `INSERT INTO password_credentials (user_id, password_hash, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
          password_hash = excluded.password_hash,
          updated_at = excluded.updated_at`,
      )
      .run(input.userId, input.passwordHash, timestamp)
    return this.getPasswordCredential(input.userId)
  }

  getPasswordCredential(userId: string): PasswordCredential {
    const row = this.db
      .prepare('SELECT * FROM password_credentials WHERE user_id = ?')
      .get(userId) as Row | undefined
    if (!row) {
      throw new GatewayError(
        'gateway_auth_error',
        `Password credential not found for user: ${userId}`,
        404,
      )
    }
    return passwordCredentialFromRow(row)
  }

  findPasswordCredential(userId: string): PasswordCredential | null {
    const row = this.db
      .prepare('SELECT * FROM password_credentials WHERE user_id = ?')
      .get(userId) as Row | undefined
    return row ? passwordCredentialFromRow(row) : null
  }

  createUserSession(input: {
    id: string
    userId: string
    sessionHash: string
    expiresAt: number
  }): UserSession {
    this.getAppUser(input.userId)
    const timestamp = now()
    this.db
      .prepare(
        `INSERT INTO user_sessions (
          id, user_id, session_hash, expires_at, created_at, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.userId,
        input.sessionHash,
        input.expiresAt,
        timestamp,
        timestamp,
      )
    return this.getUserSession(input.id)
  }

  getUserSession(id: string): UserSession {
    const row = this.db
      .prepare('SELECT * FROM user_sessions WHERE id = ?')
      .get(id) as Row | undefined
    if (!row) {
      throw new GatewayError(
        'gateway_auth_error',
        `Session not found: ${id}`,
        401,
      )
    }
    return userSessionFromRow(row)
  }

  findUserSessionByHash(sessionHash: string): UserSession | null {
    const row = this.db
      .prepare('SELECT * FROM user_sessions WHERE session_hash = ?')
      .get(sessionHash) as Row | undefined
    return row ? userSessionFromRow(row) : null
  }

  touchUserSession(id: string, seenAt = now()): void {
    this.db
      .prepare('UPDATE user_sessions SET last_seen_at = ? WHERE id = ?')
      .run(seenAt, id)
  }

  deleteUserSession(id: string): void {
    this.db.prepare('DELETE FROM user_sessions WHERE id = ?').run(id)
  }

  deleteExpiredUserSessions(nowMs = now()): void {
    this.db
      .prepare('DELETE FROM user_sessions WHERE expires_at <= ?')
      .run(nowMs)
  }

  createPendingOAuthLogin(input: {
    state: string
    codeVerifier: string
    redirectUri: string
    label: string
    sourceDevice: string
    poolId?: string | null
    initiatedByUserId: string
    expiresAt: number
  }): PendingOAuthLogin {
    this.getAppUser(input.initiatedByUserId)
    if (input.poolId) this.getPool(input.poolId)
    const timestamp = now()
    this.db
      .prepare(
        `INSERT INTO pending_oauth_logins (
          state, code_verifier, redirect_uri, label, source_device, pool_id,
          initiated_by_user_id, expires_at, consumed_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
      )
      .run(
        input.state,
        input.codeVerifier,
        input.redirectUri,
        input.label,
        input.sourceDevice,
        input.poolId ?? null,
        input.initiatedByUserId,
        input.expiresAt,
        timestamp,
      )
    return this.getPendingOAuthLogin(input.state)
  }

  getPendingOAuthLogin(state: string): PendingOAuthLogin {
    const row = this.db
      .prepare('SELECT * FROM pending_oauth_logins WHERE state = ?')
      .get(state) as Row | undefined
    if (!row) {
      throw new GatewayError(
        'gateway_auth_error',
        'OAuth state was not found or already consumed',
        401,
      )
    }
    return pendingOAuthLoginFromRow(row)
  }

  consumePendingOAuthLogin(state: string, consumedAt = now()): PendingOAuthLogin {
    const pending = this.getPendingOAuthLogin(state)
    this.db
      .prepare(
        `UPDATE pending_oauth_logins
         SET consumed_at = ?
         WHERE state = ? AND consumed_at IS NULL`,
      )
      .run(consumedAt, state)
    return { ...pending, consumedAt }
  }

  createLocalClientToken(input: {
    id: string
    clientId: string
    name: string
    tokenHash: string
    createdByUserId?: string | null
  }): LocalClientToken {
    this.getLocalClient(input.clientId)
    if (input.createdByUserId) this.getAppUser(input.createdByUserId)
    const timestamp = now()
    this.db
      .prepare(
        `INSERT INTO local_client_tokens (
          id, client_id, name, token_hash, created_by_user_id, created_at,
          last_used_at, revoked_at
        ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)`,
      )
      .run(
        input.id,
        input.clientId,
        input.name,
        input.tokenHash,
        input.createdByUserId ?? null,
        timestamp,
      )
    return this.getLocalClientToken(input.id)
  }

  getLocalClientToken(id: string): LocalClientToken {
    const row = this.db
      .prepare('SELECT * FROM local_client_tokens WHERE id = ?')
      .get(id) as Row | undefined
    if (!row) {
      throw new GatewayError(
        'gateway_auth_error',
        `Local client token not found: ${id}`,
        404,
      )
    }
    return localClientTokenFromRow(row)
  }

  findLocalClientTokenByHash(tokenHash: string): LocalClientToken | null {
    const row = this.db
      .prepare('SELECT * FROM local_client_tokens WHERE token_hash = ?')
      .get(tokenHash) as Row | undefined
    return row ? localClientTokenFromRow(row) : null
  }

  listLocalClientTokens(clientId: string): LocalClientToken[] {
    this.getLocalClient(clientId)
    return this.db
      .prepare(
        `SELECT *
         FROM local_client_tokens
         WHERE client_id = ?
         ORDER BY created_at ASC`,
      )
      .all(clientId)
      .map(row => localClientTokenFromRow(row as Row))
  }

  markLocalClientTokenUsed(id: string, usedAt = now()): void {
    this.db
      .prepare('UPDATE local_client_tokens SET last_used_at = ? WHERE id = ?')
      .run(usedAt, id)
  }

  revokeLocalClientToken(id: string, revokedAt = now()): LocalClientToken {
    this.getLocalClientToken(id)
    this.db
      .prepare('UPDATE local_client_tokens SET revoked_at = ? WHERE id = ?')
      .run(revokedAt, id)
    return this.getLocalClientToken(id)
  }

  upsertAccount(input: {
    accountUuid: string
    organizationUuid: string
    email?: string | null
    displayName?: string | null
    upstreamClientIdentityId: string
    ownerUserId?: string | null
    enabled?: boolean
    subscriptionType?: string | null
    rateLimitTier?: string | null
  }): ClaudeAccount {
    const existing = this.findAccount(input.accountUuid)
    const timestamp = now()
    this.db
      .prepare(
        `INSERT INTO claude_accounts (
          account_uuid, organization_uuid, email, display_name,
          upstream_client_identity_id, owner_user_id, enabled,
          subscription_type, rate_limit_tier,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(account_uuid) DO UPDATE SET
          organization_uuid = excluded.organization_uuid,
          email = excluded.email,
          display_name = excluded.display_name,
          upstream_client_identity_id = excluded.upstream_client_identity_id,
          owner_user_id = COALESCE(excluded.owner_user_id, claude_accounts.owner_user_id),
          enabled = excluded.enabled,
          subscription_type = excluded.subscription_type,
          rate_limit_tier = excluded.rate_limit_tier,
          updated_at = excluded.updated_at`,
      )
      .run(
        input.accountUuid,
        input.organizationUuid,
        input.email ?? null,
        input.displayName ?? null,
        input.upstreamClientIdentityId,
        input.ownerUserId ?? null,
        (input.enabled ?? existing?.enabled ?? true) ? 1 : 0,
        input.subscriptionType ?? null,
        input.rateLimitTier ?? null,
        timestamp,
        timestamp,
      )
    return this.getAccount(input.accountUuid)
  }

  getAccount(accountUuid: string): ClaudeAccount {
    const row = this.db
      .prepare('SELECT * FROM claude_accounts WHERE account_uuid = ?')
      .get(accountUuid) as Row | undefined
    if (!row) {
      throw new GatewayError(
        'gateway_no_eligible_account',
        `Claude account not found: ${accountUuid}`,
        404,
      )
    }
    return accountFromRow(row)
  }

  findAccount(accountUuid: string): ClaudeAccount | null {
    const row = this.db
      .prepare('SELECT * FROM claude_accounts WHERE account_uuid = ?')
      .get(accountUuid) as Row | undefined
    return row ? accountFromRow(row) : null
  }

  listAccounts(): ClaudeAccount[] {
    return this.db
      .prepare('SELECT * FROM claude_accounts ORDER BY created_at ASC')
      .all()
      .map(row => accountFromRow(row as Row))
  }

  updateAccount(input: {
    accountUuid: string
    enabled?: boolean
  }): ClaudeAccount {
    const existing = this.getAccount(input.accountUuid)
    const timestamp = now()
    this.db
      .prepare(
        `UPDATE claude_accounts
         SET enabled = ?, updated_at = ?
         WHERE account_uuid = ?`,
      )
      .run(
        input.enabled === undefined
          ? existing.enabled
            ? 1
            : 0
          : input.enabled
            ? 1
            : 0,
        timestamp,
        input.accountUuid,
      )
    return this.getAccount(input.accountUuid)
  }

  upsertOAuthToken(input: {
    label: string
    sourceDevice: string
    accountUuid: string
    ownerUserId?: string | null
    scopes: string[]
    accessToken: string
    refreshToken?: string | null
    expiresAt?: number | null
  }): OAuthToken {
    this.getAccount(input.accountUuid)
    const timestamp = now()
    this.db
      .prepare(
        `INSERT INTO oauth_tokens (
          label, source_device, account_uuid, owner_user_id, scopes_json, access_token,
          refresh_token, expires_at, last_used_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
        ON CONFLICT(label) DO UPDATE SET
          source_device = excluded.source_device,
          account_uuid = excluded.account_uuid,
          owner_user_id = COALESCE(excluded.owner_user_id, oauth_tokens.owner_user_id),
          scopes_json = excluded.scopes_json,
          access_token = excluded.access_token,
          refresh_token = excluded.refresh_token,
          expires_at = excluded.expires_at,
          updated_at = excluded.updated_at`,
      )
      .run(
        input.label,
        input.sourceDevice,
        input.accountUuid,
        input.ownerUserId ?? null,
        JSON.stringify(input.scopes),
        input.accessToken,
        input.refreshToken ?? null,
        input.expiresAt ?? null,
        timestamp,
        timestamp,
      )
    return this.getOAuthToken(input.label)
  }

  getOAuthToken(label: string): OAuthToken {
    const row = this.db
      .prepare('SELECT * FROM oauth_tokens WHERE label = ?')
      .get(label) as Row | undefined
    if (!row) {
      throw new GatewayError(
        'gateway_no_eligible_token',
        `OAuth token not found: ${label}`,
        404,
      )
    }
    return tokenFromRow(row)
  }

  listOAuthTokens(): OAuthToken[] {
    return this.db
      .prepare('SELECT * FROM oauth_tokens ORDER BY created_at ASC')
      .all()
      .map(row => tokenFromRow(row as Row))
  }

  markTokenUsed(label: string, usedAt = now()): void {
    this.db
      .prepare('UPDATE oauth_tokens SET last_used_at = ?, updated_at = ? WHERE label = ?')
      .run(usedAt, usedAt, label)
  }

  deleteOAuthToken(label: string): OAuthToken {
    const token = this.getOAuthToken(label)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db
        .prepare('UPDATE audit_events SET token_label = NULL WHERE token_label = ?')
        .run(label)
      this.db
        .prepare('UPDATE quota_snapshots SET token_label = NULL WHERE token_label = ?')
        .run(label)
      this.db.prepare('DELETE FROM oauth_tokens WHERE label = ?').run(label)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return token
  }

  findMessageSessionBinding(input: {
    localClientId: string
    poolId?: string | null
    inboundSessionId: string
  }): MessageSessionBinding | null {
    const row = this.db
      .prepare(
        `SELECT *
         FROM message_session_bindings
         WHERE local_client_id = ?
           AND pool_scope = ?
           AND inbound_session_id = ?`,
      )
      .get(input.localClientId, poolScope(input.poolId), input.inboundSessionId) as
      | Row
      | undefined
    return row ? messageSessionBindingFromRow(row) : null
  }

  upsertMessageSessionBinding(input: {
    localClientId: string
    poolId?: string | null
    inboundSessionId: string
    accountUuid: string
    upstreamSessionId: string
    nowMs?: number
  }): MessageSessionBinding {
    this.getLocalClient(input.localClientId)
    if (input.poolId) this.getPool(input.poolId)
    this.getAccount(input.accountUuid)
    const timestamp = input.nowMs ?? now()
    this.db
      .prepare(
        `INSERT INTO message_session_bindings (
          local_client_id, pool_scope, pool_id, inbound_session_id,
          account_uuid, upstream_session_id, created_at, last_used_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(local_client_id, pool_scope, inbound_session_id) DO UPDATE SET
          account_uuid = excluded.account_uuid,
          upstream_session_id = excluded.upstream_session_id,
          last_used_at = excluded.last_used_at`,
      )
      .run(
        input.localClientId,
        poolScope(input.poolId),
        input.poolId ?? null,
        input.inboundSessionId,
        input.accountUuid,
        input.upstreamSessionId,
        timestamp,
        timestamp,
      )
    return this.getMessageSessionBinding({
      localClientId: input.localClientId,
      poolId: input.poolId,
      inboundSessionId: input.inboundSessionId,
    })
  }

  getMessageSessionBinding(input: {
    localClientId: string
    poolId?: string | null
    inboundSessionId: string
  }): MessageSessionBinding {
    const binding = this.findMessageSessionBinding(input)
    if (!binding) {
      throw new GatewayError(
        'gateway_no_eligible_account',
        `Message session binding not found: ${input.inboundSessionId}`,
        404,
      )
    }
    return binding
  }

  touchMessageSessionBinding(input: {
    localClientId: string
    poolId?: string | null
    inboundSessionId: string
    usedAt?: number
  }): void {
    const usedAt = input.usedAt ?? now()
    this.db
      .prepare(
        `UPDATE message_session_bindings
         SET last_used_at = ?
         WHERE local_client_id = ?
           AND pool_scope = ?
           AND inbound_session_id = ?`,
      )
      .run(usedAt, input.localClientId, poolScope(input.poolId), input.inboundSessionId)
  }

  listMessageSessionBindings(): MessageSessionBinding[] {
    return this.db
      .prepare(
        `SELECT *
         FROM message_session_bindings
         ORDER BY created_at ASC`,
      )
      .all()
      .map(row => messageSessionBindingFromRow(row as Row))
  }

  createPool(input: {
    id: string
    name: string
    purpose?: string | null
    ownerUserId?: string | null
  }): AccountPool {
    if (input.ownerUserId) this.getAppUser(input.ownerUserId)
    const timestamp = now()
    this.db
      .prepare(
        `INSERT INTO account_pools (
          id, name, purpose, owner_user_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.name,
        input.purpose ?? null,
        input.ownerUserId ?? null,
        timestamp,
        timestamp,
      )
    return this.getPool(input.id)
  }

  updatePool(input: {
    id: string
    name?: string
    purpose?: string | null
    ownerUserId?: string | null
  }): AccountPool {
    const existing = this.getPool(input.id)
    if (input.ownerUserId) this.getAppUser(input.ownerUserId)
    const timestamp = now()
    this.db
      .prepare(
        `UPDATE account_pools
         SET name = ?, purpose = ?, owner_user_id = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        input.name ?? existing.name,
        input.purpose === undefined ? (existing.purpose ?? null) : input.purpose,
        input.ownerUserId === undefined
          ? (existing.ownerUserId ?? null)
          : input.ownerUserId,
        timestamp,
        input.id,
      )
    return this.getPool(input.id)
  }

  deletePool(id: string): void {
    this.getPool(id)
    this.db
      .prepare('UPDATE local_clients SET default_pool_id = NULL, updated_at = ? WHERE default_pool_id = ?')
      .run(now(), id)
    this.db
      .prepare('DELETE FROM account_pool_members WHERE pool_id = ?')
      .run(id)
    this.db.prepare('DELETE FROM account_pools WHERE id = ?').run(id)
  }

  getPool(id: string): AccountPool {
    const row = this.db
      .prepare('SELECT * FROM account_pools WHERE id = ?')
      .get(id) as Row | undefined
    if (!row) {
      throw new GatewayError(
        'gateway_no_eligible_account',
        `Account pool not found: ${id}`,
        404,
      )
    }
    return poolFromRow(row)
  }

  listPools(): AccountPool[] {
    return this.db
      .prepare('SELECT * FROM account_pools ORDER BY created_at ASC')
      .all()
      .map(row => poolFromRow(row as Row))
  }

  addAccountToPool(input: {
    poolId: string
    accountUuid: string
    priority?: number
    enabled?: boolean
  }): AccountPoolMember {
    this.getPool(input.poolId)
    this.getAccount(input.accountUuid)
    const timestamp = now()
    this.db
      .prepare(
        `INSERT INTO account_pool_members (
          pool_id, account_uuid, priority, enabled, created_at
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(pool_id, account_uuid) DO UPDATE SET
          priority = excluded.priority,
          enabled = excluded.enabled`,
      )
      .run(
        input.poolId,
        input.accountUuid,
        input.priority ?? 100,
        input.enabled === false ? 0 : 1,
        timestamp,
      )
    const row = this.db
      .prepare(
        `SELECT * FROM account_pool_members
         WHERE pool_id = ? AND account_uuid = ?`,
      )
      .get(input.poolId, input.accountUuid) as Row
    return poolMemberFromRow(row)
  }

  getPoolMember(poolId: string, accountUuid: string): AccountPoolMember {
    const row = this.db
      .prepare(
        `SELECT * FROM account_pool_members
         WHERE pool_id = ? AND account_uuid = ?`,
      )
      .get(poolId, accountUuid) as Row | undefined
    if (!row) {
      throw new GatewayError(
        'gateway_no_eligible_account',
        `Account ${accountUuid} is not a member of pool ${poolId}`,
        404,
      )
    }
    return poolMemberFromRow(row)
  }

  listPoolMembers(poolId: string): AccountPoolMember[] {
    this.getPool(poolId)
    return this.db
      .prepare(
        `SELECT * FROM account_pool_members
         WHERE pool_id = ?
         ORDER BY priority ASC, created_at ASC`,
      )
      .all(poolId)
      .map(row => poolMemberFromRow(row as Row))
  }

  updatePoolMember(input: {
    poolId: string
    accountUuid: string
    priority?: number
    enabled?: boolean
  }): AccountPoolMember {
    const existing = this.getPoolMember(input.poolId, input.accountUuid)
    this.db
      .prepare(
        `UPDATE account_pool_members
         SET priority = ?, enabled = ?
         WHERE pool_id = ? AND account_uuid = ?`,
      )
      .run(
        input.priority ?? existing.priority,
        input.enabled === undefined
          ? existing.enabled
            ? 1
            : 0
          : input.enabled
            ? 1
            : 0,
        input.poolId,
        input.accountUuid,
      )
    return this.getPoolMember(input.poolId, input.accountUuid)
  }

  removePoolMember(poolId: string, accountUuid: string): void {
    this.getPoolMember(poolId, accountUuid)
    this.db
      .prepare(
        `DELETE FROM account_pool_members
         WHERE pool_id = ? AND account_uuid = ?`,
      )
      .run(poolId, accountUuid)
  }

  createLocalClient(input: {
    id: string
    name: string
    ownerUserId?: string | null
    enabled?: boolean
    defaultPoolId?: string | null
  }): LocalClient {
    if (input.defaultPoolId) {
      this.getPool(input.defaultPoolId)
    }
    if (input.ownerUserId) this.getAppUser(input.ownerUserId)
    const existing = this.findLocalClient(input.id)
    const timestamp = now()
    this.db
      .prepare(
        `INSERT INTO local_clients (
          id, name, owner_user_id, enabled, default_pool_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          owner_user_id = COALESCE(excluded.owner_user_id, local_clients.owner_user_id),
          enabled = excluded.enabled,
          default_pool_id = excluded.default_pool_id,
          updated_at = excluded.updated_at`,
      )
      .run(
        input.id,
        input.name,
        input.ownerUserId ?? null,
        (input.enabled ?? existing?.enabled ?? true) ? 1 : 0,
        input.defaultPoolId ?? null,
        timestamp,
        timestamp,
      )
    return this.getLocalClient(input.id)
  }

  findLocalClient(id: string): LocalClient | null {
    const row = this.db
      .prepare('SELECT * FROM local_clients WHERE id = ?')
      .get(id) as Row | undefined
    return row ? localClientFromRow(row) : null
  }

  getLocalClient(id: string): LocalClient {
    const row = this.db
      .prepare('SELECT * FROM local_clients WHERE id = ?')
      .get(id) as Row | undefined
    if (!row) {
      throw new GatewayError(
        'gateway_auth_error',
        `Local client not found: ${id}`,
        401,
      )
    }
    return localClientFromRow(row)
  }

  listLocalClients(): LocalClient[] {
    return this.db
      .prepare('SELECT * FROM local_clients ORDER BY created_at ASC')
      .all()
      .map(row => localClientFromRow(row as Row))
  }

  updateLocalClient(input: {
    id: string
    name?: string
    ownerUserId?: string | null
    enabled?: boolean
    defaultPoolId?: string | null
  }): LocalClient {
    const existing = this.getLocalClient(input.id)
    if (typeof input.defaultPoolId === 'string') {
      this.getPool(input.defaultPoolId)
    }
    if (input.ownerUserId) this.getAppUser(input.ownerUserId)
    const timestamp = now()
    this.db
      .prepare(
        `UPDATE local_clients
         SET name = ?, owner_user_id = ?, enabled = ?, default_pool_id = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        input.name ?? existing.name,
        input.ownerUserId === undefined
          ? (existing.ownerUserId ?? null)
          : input.ownerUserId,
        input.enabled === undefined
          ? existing.enabled
            ? 1
            : 0
          : input.enabled
            ? 1
            : 0,
        input.defaultPoolId === undefined
          ? (existing.defaultPoolId ?? null)
          : (input.defaultPoolId ?? null),
        timestamp,
        input.id,
      )
    return this.getLocalClient(input.id)
  }

  deleteLocalClient(id: string): void {
    this.getLocalClient(id)
    this.db.prepare('DELETE FROM local_client_tokens WHERE client_id = ?').run(id)
    this.db.prepare('DELETE FROM local_clients WHERE id = ?').run(id)
  }

  listEligibleAccountRows(input: {
    poolId?: string | null
  }): Array<{ account: ClaudeAccount; poolId?: string | null }> {
    const rows = (
      input.poolId
        ? (this.getPool(input.poolId),
          this.db
            .prepare(
              `SELECT a.*
               FROM account_pool_members m
               JOIN claude_accounts a ON a.account_uuid = m.account_uuid
               WHERE m.pool_id = ?
                 AND m.enabled = 1
                 AND a.enabled = 1
               ORDER BY m.priority ASC, m.created_at ASC`,
            )
            .all(input.poolId))
        : this.db
            .prepare(
              `SELECT *
               FROM claude_accounts
               WHERE enabled = 1
               ORDER BY created_at ASC`,
            )
            .all()
    ) as Row[]

    return rows.map(row => ({
      account: accountFromRow(row),
      poolId: input.poolId ?? null,
    }))
  }

  listEligibleTokenRows(input: {
    poolId?: string | null
    requiredScope?: string | null
    nowMs?: number
  }): Array<{ account: ClaudeAccount; token: OAuthToken; poolId?: string | null }> {
    const timestamp = input.nowMs ?? now()
    const scopeNeedle = input.requiredScope ? `"${input.requiredScope}"` : null
    const rows = (
      input.poolId
        ? this.db
            .prepare(
              `SELECT
                a.account_uuid AS a_account_uuid,
                a.organization_uuid AS a_organization_uuid,
                a.email AS a_email,
                a.display_name AS a_display_name,
                a.upstream_client_identity_id AS a_upstream_client_identity_id,
                a.enabled AS a_enabled,
                a.subscription_type AS a_subscription_type,
                a.rate_limit_tier AS a_rate_limit_tier,
                a.created_at AS a_created_at,
                a.updated_at AS a_updated_at,
                t.*
              FROM account_pool_members m
              JOIN claude_accounts a ON a.account_uuid = m.account_uuid
               JOIN oauth_tokens t ON t.account_uuid = a.account_uuid
               WHERE m.pool_id = ?
                 AND m.enabled = 1
                 AND a.enabled = 1
                AND (? IS NULL OR t.scopes_json LIKE ?)
                AND (t.expires_at IS NULL OR t.expires_at > ?)
              ORDER BY m.priority ASC, COALESCE(t.last_used_at, 0) ASC, t.created_at ASC`,
            )
            .all(
              input.poolId,
              scopeNeedle,
              scopeNeedle ? `%${scopeNeedle}%` : null,
              timestamp,
            )
        : this.db
            .prepare(
              `SELECT
                a.account_uuid AS a_account_uuid,
                a.organization_uuid AS a_organization_uuid,
                a.email AS a_email,
                a.display_name AS a_display_name,
                a.upstream_client_identity_id AS a_upstream_client_identity_id,
                a.enabled AS a_enabled,
                a.subscription_type AS a_subscription_type,
                a.rate_limit_tier AS a_rate_limit_tier,
                a.created_at AS a_created_at,
                a.updated_at AS a_updated_at,
                t.*
              FROM claude_accounts a
              JOIN oauth_tokens t ON t.account_uuid = a.account_uuid
              WHERE a.enabled = 1
                AND (? IS NULL OR t.scopes_json LIKE ?)
                AND (t.expires_at IS NULL OR t.expires_at > ?)
              ORDER BY COALESCE(t.last_used_at, 0) ASC, t.created_at ASC`,
            )
            .all(scopeNeedle, scopeNeedle ? `%${scopeNeedle}%` : null, timestamp)
    ) as Row[]

    return rows.map(row => ({
      account: accountFromRow({
        account_uuid: row.a_account_uuid,
                organization_uuid: row.a_organization_uuid,
                email: row.a_email,
                display_name: row.a_display_name,
                upstream_client_identity_id: row.a_upstream_client_identity_id,
                enabled: row.a_enabled,
                subscription_type: row.a_subscription_type,
                rate_limit_tier: row.a_rate_limit_tier,
                created_at: row.a_created_at,
        updated_at: row.a_updated_at,
      }),
      token: tokenFromRow(row),
      poolId: input.poolId ?? null,
    }))
  }

  listRefreshableTokenRows(input: {
    poolId?: string | null
    requiredScope: string
    nowMs?: number
  }): Array<{ account: ClaudeAccount; token: OAuthToken; poolId?: string | null }> {
    const timestamp = input.nowMs ?? now()
    const scopeNeedle = `"${input.requiredScope}"`
    const rows = (
      input.poolId
        ? this.db
            .prepare(
              `SELECT
                a.account_uuid AS a_account_uuid,
                a.organization_uuid AS a_organization_uuid,
                a.email AS a_email,
                a.display_name AS a_display_name,
                a.upstream_client_identity_id AS a_upstream_client_identity_id,
                a.enabled AS a_enabled,
                a.subscription_type AS a_subscription_type,
                a.rate_limit_tier AS a_rate_limit_tier,
                a.created_at AS a_created_at,
                a.updated_at AS a_updated_at,
                t.*
              FROM account_pool_members m
              JOIN claude_accounts a ON a.account_uuid = m.account_uuid
              JOIN oauth_tokens t ON t.account_uuid = a.account_uuid
              WHERE m.pool_id = ?
                AND m.enabled = 1
                AND a.enabled = 1
                AND t.refresh_token IS NOT NULL
                AND t.scopes_json LIKE ?
                AND t.expires_at IS NOT NULL
                AND t.expires_at <= ?
              ORDER BY m.priority ASC, COALESCE(t.last_used_at, 0) ASC, t.created_at ASC`,
            )
            .all(input.poolId, `%${scopeNeedle}%`, timestamp)
        : this.db
            .prepare(
              `SELECT
                a.account_uuid AS a_account_uuid,
                a.organization_uuid AS a_organization_uuid,
                a.email AS a_email,
                a.display_name AS a_display_name,
                a.upstream_client_identity_id AS a_upstream_client_identity_id,
                a.enabled AS a_enabled,
                a.subscription_type AS a_subscription_type,
                a.rate_limit_tier AS a_rate_limit_tier,
                a.created_at AS a_created_at,
                a.updated_at AS a_updated_at,
                t.*
              FROM claude_accounts a
              JOIN oauth_tokens t ON t.account_uuid = a.account_uuid
              WHERE a.enabled = 1
                AND t.refresh_token IS NOT NULL
                AND t.scopes_json LIKE ?
                AND t.expires_at IS NOT NULL
                AND t.expires_at <= ?
              ORDER BY COALESCE(t.last_used_at, 0) ASC, t.created_at ASC`,
            )
            .all(`%${scopeNeedle}%`, timestamp)
    ) as Row[]

    return rows.map(row => ({
      account: accountFromRow({
        account_uuid: row.a_account_uuid,
                organization_uuid: row.a_organization_uuid,
                email: row.a_email,
                display_name: row.a_display_name,
                upstream_client_identity_id: row.a_upstream_client_identity_id,
                enabled: row.a_enabled,
                subscription_type: row.a_subscription_type,
                rate_limit_tier: row.a_rate_limit_tier,
        created_at: row.a_created_at,
        updated_at: row.a_updated_at,
      }),
      token: tokenFromRow(row),
      poolId: input.poolId ?? null,
    }))
  }

  insertAuditEvent(input: Omit<AuditEvent, 'createdAt'> & {
    createdAt?: number
  }): AuditEvent {
    const createdAt = input.createdAt ?? now()
    this.db
      .prepare(
        `INSERT INTO audit_events (
          id, client_id, pool_id, account_uuid, token_label, endpoint, model,
          upstream_request_id, client_request_id, status, error_type,
          input_tokens, output_tokens, quota_snapshot_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.clientId,
        input.poolId ?? null,
        input.accountUuid ?? null,
        input.tokenLabel ?? null,
        input.endpoint ?? null,
        input.model ?? null,
        input.upstreamRequestId ?? null,
        input.clientRequestId ?? null,
        input.status,
        input.errorType ?? null,
        input.inputTokens ?? null,
        input.outputTokens ?? null,
        input.quotaSnapshotId ?? null,
        createdAt,
      )
    return this.getAuditEvent(input.id)
  }

  getAuditEvent(id: string): AuditEvent {
    const row = this.db
      .prepare('SELECT * FROM audit_events WHERE id = ?')
      .get(id) as Row | undefined
    if (!row) {
      throw new GatewayError(
        'gateway_storage_error',
        `Audit event not found: ${id}`,
        404,
      )
    }
    return auditFromRow(row)
  }

  updateAuditEvent(input: Partial<Omit<AuditEvent, 'id' | 'clientId' | 'createdAt'>> & {
    id: string
  }): AuditEvent {
    const existing = this.getAuditEvent(input.id)
    this.db
      .prepare(
        `UPDATE audit_events SET
          pool_id = ?,
          account_uuid = ?,
          token_label = ?,
          endpoint = ?,
          model = ?,
          upstream_request_id = ?,
          client_request_id = ?,
          status = ?,
          error_type = ?,
          input_tokens = ?,
          output_tokens = ?,
          quota_snapshot_id = ?
        WHERE id = ?`,
      )
      .run(
        (input.poolId === undefined ? existing.poolId : input.poolId) ?? null,
        (input.accountUuid === undefined
          ? existing.accountUuid
          : input.accountUuid) ?? null,
        (input.tokenLabel === undefined ? existing.tokenLabel : input.tokenLabel) ??
          null,
        (input.endpoint === undefined ? existing.endpoint : input.endpoint) ?? null,
        (input.model === undefined ? existing.model : input.model) ?? null,
        input.upstreamRequestId === undefined
          ? (existing.upstreamRequestId ?? null)
          : (input.upstreamRequestId ?? null),
        input.clientRequestId === undefined
          ? (existing.clientRequestId ?? null)
          : (input.clientRequestId ?? null),
        input.status === undefined ? existing.status : input.status,
        (input.errorType === undefined ? existing.errorType : input.errorType) ??
          null,
        (input.inputTokens === undefined ? existing.inputTokens : input.inputTokens) ??
          null,
        input.outputTokens === undefined
          ? (existing.outputTokens ?? null)
          : (input.outputTokens ?? null),
        input.quotaSnapshotId === undefined
          ? (existing.quotaSnapshotId ?? null)
          : (input.quotaSnapshotId ?? null),
        input.id,
      )
    return this.getAuditEvent(input.id)
  }

  updateAuditEventStatus(input: {
    id: string
    status: AuditEvent['status']
    errorType?: string | null
  }): void {
    this.db
      .prepare(
        `UPDATE audit_events SET
          status = ?,
          error_type = ?
        WHERE id = ?`,
      )
      .run(input.status, input.errorType ?? null, input.id)
  }

  listAuditEvents(): AuditEvent[] {
    return this.db
      .prepare('SELECT * FROM audit_events ORDER BY created_at ASC')
      .all()
      .map(row => auditFromRow(row as Row))
  }

  insertQuotaSnapshot(input: Omit<QuotaSnapshot, 'createdAt'> & {
    createdAt?: number
  }): QuotaSnapshot {
    const createdAt = input.createdAt ?? now()
    this.db
      .prepare(
        `INSERT INTO quota_snapshots (
          id, account_uuid, token_label, status, rate_limit_type,
          utilization, resets_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.accountUuid,
        input.tokenLabel ?? null,
        input.status,
        input.rateLimitType ?? null,
        input.utilization ?? null,
        input.resetsAt ?? null,
        createdAt,
      )
    const row = this.db
      .prepare('SELECT * FROM quota_snapshots WHERE id = ?')
      .get(input.id) as Row
    return quotaFromRow(row)
  }

  listQuotaSnapshots(): QuotaSnapshot[] {
    return this.db
      .prepare('SELECT * FROM quota_snapshots ORDER BY created_at ASC')
      .all()
      .map(row => quotaFromRow(row as Row))
  }

  getLatestQuotaSnapshot(accountUuid: string): QuotaSnapshot | null {
    const row = this.db
      .prepare(
        `SELECT * FROM quota_snapshots
         WHERE account_uuid = ?
         ORDER BY created_at DESC
         LIMIT 1`,
      )
      .get(accountUuid) as Row | undefined
    return row ? quotaFromRow(row) : null
  }
}
