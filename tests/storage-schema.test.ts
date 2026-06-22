import { describe, expect, it } from 'vitest'
import { sqliteSchema } from '../src/storage/schema.js'

describe('sqlite schema', () => {
  it('defines the MVP persistence tables', () => {
    const schema = sqliteSchema.join('\n')

    expect(schema).toContain('CREATE TABLE IF NOT EXISTS claude_accounts')
    expect(schema).toContain('CREATE TABLE IF NOT EXISTS account_pools')
    expect(schema).toContain('CREATE TABLE IF NOT EXISTS account_pool_members')
    expect(schema).toContain('CREATE TABLE IF NOT EXISTS local_clients')
    expect(schema).toContain('CREATE TABLE IF NOT EXISTS oauth_tokens')
    expect(schema).toContain('CREATE TABLE IF NOT EXISTS audit_events')
    expect(schema).toContain('CREATE TABLE IF NOT EXISTS quota_snapshots')
    expect(schema).toContain('CREATE TABLE IF NOT EXISTS message_session_bindings')
  })

  it('stores OAuth tokens as plaintext database columns for the local-owner MVP', () => {
    const schema = sqliteSchema.join('\n')

    expect(schema).toContain('access_token TEXT NOT NULL')
    expect(schema).toContain('refresh_token TEXT')
    expect(schema).not.toContain('access_token_ciphertext')
    expect(schema).not.toContain('refresh_token_ciphertext')
  })

  it('keeps audit events metadata-only by default', () => {
    const schema = sqliteSchema.join('\n')

    expect(schema).toContain('CREATE TABLE IF NOT EXISTS audit_events')
    for (const forbiddenColumn of [
      'prompt',
      'completion',
      'message_body',
      'messages_json',
      'request_body',
      'response_body',
      'tool_result',
      'file_content',
    ]) {
      expect(schema).not.toContain(forbiddenColumn)
    }
  })

  it('separates upstream account identity from token records', () => {
    const schema = sqliteSchema.join('\n')

    expect(schema).toContain('upstream_client_identity_id TEXT NOT NULL UNIQUE')
    expect(schema).toContain('enabled INTEGER NOT NULL DEFAULT 1')
    expect(schema).toContain('CREATE TABLE IF NOT EXISTS local_clients')
    expect(schema).toContain('FOREIGN KEY(account_uuid) REFERENCES claude_accounts(account_uuid)')
    expect(schema).toContain('PRIMARY KEY(pool_id, account_uuid)')
  })

  it('stores message session affinity without storing conversation bodies', () => {
    const schema = sqliteSchema.join('\n')

    expect(schema).toContain('inbound_session_id TEXT NOT NULL')
    expect(schema).toContain('upstream_session_id TEXT NOT NULL UNIQUE')
    expect(schema).toContain(
      'PRIMARY KEY(local_client_id, pool_scope, inbound_session_id)',
    )
  })
})
