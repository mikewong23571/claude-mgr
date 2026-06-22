import type { Hono } from 'hono'
import { json } from '../responses.js'

export function registerHealthRoutes(app: Hono): void {
  app.get('/health', () => json({ ok: true }))
}
