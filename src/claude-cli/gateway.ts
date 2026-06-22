import { randomUUID } from 'node:crypto'
import type { AuditEvent, SelectedCredential } from '../domain/types.js'
import { GatewayError, UpstreamError } from '../errors.js'
import { TokenRefresher } from '../oauth/token-refresher.js'
import { AccountRouter } from '../routing/account-router.js'
import type { SqliteStore } from '../storage/sqlite-store.js'
import {
  type ClaudeCliEndpoint,
  UpstreamClaudeCliClient,
  type UpstreamClaudeCliResponse,
} from '../upstream/claude-cli-client.js'

export type ClaudeCliGatewayOptions = {
  store: SqliteStore
  router?: AccountRouter
  tokenRefresher?: TokenRefresher
  upstream?: UpstreamClaudeCliClient
  userAgent?: string
}

export type ClaudeCliGatewayInput = {
  localClientId: string
  poolId?: string
  endpoint: ClaudeCliEndpoint
  signal?: AbortSignal
}

export type ClaudeCliGatewayResult = {
  response: UpstreamClaudeCliResponse
  auditEvent: AuditEvent
}

function endpointPath(endpoint: ClaudeCliEndpoint): string {
  switch (endpoint) {
    case 'bootstrap':
      return '/api/claude_cli/bootstrap'
    case 'usage':
      return '/api/oauth/usage'
  }
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' || error.message.includes('aborted'))
  )
}

export class ClaudeCliGateway {
  private readonly store: SqliteStore
  private readonly router: AccountRouter
  private readonly tokenRefresher?: TokenRefresher
  private readonly upstream: UpstreamClaudeCliClient
  private readonly userAgent: string

  constructor(options: ClaudeCliGatewayOptions) {
    this.store = options.store
    this.router = options.router ?? new AccountRouter(options.store)
    this.tokenRefresher = options.tokenRefresher
    this.upstream = options.upstream ?? new UpstreamClaudeCliClient()
    this.userAgent = options.userAgent ?? 'claude-mgr/0.1.0'
  }

  async get(input: ClaudeCliGatewayInput): Promise<ClaudeCliGatewayResult> {
    const auditEvent = this.insertPendingAudit(input)

    try {
      let selected = await this.resolveProfileCredential(input)
      this.updateSelectedAudit(auditEvent.id, input, selected)
      let response: UpstreamClaudeCliResponse
      try {
        response = await this.upstream.get({
          endpoint: input.endpoint,
          token: selected.token,
          userAgent: this.userAgent,
          signal: input.signal,
        })
      } catch (error) {
        if (!(error instanceof UpstreamError) || error.status !== 401) {
          throw error
        }
        selected = await this.refreshAfterAuthError(input, selected)
        this.updateSelectedAudit(auditEvent.id, input, selected)
        response = await this.upstream.get({
          endpoint: input.endpoint,
          token: selected.token,
          userAgent: this.userAgent,
          signal: input.signal,
        })
      }

      const finalAuditEvent = this.store.updateAuditEvent({
        id: auditEvent.id,
        upstreamRequestId: response.upstreamRequestId ?? null,
        status: 'success',
      })
      return { response, auditEvent: finalAuditEvent }
    } catch (error) {
      this.updateErrorAudit(auditEvent.id, error)
      throw error
    }
  }

  private insertPendingAudit(input: ClaudeCliGatewayInput): AuditEvent {
    return this.store.insertAuditEvent({
      id: randomUUID(),
      clientId: input.localClientId,
      poolId: this.auditPoolId(input),
      endpoint: endpointPath(input.endpoint),
      status: 'pending',
    })
  }

  private auditPoolId(input: ClaudeCliGatewayInput): string | null {
    if (input.poolId) return input.poolId
    return this.store.findLocalClient(input.localClientId)?.defaultPoolId ?? null
  }

  private updateSelectedAudit(
    auditEventId: string,
    input: ClaudeCliGatewayInput,
    selected: SelectedCredential,
  ): void {
    this.store.updateAuditEvent({
      id: auditEventId,
      poolId: selected.poolId ?? input.poolId ?? null,
      accountUuid: selected.account.accountUuid,
      tokenLabel: selected.token.label,
    })
  }

  private updateErrorAudit(auditEventId: string, error: unknown): void {
    const errorType =
      error instanceof GatewayError
        ? error.type
        : error instanceof UpstreamError
          ? error.upstreamType
          : isAbortError(error)
            ? 'gateway_upstream_unreachable'
            : 'gateway_upstream_unreachable'
    this.store.updateAuditEvent({
      id: auditEventId,
      status: 'error',
      errorType: errorType ?? null,
      upstreamRequestId:
        error instanceof UpstreamError ? (error.requestId ?? null) : undefined,
    })
  }

  private async resolveProfileCredential(input: ClaudeCliGatewayInput) {
    try {
      return this.router.resolveCredential({
        localClientId: input.localClientId,
        poolId: input.poolId,
        requiredScope: 'user:profile',
      })
    } catch (error) {
      if (
        !(error instanceof GatewayError) ||
        error.type !== 'gateway_no_eligible_token' ||
        !this.tokenRefresher
      ) {
        throw error
      }
      const refreshed = await this.refreshFirstExpiredWithAudit(input)
      if (!refreshed) throw error
      return this.router.resolveCredential({
        localClientId: input.localClientId,
        poolId: input.poolId,
        requiredScope: 'user:profile',
      })
    }
  }

  private async refreshFirstExpiredWithAudit(
    input: ClaudeCliGatewayInput,
  ): Promise<SelectedCredential['token'] | null> {
    if (!this.tokenRefresher) return null
    const client = this.store.getLocalClient(input.localClientId)
    const poolId = input.poolId ?? client.defaultPoolId ?? null
    const candidate = this.store.listRefreshableTokenRows({
      poolId,
      requiredScope: 'user:profile',
    })[0]
    if (!candidate) return null

    const auditEvent = this.store.insertAuditEvent({
      id: randomUUID(),
      clientId: input.localClientId,
      poolId: candidate.poolId ?? poolId,
      accountUuid: candidate.account.accountUuid,
      tokenLabel: candidate.token.label,
      endpoint: '/v1/oauth/token',
      status: 'pending',
    })

    try {
      const refreshed = await this.tokenRefresher.refreshToken(candidate.token)
      this.store.updateAuditEvent({
        id: auditEvent.id,
        status: 'success',
      })
      return refreshed
    } catch (error) {
      this.updateErrorAudit(auditEvent.id, error)
      throw error
    }
  }

  private async refreshAfterAuthError(
    input: ClaudeCliGatewayInput,
    selected: SelectedCredential,
  ): Promise<SelectedCredential> {
    if (!this.tokenRefresher) {
      throw new UpstreamError({
        status: 401,
        message: 'Upstream authentication failed and token refresher is disabled',
        body: null,
        upstreamType: 'authentication_error',
      })
    }
    const refreshed = await this.tokenRefresher.refreshToken(selected.token)
    this.store.insertAuditEvent({
      id: randomUUID(),
      clientId: input.localClientId,
      poolId: selected.poolId ?? input.poolId ?? null,
      accountUuid: refreshed.accountUuid,
      tokenLabel: refreshed.label,
      endpoint: '/v1/oauth/token',
      status: 'success',
      errorType: 'upstream_401_retry',
    })
    return {
      account: selected.account,
      token: refreshed,
      poolId: selected.poolId ?? input.poolId ?? null,
    }
  }
}
