import { createServer } from 'node:http'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createFetchHandler } from './app.js'
import type { AppOptions } from './app.js'

export function createNodeServer(options: AppOptions) {
  const handle = createFetchHandler(options)
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const abortController = new AbortController()
    req.on('aborted', () => abortController.abort())
    res.on('close', () => {
      if (!res.writableEnded) abortController.abort()
    })
    const headers = new Headers()
    for (const [key, value] of Object.entries(req.headers)) {
      if (Array.isArray(value)) {
        for (const item of value) headers.append(key, item)
      } else if (value !== undefined) {
        headers.set(key, value)
      }
    }
    const request = new Request(url, {
      method: req.method,
      headers,
      signal: abortController.signal,
      body:
        req.method === 'GET' || req.method === 'HEAD'
          ? undefined
          : Readable.toWeb(req) as ReadableStream<Uint8Array>,
      duplex: 'half',
    } as RequestInit)
    const response = await handle(request)
    res.statusCode = response.status
    response.headers.forEach((value, key) => res.setHeader(key, value))
    if (response.body) {
      try {
        await pipeline(Readable.fromWeb(response.body), res)
      } catch (error) {
        if (!res.destroyed) {
          res.destroy(error instanceof Error ? error : undefined)
        }
      }
    } else {
      res.end()
    }
  })
}
