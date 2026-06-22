import { randomUUID } from 'node:crypto'
import type { SelectedCredential } from '../domain/types.js'
import { GatewayError } from '../errors.js'
import type { SqliteStore } from '../storage/sqlite-store.js'

export type ResolveCredentialInput = {
  localClientId: string
  poolId?: string
  sessionId?: string
  requiredScope?: string | null
  nowMs?: number
}

export class AccountRouter {
  constructor(private readonly store: SqliteStore) {}

  resolveCredential(input: ResolveCredentialInput): SelectedCredential {
    const client = this.store.getLocalClient(input.localClientId)
    if (!client.enabled) {
      throw new GatewayError(
        'gateway_auth_error',
        `Local client is disabled: ${input.localClientId}`,
        401,
      )
    }
    const poolId = input.poolId ?? client.defaultPoolId ?? null
    const requiredScope =
      input.requiredScope === undefined ? 'user:inference' : input.requiredScope
    const eligibleAccounts = this.store.listEligibleAccountRows({ poolId })
    if (eligibleAccounts.length === 0) {
      throw new GatewayError(
        'gateway_no_eligible_account',
        poolId
          ? `No enabled Claude account is available in pool ${poolId}`
          : 'No enabled Claude account is available',
        409,
      )
    }

    const binding = input.sessionId
      ? this.store.findMessageSessionBinding({
          localClientId: input.localClientId,
          poolId,
          inboundSessionId: input.sessionId,
        })
      : null
    if (binding) {
      const accountIsEligible = eligibleAccounts.some(
        row => row.account.accountUuid === binding.accountUuid,
      )
      if (!accountIsEligible || this.isQuotaBlocked(binding.accountUuid, input.nowMs)) {
        throw new GatewayError(
          'gateway_no_eligible_account',
          `Message session is bound to unavailable Claude account ${binding.accountUuid}`,
          409,
        )
      }
      const selected = this.store
        .listEligibleTokenRows({
        poolId,
          requiredScope,
          nowMs: input.nowMs,
        })
        .find(candidate => candidate.account.accountUuid === binding.accountUuid)
      if (!selected) {
        throw new GatewayError(
          'gateway_no_eligible_token',
          requiredScope
            ? `Message session is bound to Claude account ${binding.accountUuid}, but no OAuth token with ${requiredScope} is available`
            : `Message session is bound to Claude account ${binding.accountUuid}, but no OAuth token is available`,
          409,
        )
      }
      this.store.markTokenUsed(selected.token.label, input.nowMs)
      this.store.touchMessageSessionBinding({
        localClientId: input.localClientId,
        poolId,
        inboundSessionId: binding.inboundSessionId,
        usedAt: input.nowMs,
      })
      return {
        ...selected,
        upstreamSessionId: binding.upstreamSessionId,
      }
    }

    const candidates = this.store.listEligibleTokenRows({
      poolId,
      requiredScope,
      nowMs: input.nowMs,
    })

    const eligibleCandidates = candidates.filter(
      candidate => !this.isQuotaBlocked(candidate.account.accountUuid, input.nowMs),
    )

    if (eligibleCandidates.length === 0) {
      throw new GatewayError(
        'gateway_no_eligible_token',
        requiredScope
          ? `No OAuth token with ${requiredScope} is available`
          : 'No OAuth token is available',
        409,
      )
    }

    const selected = eligibleCandidates[0]
    this.store.markTokenUsed(selected.token.label, input.nowMs)
    if (!input.sessionId) return selected

    const bindingCreatedAt = input.nowMs ?? Date.now()
    const createdBinding = this.store.upsertMessageSessionBinding({
      localClientId: input.localClientId,
      poolId,
      inboundSessionId: input.sessionId,
      accountUuid: selected.account.accountUuid,
      upstreamSessionId: randomUUID(),
      nowMs: bindingCreatedAt,
    })
    return {
      ...selected,
      upstreamSessionId: createdBinding.upstreamSessionId,
    }
  }

  private isQuotaBlocked(accountUuid: string, nowMs?: number): boolean {
    const snapshot = this.store.getLatestQuotaSnapshot(accountUuid)
    if (!snapshot || snapshot.status !== 'rejected') {
      return false
    }
    if (!snapshot.resetsAt) {
      return true
    }
    return snapshot.resetsAt > (nowMs ?? Date.now())
  }
}
