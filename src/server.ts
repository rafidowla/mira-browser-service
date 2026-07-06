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
import { contextManager } from './lib/context'
import type { TimingConfig } from './lib/timing'
import { getAuditLog, logAudit } from './lib/audit'
import { readFeed } from './actions/read-feed'
import { readComments } from './actions/read-comments'
import { readProfile } from './actions/read-profile'
import { readCreatorPosts } from './actions/read-creator-posts'
import { openUrl } from './actions/open-url'

// ---------------------------------------------------------------------------
// In-memory cookie store — keyed by domain.
// Populated by POST /session/cookie from the Chrome extension.
// Retrieved by Block 3.5 LinkedIn task handlers via getCookie().
// ---------------------------------------------------------------------------

const cookieStore = new Map<string, string>()

/**
 * Retrieves a stored cookie value for the given domain.
 *
 * Purpose: Used by Block 3.5 LinkedIn action handlers to inject the
 * li_at session cookie into authenticated browser requests.
 *
 * @param domain - The domain key (e.g. 'linkedin.com').
 * @returns The stored cookie value string, or undefined if not set.
 *
 * Deterministic: Yes. Side Effects: None. Concurrency: Safe (read-only).
 */
export function getCookie(domain: string): string | undefined {
  return cookieStore.get(domain)
}

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
app.post('/session/init', requireToken, (req: Request, res: Response): void => {
  const { profile_id, timing_overrides } = req.body as {
    profile_id: string
    timing_overrides?: Partial<TimingConfig>
  }
  if (!profile_id) {
    res.status(400).json({ error: 'Missing profile_id' })
    return
  }
  contextManager
    .initProfile(profile_id, timing_overrides)
    .then((ctx) => {
      res.json({ profile_id: ctx.profile_id, status: ctx.status, session_dir: ctx.session_dir })
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : 'Init failed'
      res.status(500).json({ error: message })
    })
})

/**
 * POST /session/status
 *
 * Purpose: (Stub) Return the current lifecycle status of a browser session.
 * Full implementation in Block 3.2.
 */
app.post('/session/status', requireToken, (req: Request, res: Response): void => {
  const { profile_id } = req.body as { profile_id: string }
  if (!profile_id) {
    res.status(400).json({ error: 'Missing profile_id' })
    return
  }
  const status = contextManager.getStatus(profile_id)
  res.json(status)
})

/**
 * POST /task
 *
 * Purpose: (Stub) Execute a browser automation task for a given profile.
 * Full implementation in Block 3.3.
 */
app.post('/task', requireToken, (req: Request, res: Response): void => {
  const { profile_id, action, params = {} } = req.body as TaskRequest & { params?: Record<string, unknown> }

  if (!profile_id || !action) {
    res.status(400).json({ success: false, error: 'Missing profile_id or action' })
    return
  }

  const timing = contextManager.getTimingConfig(profile_id)

  /**
   * Executes the requested action, logs to audit, and returns TaskResponse.
   * All errors caught and returned as { success: false, error }.
   */
  const execute = async (): Promise<TaskResponse> => {
    try {
      let data: unknown

      switch (action) {
        case 'read-feed': {
          const limit = typeof params.limit === 'number' ? params.limit : undefined
          data = await readFeed(profile_id, timing, limit)
          break
        }
        case 'read-comments': {
          const post_url = typeof params.post_url === 'string' ? params.post_url : ''
          const limit = typeof params.limit === 'number' ? params.limit : undefined
          if (!post_url) return { success: false, error: 'Missing params.post_url' }
          data = await readComments(profile_id, post_url, timing, limit)
          break
        }
        case 'read-profile': {
          const target_url = typeof params.target_url === 'string' ? params.target_url : ''
          if (!target_url) return { success: false, error: 'Missing params.target_url' }
          data = await readProfile(profile_id, target_url, timing)
          break
        }
        case 'read-creator-posts': {
          const creator_url = typeof params.creator_url === 'string' ? params.creator_url : ''
          const limit = typeof params.limit === 'number' ? params.limit : undefined
          if (!creator_url) return { success: false, error: 'Missing params.creator_url' }
          data = await readCreatorPosts(profile_id, creator_url, timing, limit)
          break
        }
        case 'open-url': {
          // Drafts-first execution: open the target in the operator's authenticated
          // headful window and leave it open. Navigate/read-class — no writes.
          const url = typeof params.url === 'string' ? params.url : ''
          if (!url) return { success: false, error: 'Missing params.url' }
          data = await openUrl(profile_id, url, timing)
          break
        }
        default:
          return { success: false, error: `Unknown action: ${action}` }
      }

      logAudit({ profile_id, action, result: 'success' })
      return { success: true, data }

    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      logAudit({ profile_id, action, result: 'failure', detail: message })
      return { success: false, error: message }
    }
  }

  execute().then((response) => res.json(response)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'Task error'
    res.status(500).json({ success: false, error: message })
  })
})

/**
 * GET /audit
 *
 * Purpose: (Stub) Return local audit log entries.
 * Full implementation in Block 3.4.
 */
app.get('/audit', requireToken, (_req: Request, res: Response): void => {
  const entries = getAuditLog()
  const active_profiles = contextManager.listProfiles()
  res.json({ entries, active_profiles })
})

/**
 * POST /session/cookie
 *
 * Purpose: Receives a session cookie from the MIRA Cookie Bridge Chrome
 * extension. Stores the cookie value in the in-memory cookieStore keyed
 * by domain. Block 3.5 LinkedIn action handlers retrieve it via getCookie().
 *
 * This design keeps credentials on the operator's machine and avoids
 * transmitting session cookies to any remote server.
 *
 * Body: { cookie_name: string, cookie_value: string, domain: string }
 * Returns: { received: true, domain: string }
 *
 * Side Effects: Writes to in-memory cookieStore (not persisted to disk).
 * Error Behavior: 400 if any required field is missing.
 * Deterministic: Yes. Concurrency: Safe (single-process event loop).
 */
app.post('/session/cookie', requireToken, (req: Request, res: Response): void => {
  const { cookie_name, cookie_value, domain } = req.body as {
    cookie_name: string
    cookie_value: string
    domain: string
  }

  if (!cookie_name || !cookie_value || !domain) {
    res.status(400).json({ error: 'Missing cookie_name, cookie_value, or domain' })
    return
  }

  cookieStore.set(domain, cookie_value)
  console.log(`[CookieStore] Stored ${cookie_name} for domain: ${domain} (value length: ${cookie_value.length})`)
  res.json({ received: true, domain })
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
