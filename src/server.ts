/**
 * server.ts - mira-browser-service Express entry point.
 *
 * Purpose: Bootstraps the HTTP server that exposes the browser automation
 * API to the MIRA application. Binds exclusively to 127.0.0.1 to ensure
 * the service is never reachable from outside the operator's machine.
 *
 * Security:
 *   - All routes except GET /health are protected by API token middleware.
 *   - The server refuses to start if MIRA_API_TOKEN is unset or is the
 *     placeholder value from .env.example.
 *
 * Inputs:      Environment variables (PORT, MIRA_API_TOKEN, MAX_PROFILES).
 * Outputs:     HTTP responses on 127.0.0.1:PORT.
 * Side Effects: Starts an Express HTTP server; logs to stdout.
 * Deterministic: No (I/O dependent).
 * Concurrency:  Node.js event loop; single-process.
 */

import 'dotenv/config'
import express, { Request, Response, NextFunction } from 'express'
import type { TaskRequest, TaskResponse, AuditEntry, SessionStatus } from './types'
import { DEFAULT_TIMING } from './lib/timing'

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.PORT ?? '3001', 10)
const MIRA_API_TOKEN = process.env.MIRA_API_TOKEN ?? ''
const MAX_PROFILES = parseInt(process.env.MAX_PROFILES ?? '5', 10)
const VERSION = '0.1.0'
const BIND_HOST = '127.0.0.1'

// Refuse to start with the placeholder token.
if (!MIRA_API_TOKEN || MIRA_API_TOKEN === 'change-this-to-a-random-secret') {
  console.error(
    '[mira-browser-service] FATAL: MIRA_API_TOKEN is not set or is still the placeholder value.\n' +
    '  Copy .env.example to .env and set a strong random secret before starting.'
  )
  process.exit(1)
}

// ---------------------------------------------------------------------------
// App bootstrap
// ---------------------------------------------------------------------------

const app = express()

app.use(express.json())

/**
 * Request logger middleware.
 *
 * Purpose: Logs every inbound request method, path, and response status code
 * for local debugging. Does not log request bodies to avoid credential leakage.
 *
 * Side Effects: Writes to stdout.
 */
app.use((req: Request, res: Response, next: NextFunction): void => {
  const start = Date.now()
  res.on('finish', () => {
    const duration = Date.now() - start
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} -> ${res.statusCode} (${duration}ms)`)
  })
  next()
})

// ---------------------------------------------------------------------------
// Auth middleware
// ---------------------------------------------------------------------------

/**
 * API token authentication middleware.
 *
 * Purpose: Validates the X-MIRA-TOKEN header against the configured
 * MIRA_API_TOKEN. Returns 401 for missing or mismatched tokens.
 * Applied to all routes except GET /health.
 *
 * Inputs:  req.headers['x-mira-token']
 * Outputs: Calls next() on success; responds 401 on failure.
 * Deterministic: Yes.
 */
function requireToken(req: Request, res: Response, next: NextFunction): void {
  const incomingToken = req.headers['x-mira-token']

  if (!incomingToken || incomingToken !== MIRA_API_TOKEN) {
    res.status(401).json({
      error: 'Unauthorised',
      message: 'Valid X-MIRA-TOKEN header is required.',
    })
    return
  }

  next()
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * GET /timing/defaults
 *
 * Purpose: Returns the DEFAULT_TIMING configuration as JSON.
 * No auth required — transparency is part of the trust model.
 * Operators can inspect exactly what timing cadences MIRA applies
 * to their browser sessions without needing to read source code.
 *
 * Returns: DEFAULT_TIMING object (TimingConfig).
 * Side Effects: None.
 */
app.get('/timing/defaults', (_req: Request, res: Response): void => {
  res.json(DEFAULT_TIMING)
})

/**
 * GET /health
 *
 * Purpose: Liveness probe. No auth required.
 * Returns: { status: 'ok', version: string, timestamp: ISO string }
 */
app.get('/health', (_req: Request, res: Response): void => {
  res.json({
    status: 'ok',
    version: VERSION,
    timestamp: new Date().toISOString(),
  })
})

/**
 * POST /session/init
 *
 * Purpose: (Stub) Initialise a browser context for the given profile.
 * Full implementation in Block 3.2.
 */
app.post('/session/init', requireToken, (_req: Request, res: Response): void => {
  res.json({ status: 'not_implemented' })
})

/**
 * POST /session/status
 *
 * Purpose: (Stub) Return the current lifecycle status of a browser session.
 * Full implementation in Block 3.2.
 */
app.post('/session/status', requireToken, (_req: Request, res: Response): void => {
  const _placeholder: Partial<SessionStatus> = {}
  void _placeholder
  res.json({ status: 'not_implemented' })
})

/**
 * POST /task
 *
 * Purpose: (Stub) Execute a browser automation task for a given profile.
 * Full implementation in Block 3.3.
 */
app.post('/task', requireToken, (req: Request, res: Response): void => {
  const _body = req.body as TaskRequest
  void _body
  const response: TaskResponse = {
    success: false,
    error: 'not_implemented',
  }
  res.json(response)
})

/**
 * GET /audit
 *
 * Purpose: (Stub) Return local audit log entries.
 * Full implementation in Block 3.4.
 */
app.get('/audit', requireToken, (_req: Request, res: Response): void => {
  const entries: AuditEntry[] = []
  res.json({ entries })
})

// ---------------------------------------------------------------------------
// 404 catch-all
// ---------------------------------------------------------------------------

app.use((_req: Request, res: Response): void => {
  res.status(404).json({ error: 'Not found' })
})

// ---------------------------------------------------------------------------
// Server startup
// ---------------------------------------------------------------------------

app.listen(PORT, BIND_HOST, () => {
  console.log(`mira-browser-service v${VERSION} running on http://${BIND_HOST}:${PORT}`)
  console.log('Accepting connections from localhost only')
  console.log(`MAX_PROFILES: ${MAX_PROFILES}`)
})

export default app
