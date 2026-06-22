export const sqliteSchema = [
  `CREATE TABLE IF NOT EXISTS app_users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    display_name TEXT,
    role TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS password_credentials (
    user_id TEXT PRIMARY KEY,
    password_hash TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY(user_id) REFERENCES app_users(id)
  )`,
  `CREATE TABLE IF NOT EXISTS user_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    session_hash TEXT NOT NULL UNIQUE,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER,
    FOREIGN KEY(user_id) REFERENCES app_users(id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_user_sessions_user
    ON user_sessions(user_id)`,
  `CREATE TABLE IF NOT EXISTS pending_oauth_logins (
    state TEXT PRIMARY KEY,
    code_verifier TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    label TEXT NOT NULL,
    source_device TEXT NOT NULL,
    pool_id TEXT,
    initiated_by_user_id TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    consumed_at INTEGER,
    created_at INTEGER NOT NULL,
    FOREIGN KEY(pool_id) REFERENCES account_pools(id),
    FOREIGN KEY(initiated_by_user_id) REFERENCES app_users(id)
  )`,
  `CREATE TABLE IF NOT EXISTS claude_accounts (
    account_uuid TEXT PRIMARY KEY,
    organization_uuid TEXT NOT NULL,
    email TEXT,
    display_name TEXT,
    upstream_client_identity_id TEXT NOT NULL UNIQUE,
    owner_user_id TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    subscription_type TEXT,
    rate_limit_tier TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY(owner_user_id) REFERENCES app_users(id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_claude_accounts_org
    ON claude_accounts(organization_uuid)`,
  `CREATE TABLE IF NOT EXISTS account_pools (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    purpose TEXT,
    owner_user_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY(owner_user_id) REFERENCES app_users(id)
  )`,
  `CREATE TABLE IF NOT EXISTS account_pool_members (
    pool_id TEXT NOT NULL,
    account_uuid TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 100,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    PRIMARY KEY(pool_id, account_uuid),
    FOREIGN KEY(pool_id) REFERENCES account_pools(id),
    FOREIGN KEY(account_uuid) REFERENCES claude_accounts(account_uuid)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_account_pool_members_account
    ON account_pool_members(account_uuid)`,
  `CREATE TABLE IF NOT EXISTS local_clients (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    owner_user_id TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    default_pool_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY(owner_user_id) REFERENCES app_users(id),
    FOREIGN KEY(default_pool_id) REFERENCES account_pools(id)
  )`,
  `CREATE TABLE IF NOT EXISTS oauth_tokens (
    label TEXT PRIMARY KEY,
    source_device TEXT NOT NULL,
    account_uuid TEXT NOT NULL,
    owner_user_id TEXT,
    scopes_json TEXT NOT NULL,
    access_token TEXT NOT NULL,
    refresh_token TEXT,
    expires_at INTEGER,
    last_used_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY(owner_user_id) REFERENCES app_users(id),
    FOREIGN KEY(account_uuid) REFERENCES claude_accounts(account_uuid)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_oauth_tokens_account
    ON oauth_tokens(account_uuid)`,
  `CREATE TABLE IF NOT EXISTS audit_events (
    id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    pool_id TEXT,
    account_uuid TEXT,
    token_label TEXT,
    endpoint TEXT,
    model TEXT,
    upstream_request_id TEXT,
    client_request_id TEXT,
    status TEXT NOT NULL,
    error_type TEXT,
    input_tokens INTEGER,
    output_tokens INTEGER,
    quota_snapshot_id TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY(pool_id) REFERENCES account_pools(id),
    FOREIGN KEY(account_uuid) REFERENCES claude_accounts(account_uuid),
    FOREIGN KEY(token_label) REFERENCES oauth_tokens(label),
    FOREIGN KEY(quota_snapshot_id) REFERENCES quota_snapshots(id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_audit_events_created_at
    ON audit_events(created_at)`,
  `CREATE TABLE IF NOT EXISTS quota_snapshots (
    id TEXT PRIMARY KEY,
    account_uuid TEXT NOT NULL,
    token_label TEXT,
    status TEXT NOT NULL,
    rate_limit_type TEXT,
    utilization REAL,
    resets_at INTEGER,
    created_at INTEGER NOT NULL,
    FOREIGN KEY(account_uuid) REFERENCES claude_accounts(account_uuid),
    FOREIGN KEY(token_label) REFERENCES oauth_tokens(label)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_quota_snapshots_created_at
    ON quota_snapshots(created_at)`,
  `CREATE TABLE IF NOT EXISTS message_session_bindings (
    local_client_id TEXT NOT NULL,
    pool_scope TEXT NOT NULL,
    pool_id TEXT,
    inbound_session_id TEXT NOT NULL,
    account_uuid TEXT NOT NULL,
    upstream_session_id TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER NOT NULL,
    PRIMARY KEY(local_client_id, pool_scope, inbound_session_id),
    FOREIGN KEY(local_client_id) REFERENCES local_clients(id),
    FOREIGN KEY(pool_id) REFERENCES account_pools(id),
    FOREIGN KEY(account_uuid) REFERENCES claude_accounts(account_uuid)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_message_session_bindings_account
    ON message_session_bindings(account_uuid)`,
  `CREATE TABLE IF NOT EXISTS local_client_tokens (
    id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_by_user_id TEXT,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER,
    revoked_at INTEGER,
    FOREIGN KEY(client_id) REFERENCES local_clients(id),
    FOREIGN KEY(created_by_user_id) REFERENCES app_users(id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_local_client_tokens_client
    ON local_client_tokens(client_id)`,
] as const
