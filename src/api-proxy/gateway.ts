import { randomUUID } from 'node:crypto'
import type { AuditEvent, SelectedCredential } from '../domain/types.js'
import { GatewayError } from '../errors.js'
import { AccountRouter } from '../routing/account-router.js'
import type { SqliteStore } from '../storage/sqlite-store.js'
import {
  ApiProxyClient,
  type ApiProxyResponse,
  type ProxyEndpointKind,
} from '../upstream/api-proxy-client.js'

export type ApiProxyGatewayOptions = {
  store: SqliteStore
  router?: AccountRouter
  upstream?: ApiProxyClient
}

export type ApiProxyGatewayInput = {
  localClientId?: string
  poolId?: string
  endpoint: string
  endpointKind: ProxyEndpointKind
  method: string
  pathWithSearch: string
  headers: Headers
  body?: RequestInit['body']
  signal?: AbortSignal
}

export type ApiProxyGatewayResult = {
  response: ApiProxyResponse
  auditEvent: AuditEvent
}

export class ApiProxyGateway {
  private readonly store: SqliteStore
  private readonly router: AccountRouter
  private readonly upstream: ApiProxyClient

  constructor(options: ApiProxyGatewayOptions) {
    this.store = options.store
    this.router = options.router ?? new AccountRouter(options.store)
    this.upstream = options.upstream ?? new ApiProxyClient()
  }

  async forward(input: ApiProxyGatewayInput): Promise<ApiProxyGatewayResult> {
    const auditEvent = this.insertPendingAudit(input)

    try {
      const selected = input.localClientId
        ? this.resolveAnyCredential(input)
        : null
      if (selected) {
        this.updateSelectedAudit(auditEvent.id, input, selected)
      }
      const response = await this.upstream.forward({
        method: input.method,
        pathWithSearch: input.pathWithSearch,
        endpointKind: input.endpointKind,
        headers: input.headers,
        body: input.body,
        accessToken: selected?.token.accessToken,
        signal: input.signal,
      })
      const finalAuditEvent = this.store.updateAuditEvent({
        id: auditEvent.id,
        upstreamRequestId: response.upstreamRequestId ?? null,
        status: response.status >= 400 ? 'error' : 'success',
        errorType: response.status >= 400 ? `upstream_http_${response.status}` : null,
      })
      return { response, auditEvent: finalAuditEvent }
    } catch (error) {
      this.updateErrorAudit(auditEvent.id, error)
      throw error
    }
  }

  private insertPendingAudit(input: ApiProxyGatewayInput): AuditEvent {
    return this.store.insertAuditEvent({
      id: randomUUID(),
      clientId: input.localClientId ?? '__anonymous__',
      poolId: this.auditPoolId(input),
      endpoint: input.endpoint,
      status: 'pending',
    })
  }

  private auditPoolId(input: ApiProxyGatewayInput): string | null {
    if (input.poolId) return input.poolId
    if (!input.localClientId) return null
    return this.store.findLocalClient(input.localClientId)?.defaultPoolId ?? null
  }

  private resolveAnyCredential(input: ApiProxyGatewayInput): SelectedCredential {
    return this.router.resolveCredential({
      localClientId: input.localClientId!,
      poolId: input.poolId,
      requiredScope: null,
    })
  }

  private updateSelectedAudit(
    auditEventId: string,
    input: ApiProxyGatewayInput,
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
    this.store.updateAuditEvent({
      id: auditEventId,
      status: 'error',
      errorType:
        error instanceof GatewayError
          ? error.type
          : 'gateway_upstream_unreachable',
    })
  }
}
