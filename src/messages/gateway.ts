import { randomUUID } from 'node:crypto'
import type { AuditEvent, SelectedCredential } from '../domain/types.js'
import { GatewayError, UpstreamError } from '../errors.js'
import { quotaSnapshotFromHeaders } from '../quota/headers.js'
import { AccountRouter } from '../routing/account-router.js'
import { TokenRefresher } from '../oauth/token-refresher.js'
import type { SqliteStore } from '../storage/sqlite-store.js'
import {
  UpstreamMessagesClient,
  type UpstreamMessagesResponse,
  type UpstreamMessagesStreamResponse,
} from '../upstream/messages-client.js'
import { extractUsageSummary } from '../audit/usage.js'
import { adaptMessagesRequest, type MessageRequest } from './adapter.js'

export type MessagesGatewayOptions = {
  store: SqliteStore
  router?: AccountRouter
  tokenRefresher?: TokenRefresher
  upstream?: UpstreamMessagesClient
  userAgent?: string
}

export type GatewayMessageInput = {
  localClientId: string
  poolId?: string
  sessionId?: string
  headers?: Headers
  body: MessageRequest
  signal?: AbortSignal
}

export type GatewayMessageJsonResult = {
  response: UpstreamMessagesResponse
  auditEvent: AuditEvent
}

export type GatewayMessageStreamResult = {
  response: UpstreamMessagesStreamResponse
  auditEvent: AuditEvent
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' || error.message.includes('aborted'))
  )
}

export class MessagesGateway {
  private readonly store: SqliteStore
  private readonly router: AccountRouter
  private readonly tokenRefresher?: TokenRefresher
  private readonly upstream: UpstreamMessagesClient
  private readonly userAgent: string

  constructor(options: MessagesGatewayOptions) {
    this.store = options.store
    this.router = options.router ?? new AccountRouter(options.store)
    this.tokenRefresher = options.tokenRefresher
    this.upstream = options.upstream ?? new UpstreamMessagesClient()
    this.userAgent = options.userAgent ?? 'claude-mgr/0.1.0'
  }

  async sendJson(input: GatewayMessageInput): Promise<GatewayMessageJsonResult> {
    const auditEvent = this.insertPendingMessagesAudit(input)

    try {
      let selected = await this.resolveCredential(input)
      this.updateSelectedAudit(auditEvent.id, input, selected)
      let adapted = adaptMessagesRequest({
        body: input.body,
        credential: selected,
        userAgent: this.userAgent,
        downstreamHeaders: input.headers,
        signal: input.signal,
      })
      this.store.updateAuditEvent({
        id: auditEvent.id,
        clientRequestId: adapted.clientRequestId,
      })

      let response: UpstreamMessagesResponse
      try {
        response = await this.upstream.sendJson(adapted)
      } catch (error) {
        if (!(error instanceof UpstreamError) || error.status !== 401) {
          throw error
        }
        selected = await this.refreshAfterAuthError(input, selected)
        this.updateSelectedAudit(auditEvent.id, input, selected)
        adapted = adaptMessagesRequest({
          body: input.body,
          credential: selected,
          userAgent: this.userAgent,
          downstreamHeaders: input.headers,
          clientRequestId: adapted.clientRequestId,
          signal: input.signal,
        })
        response = await this.upstream.sendJson(adapted)
      }
      const quota = quotaSnapshotFromHeaders({
        headers: response.headers,
        accountUuid: selected.account.accountUuid,
        tokenLabel: selected.token.label,
      })
      const savedQuota = quota ? this.store.insertQuotaSnapshot(quota) : null
      const usage = extractUsageSummary(response.body)
      const finalAuditEvent = this.store.updateAuditEvent({
        id: auditEvent.id,
        upstreamRequestId: response.upstreamRequestId ?? null,
        clientRequestId: response.clientRequestId,
        status: 'success',
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        quotaSnapshotId: savedQuota?.id ?? null,
      })
      return { response, auditEvent: finalAuditEvent }
    } catch (error) {
      this.updateErrorAudit(auditEvent.id, error)
      throw error
    }
  }

