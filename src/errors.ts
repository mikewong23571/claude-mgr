export type GatewayErrorType =
  | 'gateway_auth_error'
  | 'gateway_no_eligible_account'
  | 'gateway_no_eligible_token'
  | 'gateway_storage_error'
  | 'gateway_upstream_unreachable'
  | 'gateway_stream_parse_error'
  | 'gateway_validation_error'

export class GatewayError extends Error {
  readonly type: GatewayErrorType
  readonly status: number

  constructor(type: GatewayErrorType, message: string, status = 500) {
    super(message)
    this.name = 'GatewayError'
    this.type = type
    this.status = status
  }
}

export type UpstreamErrorBody = {
  type?: string
  error?: {
    type?: string
    message?: string
  }
  message?: string
}

export class UpstreamError extends Error {
  readonly status: number
  readonly requestId?: string
  readonly body: unknown
  readonly upstreamType?: string

  constructor(input: {
    status: number
    message: string
    body: unknown
    requestId?: string
    upstreamType?: string
  }) {
    super(input.message)
    this.name = 'UpstreamError'
    this.status = input.status
    this.body = input.body
    this.requestId = input.requestId
    this.upstreamType = input.upstreamType
  }
}

export function parseUpstreamErrorBody(body: unknown): {
  type?: string
  message: string
} {
  if (!body || typeof body !== 'object') {
    return { message: 'Upstream request failed' }
  }

  const candidate = body as UpstreamErrorBody
  const type = candidate.error?.type ?? candidate.type
  const message =
    candidate.error?.message ?? candidate.message ?? 'Upstream request failed'
  return { type, message }
}

export function isStorageDriverError(error: unknown): error is Error {
  if (!(error instanceof Error)) return false
  const code = (error as { code?: unknown }).code
  return code === 'ERR_SQLITE_ERROR'
}
