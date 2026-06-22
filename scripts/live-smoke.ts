#!/usr/bin/env tsx
import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { hashPassword } from '../src/auth/password.js'
import { createSecret, hashSecret } from '../src/auth/secrets.js'
import { createSession, sessionCookie } from '../src/auth/session.js'
import { startServer } from '../src/index.js'

const execFileAsync = promisify(execFile)
let adminCookie: string | undefined

type Args = {
  db: string
  host: string
  port: number
  pool: string
  client: string
  label: string
  sourceDevice: string
  timeoutMs: number
  open: boolean
  dryRun: boolean
  messages: boolean
  debugTrafficDir?: string
  model?: string
}

type AdminAccount = {
  accountUuid: string
  organizationUuid: string
  upstreamClientIdentityId: string
  enabled: boolean
}

type AdminToken = {
  label: string
  sourceDevice: string
  accountUuid: string
  scopes: string[]
  expiresAt?: number | null
  lastUsedAt?: number | null
}

type AdminAuditEvent = {
  endpoint?: string | null
  clientId?: string | null
  poolId?: string | null
  accountUuid?: string | null
  tokenLabel?: string | null
  model?: string | null
  upstreamRequestId?: string | null
  clientRequestId?: string | null
  status: string
  errorType?: string | null
}

type AdminQuotaSnapshot = {
  accountUuid: string
  tokenLabel?: string | null
  status: string
  rateLimitType?: string | null
  utilization?: number | null
  resetsAt?: number | null
}

type AdminPoolMember = {
  poolId: string
  accountUuid: string
  enabled: boolean
  priority: number
}

