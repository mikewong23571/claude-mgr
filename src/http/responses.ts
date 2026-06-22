import { GatewayError, UpstreamError, isStorageDriverError } from '../errors.js'
import type { SqliteStore } from '../storage/sqlite-store.js'

export function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: {
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  })
}

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  const body = (await request.json()) as unknown
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new GatewayError(
      'gateway_validation_error',
      'JSON request body must be an object',
      400,
    )
  }
  return body as Record<string, unknown>
}

export function requireStore(store: SqliteStore | undefined): SqliteStore {
  if (!store) {
    throw new GatewayError(
      'gateway_storage_error',
      'This route requires a configured store',
      500,
    )
  }
  return store
}

export function errorResponse(error: unknown): Response {
  if (error instanceof GatewayError) {
    return json(
      {
        error: {
          type: error.type,
          message: error.message,
          upstream_request_id: null,
        },
      },
      { status: error.status },
    )
  }
  if (error instanceof UpstreamError) {
    return json(
      {
        error: {
          type: error.upstreamType,
          message: error.message,
          upstream_request_id: error.requestId ?? null,
        },
      },
      { status: error.status },
    )
  }
  if (isStorageDriverError(error)) {
    return json(
      {
        error: {
          type: 'gateway_storage_error',
          message: `SQLite storage operation failed: ${error.message}`,
          upstream_request_id: null,
        },
      },
      { status: 500 },
    )
  }
  return json(
    {
      error: {
        type: 'gateway_upstream_unreachable',
        message: error instanceof Error ? error.message : 'Unexpected error',
        upstream_request_id: null,
      },
    },
    { status: 502 },
  )
}

export function notFoundResponse(): Response {
  return json(
    {
      error: {
        type: 'gateway_validation_error',
        message: 'Route not found',
        upstream_request_id: null,
      },
    },
    { status: 404 },
  )
}