  async sendStream(
    input: GatewayMessageInput,
  ): Promise<GatewayMessageStreamResult> {
    const auditEvent = this.insertPendingMessagesAudit(input)

    try {
      let selected = await this.resolveCredential(input)
      this.updateSelectedAudit(auditEvent.id, input, selected)
      let adapted = adaptMessagesRequest({
        body: input.body,
        credential: selected,
        userAgent: this.userAgent,
        downstreamHeaders: input.headers,
        signal: input.signal,
      })
      this.store.updateAuditEvent({
        id: auditEvent.id,
        clientRequestId: adapted.clientRequestId,
      })

      let response: UpstreamMessagesStreamResponse
      try {
        response = await this.upstream.sendStream(adapted)
      } catch (error) {
        if (!(error instanceof UpstreamError) || error.status !== 401) {
          throw error
        }
        selected = await this.refreshAfterAuthError(input, selected)
        this.updateSelectedAudit(auditEvent.id, input, selected)
        adapted = adaptMessagesRequest({
          body: input.body,
          credential: selected,
          userAgent: this.userAgent,
          downstreamHeaders: input.headers,
          clientRequestId: adapted.clientRequestId,
          signal: input.signal,
        })
        response = await this.upstream.sendStream(adapted)
      }
      const quota = quotaSnapshotFromHeaders({
        headers: response.headers,
        accountUuid: selected.account.accountUuid,
        tokenLabel: selected.token.label,
      })
      const savedQuota = quota ? this.store.insertQuotaSnapshot(quota) : null
      const updatedAuditEvent = this.store.updateAuditEvent({
        id: auditEvent.id,
        upstreamRequestId: response.upstreamRequestId ?? null,
        clientRequestId: response.clientRequestId,
        quotaSnapshotId: savedQuota?.id ?? null,
      })
      return {
        response: {
          ...response,
          stream: this.wrapAuditedStream(response.stream, auditEvent.id),
        },
        auditEvent: updatedAuditEvent,
      }
    } catch (error) {
      this.updateErrorAudit(auditEvent.id, error)
      throw error
    }
  }

  private insertPendingMessagesAudit(input: GatewayMessageInput): AuditEvent {
    return this.store.insertAuditEvent({
      id: randomUUID(),
      clientId: input.localClientId,
      poolId: this.auditPoolId(input),
      endpoint: '/v1/messages',
      model: typeof input.body.model === 'string' ? input.body.model : null,
      status: 'pending',
    })
  }

  private auditPoolId(input: GatewayMessageInput): string | null {
    if (input.poolId) return input.poolId
    return this.store.findLocalClient(input.localClientId)?.defaultPoolId ?? null
  }

  private updateSelectedAudit(
    auditEventId: string,
    input: GatewayMessageInput,
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
            ? 'gateway_stream_interrupted'
            : 'gateway_upstream_unreachable'
    this.store.updateAuditEvent({
      id: auditEventId,
      status: 'error',
      errorType: errorType ?? null,
      upstreamRequestId:
        error instanceof UpstreamError ? (error.requestId ?? null) : undefined,
    })
  }

  private async resolveCredential(input: GatewayMessageInput) {
    try {
      return this.router.resolveCredential({
        localClientId: input.localClientId,
        poolId: input.poolId,
        sessionId: input.sessionId,
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
        sessionId: input.sessionId,
      })
    }
  }

  private async refreshFirstExpiredWithAudit(
    input: GatewayMessageInput,
  ): Promise<SelectedCredential['token'] | null> {
    if (!this.tokenRefresher) return null
    const client = this.store.getLocalClient(input.localClientId)
    const poolId = input.poolId ?? client.defaultPoolId ?? null
    const boundAccountUuid = input.sessionId
      ? this.store.findMessageSessionBinding({
          localClientId: input.localClientId,
          poolId,
          inboundSessionId: input.sessionId,
        })?.accountUuid
      : null
    const candidate = this.store.listRefreshableTokenRows({
      poolId,
      requiredScope: 'user:inference',
    }).find(row => !boundAccountUuid || row.account.accountUuid === boundAccountUuid)
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
    input: GatewayMessageInput,
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

  private wrapAuditedStream(
    stream: ReadableStream<Uint8Array>,
    auditEventId: string,
  ): ReadableStream<Uint8Array> {
    const reader = stream.getReader()
    let finalized = false

    const finalize = (input: {
      status: 'success' | 'interrupted'
      errorType?: string | null
    }) => {
      if (finalized) return
      finalized = true
      this.store.updateAuditEventStatus({
        id: auditEventId,
        status: input.status,
        errorType: input.errorType ?? null,
      })
    }

    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await reader.read()
          if (done) {
            finalize({ status: 'success' })
            controller.close()
            return
          }
          if (value) {
            controller.enqueue(value)
          }
        } catch (error) {
          finalize({
            status: 'interrupted',
            errorType: 'gateway_stream_parse_error',
          })
          controller.error(error)
        }
      },
      async cancel(reason) {
        finalize({
          status: 'interrupted',
          errorType: 'gateway_stream_interrupted',
        })
        await reader.cancel(reason)
      },
    })
  }
}