type ClaudeCodeCliResult = {
  type?: string
  subtype?: string
  is_error?: boolean
  result?: string
  session_id?: string
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    db: 'data/live-smoke.sqlite',
    host: 'localhost',
    port: 8799,
    pool: 'live-smoke',
    client: 'live-smoke-client',
    label: 'live-smoke-token',
    sourceDevice: 'live-smoke',
    timeoutMs: 300_000,
    open: false,
    dryRun: false,
    messages: false,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = () => {
      const value = argv[index + 1]
      if (!value) throw new Error(`Missing value for ${arg}`)
      index += 1
      return value
    }
    switch (arg) {
      case '--db':
        args.db = next()
        break
      case '--host':
        args.host = next()
        break
      case '--port':
        args.port = Number(next())
        break
      case '--pool':
        args.pool = next()
        break
      case '--client':
        args.client = next()
        break
      case '--label':
        args.label = next()
        break
      case '--source-device':
        args.sourceDevice = next()
        break
      case '--timeout-ms':
        args.timeoutMs = Number(next())
        break
      case '--model':
        args.model = next()
        break
      case '--open':
        args.open = true
        break
      case '--dry-run':
        args.dryRun = true
        break
      case '--messages':
        args.messages = true
        break
      case '--debug-traffic':
        args.debugTrafficDir = 'data/debug'
        break
      case '--debug-dir':
        args.debugTrafficDir = next()
        break
      default:
        throw new Error(`Unknown argument: ${arg}`)
    }
  }

  if (!Number.isFinite(args.port) || args.port <= 0) {
    throw new Error('--port must be a positive number')
  }
  if (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0) {
    throw new Error('--timeout-ms must be a positive number')
  }
  if (args.messages && !args.model) {
    throw new Error('--messages requires --model <anthropic-model>')
  }
  return args
}

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const parsed = new URL(url)
  const shouldAttachAdminCookie =
    adminCookie &&
    (parsed.pathname.startsWith('/admin/') ||
      parsed.pathname.startsWith('/oauth/') ||
      parsed.pathname === '/oauth/authorize')
  const response = await fetch(url, {
    ...init,
    headers: {
      ...(shouldAttachAdminCookie ? { Cookie: adminCookie } : {}),
      ...(init?.headers ?? {}),
    },
  })
  const text = await response.text()
  const body = text ? (JSON.parse(text) as unknown) : null
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${url}: ${text}`)
  }
  return body as T
}

function ensureSmokeAdminSession(
  store: ReturnType<typeof startServer>['store'],
): string {
  const existing = store.findAppUserByUsername('live-smoke-owner')
  const user =
    existing ??
    store.createAppUser({
      id: randomUUID(),
      username: 'live-smoke-owner',
      role: 'owner',
    })
  if (!existing) {
    store.upsertPasswordCredential({
      userId: user.id,
      passwordHash: hashPassword(createSecret('cmp')),
    })
  }
  const session = createSession({ store, userId: user.id })
  return sessionCookie(session.token, session.expiresAt)
}

function ensureSmokeClientSecret(input: {
  store: ReturnType<typeof startServer>['store']
  clientId: string
}): string {
  const secret = 'live-smoke-local-client-secret'
  const tokenHash = hashSecret(secret)
  const existing = input.store.findLocalClientTokenByHash(tokenHash)
  if (!existing) {
    input.store.createLocalClientToken({
      id: randomUUID(),
      clientId: input.clientId,
      name: 'live smoke',
      tokenHash,
    })
  }
  return secret
}

async function ensurePool(baseUrl: string, id: string): Promise<void> {
  const existing = await fetch(`${baseUrl}/admin/pools/${encodeURIComponent(id)}`, {
    headers: adminCookie ? { Cookie: adminCookie } : undefined,
  })
  if (existing.ok) return
  if (existing.status !== 404) {
    const text = await existing.text()
    throw new Error(`HTTP ${existing.status} checking pool ${id}: ${text}`)
  }
  await jsonFetch(`${baseUrl}/admin/pools`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id,
      name: id,
      purpose: 'live smoke',
    }),
  })
}

async function ensureClient(input: {
  baseUrl: string
  id: string
  poolId: string
}): Promise<void> {
  await jsonFetch(`${input.baseUrl}/admin/clients`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: input.id,
      name: input.id,
      enabled: true,
      default_pool_id: input.poolId,
    }),
  })
}

async function tokenExists(baseUrl: string, label: string): Promise<boolean> {
  const tokens = await listTokens(baseUrl)
  return tokens.some(token => token.label === label)
}

async function listTokens(baseUrl: string): Promise<AdminToken[]> {
  return jsonFetch<AdminToken[]>(`${baseUrl}/admin/tokens`)
}

async function listAuditEvents(baseUrl: string): Promise<AdminAuditEvent[]> {
  return jsonFetch<AdminAuditEvent[]>(`${baseUrl}/admin/audit-events`)
}

async function getTokenAccountUuid(
  baseUrl: string,
  label: string,
): Promise<string | null> {
  const tokens = await listTokens(baseUrl)
  return tokens.find(token => token.label === label)?.accountUuid ?? null
}

async function ensurePoolMember(input: {
  baseUrl: string
  poolId: string
  accountUuid: string
}): Promise<void> {
  await jsonFetch(
    `${input.baseUrl}/admin/pools/${encodeURIComponent(input.poolId)}/members`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        account_uuid: input.accountUuid,
        enabled: true,
      }),
    },
  )
}

async function waitForToken(input: {
  baseUrl: string
  label: string
  timeoutMs: number
}): Promise<void> {
  const deadline = Date.now() + input.timeoutMs
  while (Date.now() < deadline) {
    if (await tokenExists(input.baseUrl, input.label)) return
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  throw new Error(`Timed out waiting for OAuth token label ${input.label}`)
}

async function authorize(input: {
  baseUrl: string
  label: string
  sourceDevice: string
  poolId: string
  open: boolean
}): Promise<void> {
  const url = new URL(`${input.baseUrl}/oauth/authorize`)
  url.searchParams.set('label', input.label)
  url.searchParams.set('source_device', input.sourceDevice)
  url.searchParams.set('pool_id', input.poolId)
  const body = await jsonFetch<{ authorize_url: string; state: string }>(
    url.toString(),
  )

  console.log('Open this URL in a browser to complete Claude Code OAuth:')
  console.log(body.authorize_url)
  if (input.open) {
    const { execFile } = await import('node:child_process')
    execFile('open', [body.authorize_url])
  }
}

async function assertOAuthProfileInstalled(input: {
  baseUrl: string
  tokenLabel: string
  poolId: string
}): Promise<string> {
  const tokens = await listTokens(input.baseUrl)
  const token = tokens.find(item => item.label === input.tokenLabel)
  if (!token) {
    throw new Error(`OAuth/profile smoke failed: token ${input.tokenLabel} missing`)
  }
  for (const scope of ['user:profile', 'user:inference']) {
    if (!token.scopes.includes(scope)) {
      throw new Error(
        `OAuth/profile smoke failed: token ${input.tokenLabel} missing scope ${scope}`,
      )
    }
  }

  const accounts = await jsonFetch<AdminAccount[]>(`${input.baseUrl}/admin/accounts`)
  const account = accounts.find(item => item.accountUuid === token.accountUuid)
  if (!account) {
    throw new Error(
      `OAuth/profile smoke failed: account ${token.accountUuid} missing`,
    )
  }
  if (!account.enabled) {
    throw new Error(
      `OAuth/profile smoke failed: account ${account.accountUuid} is disabled`,
    )
  }
  if (!account.organizationUuid || !account.upstreamClientIdentityId) {
    throw new Error(
      `OAuth/profile smoke failed: account ${account.accountUuid} has incomplete profile identity`,
    )
  }

  const members = await jsonFetch<AdminPoolMember[]>(
    `${input.baseUrl}/admin/pools/${encodeURIComponent(input.poolId)}/members`,
  )
  const member = members.find(item => item.accountUuid === account.accountUuid)
  if (!member || !member.enabled) {
    throw new Error(
      `OAuth/profile smoke failed: account ${account.accountUuid} is not enabled in pool ${input.poolId}`,
    )
  }

  console.log(
    `OAuth/profile evidence ok: account=${account.accountUuid} organization=${account.organizationUuid} token=${token.label}`,
  )
  return account.accountUuid
}

function assertLatestMessageAudit(input: {
  auditEvents: AdminAuditEvent[]
  startCount: number
  clientId: string
  accountUuid: string
  tokenLabel: string
  model: string
}): AdminAuditEvent[] {
  const newEvents = input.auditEvents.slice(input.startCount)
  const events = newEvents.filter(item => item.endpoint === '/v1/messages')
  if (events.length === 0) {
    throw new Error('Claude Code CLI smoke failed: audit event missing')
  }
  for (const event of events) {
    if (event.status !== 'success') {
      throw new Error(
        `Claude Code CLI smoke failed: audit status ${event.status} error=${event.errorType ?? 'none'}`,
      )
    }
    const expected: Array<[string, unknown, unknown]> = [
      ['clientId', event.clientId, input.clientId],
      ['accountUuid', event.accountUuid, input.accountUuid],
      ['tokenLabel', event.tokenLabel, input.tokenLabel],
      ['model', event.model, input.model],
    ]
    for (const [field, actual, expectedValue] of expected) {
      if (actual !== expectedValue) {
        throw new Error(
          `Claude Code CLI smoke failed: audit ${field}=${String(actual)} expected=${String(expectedValue)}`,
        )
      }
    }
    if (!event.clientRequestId) {
      throw new Error('Claude Code CLI smoke failed: audit client request id missing')
    }
  }
  console.log(
    `Claude Code CLI audit evidence ok: events=${events.length} request-ids=${events.map(event => event.upstreamRequestId ?? 'none').join(',')}`,
  )
  return events
}

async function smokeClaudeCodeCliMessages(input: {
  baseUrl: string
  clientId: string
  poolId: string
  accountUuid: string
  tokenLabel: string
  model: string
  timeoutMs: number
  clientSecret: string
  store: ReturnType<typeof startServer>['store']
}): Promise<void> {
  const auditStartCount = (await listAuditEvents(input.baseUrl)).length
  const homeDir = mkdtempSync(join(tmpdir(), 'claude-mgr-cc-home.'))
  const configDir = mkdtempSync(join(tmpdir(), 'claude-mgr-cc-config.'))
  const claudeBin = join(
    process.cwd(),
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'claude.cmd' : 'claude',
  )

  try {
    const { stdout, stderr } = await execFileAsync(
      claudeBin,
      [
        '--bare',
        '--print',
        '--no-session-persistence',
        '--disable-slash-commands',
        '--model',
        input.model,
        '--output-format',
        'json',
        'Respond with exactly OK and nothing else.',
      ],
      {
        env: {
          ...process.env,
          HOME: homeDir,
          CLAUDE_CONFIG_DIR: configDir,
          ANTHROPIC_BASE_URL: input.baseUrl,
          ANTHROPIC_API_KEY: input.clientSecret,
          ANTHROPIC_CUSTOM_HEADERS: `x-claude-mgr-client-id: ${input.clientId}\nx-claude-mgr-pool-id: ${input.poolId}`,
        },
        timeout: input.timeoutMs,
        maxBuffer: 1024 * 1024,
      },
    )
    const output = stdout.trim()
    const result = JSON.parse(output) as ClaudeCodeCliResult
    if (result.is_error || result.subtype !== 'success' || result.result !== 'OK') {
      throw new Error(
        `Claude Code CLI smoke failed: stdout=${output} stderr=${stderr.trim()}`,
      )
    }
    if (!result.session_id) {
      throw new Error(`Claude Code CLI smoke failed: session_id missing: ${output}`)
    }
    const binding = input.store.findMessageSessionBinding({
      localClientId: input.clientId,
      poolId: input.poolId,
      inboundSessionId: result.session_id,
    })
    if (!binding) {
      throw new Error(
        `Claude Code CLI smoke failed: session binding missing for ${result.session_id}`,
      )
    }
    if (binding.accountUuid !== input.accountUuid) {
      throw new Error(
        `Claude Code CLI smoke failed: session account=${binding.accountUuid} expected=${input.accountUuid}`,
      )
    }
    if (binding.upstreamSessionId === result.session_id) {
      throw new Error(
        'Claude Code CLI smoke failed: inbound session id was forwarded upstream',
      )
    }
    const auditEvents = assertLatestMessageAudit({
      auditEvents: await listAuditEvents(input.baseUrl),
      startCount: auditStartCount,
      clientId: input.clientId,
      accountUuid: input.accountUuid,
      tokenLabel: input.tokenLabel,
      model: input.model,
    })
    console.log(
      `Claude Code CLI smoke ok: result=${result.result} session=${result.session_id} mapped_session=${binding.upstreamSessionId} message_events=${auditEvents.length}`,
    )
  } finally {
    rmSync(homeDir, { recursive: true, force: true })
    rmSync(configDir, { recursive: true, force: true })
  }
}

async function printEvidenceSummary(baseUrl: string): Promise<void> {
  const auditEvents = await listAuditEvents(baseUrl)
  const quotaSnapshots = await jsonFetch<AdminQuotaSnapshot[]>(
    `${baseUrl}/admin/quota-snapshots`,
  )

  const recentAudits = auditEvents.slice(-5)
  console.log('Recent audit events:')
  console.log(
    JSON.stringify(
      recentAudits.map(event => ({
        endpoint: event.endpoint ?? null,
        clientId: event.clientId ?? null,
        poolId: event.poolId ?? null,
        accountUuid: event.accountUuid ?? null,
        tokenLabel: event.tokenLabel ?? null,
        model: event.model ?? null,
        upstreamRequestId: event.upstreamRequestId ?? null,
        clientRequestId: event.clientRequestId ?? null,
        status: event.status,
        errorType: event.errorType ?? null,
      })),
      null,
      2,
    ),
  )

  const recentQuota = quotaSnapshots.slice(-5)
  console.log('Recent quota snapshots:')
  console.log(
    JSON.stringify(
      recentQuota.map(snapshot => ({
        accountUuid: snapshot.accountUuid,
        tokenLabel: snapshot.tokenLabel ?? null,
        status: snapshot.status,
        rateLimitType: snapshot.rateLimitType ?? null,
        utilization: snapshot.utilization ?? null,
        resetsAt: snapshot.resetsAt ?? null,
      })),
      null,
      2,
    ),
  )
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const runtime = startServer({
    databasePath: args.db,
    host: args.host,
    port: args.port,
    debugTrafficDir: args.debugTrafficDir,
  })
  const baseUrl = runtime.url
  adminCookie = ensureSmokeAdminSession(runtime.store)
  console.log(`claude-mgr live smoke server listening on ${baseUrl}`)
  if (args.debugTrafficDir) {
    console.log(`Debug traffic JSONL enabled under ${args.debugTrafficDir}`)
  }

  let shuttingDown = false
  const shutdown = async () => {
    if (shuttingDown) return
    shuttingDown = true
    await new Promise<void>(resolve => runtime.server.close(() => resolve()))
    runtime.store.close()
  }

  process.once('SIGINT', () => {
    void shutdown().finally(() => process.exit(130))
  })

  try {
    await jsonFetch(`${baseUrl}/health`)
    await ensurePool(baseUrl, args.pool)
    await ensureClient({
      baseUrl,
      id: args.client,
      poolId: args.pool,
    })
    const clientSecret = ensureSmokeClientSecret({
      store: runtime.store,
      clientId: args.client,
    })

    if (!(await tokenExists(baseUrl, args.label))) {
      await authorize({
        baseUrl,
        label: args.label,
        sourceDevice: args.sourceDevice,
        poolId: args.pool,
        open: args.open,
      })
      if (args.dryRun) {
        console.log('Dry run complete; OAuth callback wait skipped')
        return
      }
      await waitForToken({
        baseUrl,
        label: args.label,
        timeoutMs: args.timeoutMs,
      })
    }
    const accountUuid = await getTokenAccountUuid(baseUrl, args.label)
    if (accountUuid) {
      await ensurePoolMember({
        baseUrl,
        poolId: args.pool,
        accountUuid,
      })
    }
    const verifiedAccountUuid = await assertOAuthProfileInstalled({
      baseUrl,
      tokenLabel: args.label,
      poolId: args.pool,
    })
    console.log(`OAuth/profile smoke ok: token label ${args.label} is installed`)

    if (args.messages) {
      await smokeClaudeCodeCliMessages({
        baseUrl,
        clientId: args.client,
        poolId: args.pool,
        accountUuid: verifiedAccountUuid,
        tokenLabel: args.label,
        model: args.model!,
        timeoutMs: args.timeoutMs,
        clientSecret,
        store: runtime.store,
      })
    } else {
      console.log('Messages smoke skipped; pass --messages --model <model> to run it')
    }
    await printEvidenceSummary(baseUrl)
  } finally {
    await shutdown()
  }
}

await main()
