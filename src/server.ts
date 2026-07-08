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
import { mergeTimingConfig, isWithinActiveHours } from './lib/timing'
import { contextManager, EFFECTIVE_DEFAULT_TIMING } from './lib/context'
import type { TimingConfig } from './lib/timing'
import { getAuditLog, logAudit } from './lib/audit'
import { readFeed } from './actions/read-feed'
import { readComments } from './actions/read-comments'
import { readProfile } from './actions/read-profile'
import { readCreatorPosts } from './actions/read-creator-posts'
import { openUrl } from './actions/open-url'
import { readInbox } from './actions/read-inbox'
import type { ExtractionConfidence } from './lib/confidence'
import type { AuthWallReason } from './lib/auth-wall'
import { AUTH_WALL_REASON_DETAIL } from './lib/auth-wall'

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
 * Purpose: Returns the EFFECTIVE default timing configuration as JSON —
 * DEFAULT_TIMING with any MIRA_ACTIVE_HOURS_* env override applied, so an
 * operator sees the window that's actually in force, not just the code
 * default. No auth required — transparency is part of the trust model.
 *
 * Returns: EFFECTIVE_DEFAULT_TIMING object (TimingConfig).
 * Side Effects: None.
 */
app.get('/timing/defaults', (_req: Request, res: Response): void => {
  res.json(EFFECTIVE_DEFAULT_TIMING)
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

/** Human-facing message for the active-hours gate, shared by both routes below. */
function activeHoursMessage(timing: TimingConfig): string {
  return (
    `Outside active hours (${timing.active_hours.start}:00–${timing.active_hours.end}:00 local). ` +
    `MIRA only runs LinkedIn automation during normal daytime hours to avoid an inhuman usage pattern.`
  )
}

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

  // Active-hours gate, checked BEFORE launching — a session starting outside
  // normal daytime hours is itself an automation tell, independent of what
  // happens once the browser is open.
  const effectiveTiming = timing_overrides ? mergeTimingConfig(EFFECTIVE_DEFAULT_TIMING, timing_overrides) : EFFECTIVE_DEFAULT_TIMING
  if (!isWithinActiveHours(effectiveTiming)) {
    res.status(403).json({ error: activeHoursMessage(effectiveTiming) })
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
 * Builds the common TaskResponse shape for a read action, given its extracted
 * items, ExtractionConfidence report, and auth-wall state (Canon H1.4).
 *
 * Purpose: All five read actions (read-feed, read-comments, read-profile,
 * read-creator-posts, read-inbox) now return { items, confidence, auth_wall,
 * auth_wall_reason } from their action module; this shared helper turns that
 * into the TaskResponse the app expects, logging the audit entry and — on an
 * explicit auth-wall — returning success: false with the wall surfaced as a
 * first-class field so /api/browser-task can act on it (Canon H1.8) without
 * having to guess from an error-message substring.
 *
 * @param profile_id - MIRA profile the action ran for (audit logging).
 * @param action - Action name (audit logging).
 * @param data - The action's extracted items/object payload.
 * @param confidence - ExtractionConfidence report for this invocation.
 * @param auth_wall - True if an auth-wall was detected during this invocation.
 * @param auth_wall_reason - Which auth-wall shape, when auth_wall is true.
 * @returns TaskResponse ready to send to the client.
 *
 * Side Effects: Writes one AuditEntry via logAudit(). Deterministic: Yes
 * (given deterministic inputs). Network: None.
 */
function finishReadAction(
  profile_id: string,
  action: string,
  data: unknown,
  confidence: ExtractionConfidence,
  auth_wall: boolean,
  auth_wall_reason: AuthWallReason,
): TaskResponse {
  if (auth_wall) {
    const detail = auth_wall_reason ? AUTH_WALL_REASON_DETAIL[auth_wall_reason] : 'Auth wall detected.'
    logAudit({ profile_id, action, result: 'failure', detail: `auth_wall:${auth_wall_reason} - ${detail}` })
    return {
      success: false,
      error: detail,
      auth_wall: true,
      auth_wall_reason,
      confidence,
    }
  }

  logAudit({ profile_id, action, result: 'success' })
  return { success: true, data, confidence, auth_wall: false, auth_wall_reason: null }
}

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

  // Active-hours gate — a task running outside normal daytime hours is an
  // automation tell on its own, regardless of which action it is.
  if (!isWithinActiveHours(timing)) {
    res.status(403).json({ success: false, error: activeHoursMessage(timing) })
    return
  }

  /**
   * Executes the requested action, logs to audit, and returns TaskResponse.
   * All errors caught and returned as { success: false, error }.
   */
  const execute = async (): Promise<TaskResponse> => {
    try {
      switch (action) {
        case 'read-feed': {
          const limit = typeof params.limit === 'number' ? params.limit : undefined
          const result = await readFeed(profile_id, timing, limit)
          return finishReadAction(profile_id, action, result.posts, result.confidence, result.auth_wall, result.auth_wall_reason)
        }
        case 'read-comments': {
          const post_url = typeof params.post_url === 'string' ? params.post_url : ''
          const limit = typeof params.limit === 'number' ? params.limit : undefined
          if (!post_url) return { success: false, error: 'Missing params.post_url' }
          const result = await readComments(profile_id, post_url, timing, limit)
          return finishReadAction(profile_id, action, result.comments, result.confidence, result.auth_wall, result.auth_wall_reason)
        }
        case 'read-profile': {
          const target_url = typeof params.target_url === 'string' ? params.target_url : ''
          if (!target_url) return { success: false, error: 'Missing params.target_url' }
          const result = await readProfile(profile_id, target_url, timing)
          return finishReadAction(profile_id, action, result.profile, result.confidence, result.auth_wall, result.auth_wall_reason)
        }
        case 'read-creator-posts': {
          const creator_url = typeof params.creator_url === 'string' ? params.creator_url : ''
          const limit = typeof params.limit === 'number' ? params.limit : undefined
          if (!creator_url) return { success: false, error: 'Missing params.creator_url' }
          const result = await readCreatorPosts(profile_id, creator_url, timing, limit)
          return finishReadAction(profile_id, action, result.posts, result.confidence, result.auth_wall, result.auth_wall_reason)
        }
        case 'open-url': {
          // Drafts-first execution: open the target in the operator's authenticated
          // headful window and leave it open. Navigate/read-class — no writes.
          const url = typeof params.url === 'string' ? params.url : ''
          if (!url) return { success: false, error: 'Missing params.url' }
          const data = await openUrl(profile_id, url, timing)
          logAudit({ profile_id, action, result: 'success' })
          return { success: true, data }
        }
        case 'read-inbox': {
          // Reads the operator's OWN LinkedIn messaging inbox. Safest possible
          // read (own data), but still on-demand/button-triggered only — see
          // build plan §3 tripwire and §6 "Inbound — inbox triage".
          const limit = typeof params.limit === 'number' ? params.limit : undefined
          const result = await readInbox(profile_id, timing, limit)
          return finishReadAction(profile_id, action, result.conversations, result.confidence, result.auth_wall, result.auth_wall_reason)
        }
        default:
          return { success: false, error: `Unknown action: ${action}` }
      }

    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      logAudit({ profile_id, action, result: 'failure', detail: message })
      return { success: false, error: message }
    }
  }

  execute().then((response) => {
    // Bound the session to a human-like burst of activity (Canon: an
    // unbounded run of automated actions is itself a detection signal).
    // Every task counts, success or auth-wall/failure — each one drove a
    // real browser navigation. Once the session's randomised budget is hit,
    // close it; the next initProfile() then enforces the inter-session gap.
    const pacing = contextManager.recordAction(profile_id)
    if (pacing.shouldClose) {
      console.log(
        `[server] Profile ${profile_id} reached its session action budget ` +
        `(${pacing.actionsThisSession}/${pacing.budget}) — closing for pacing.`
      )
      contextManager.closeProfile(profile_id).catch((error: unknown) => {
        console.error(`[server] Failed to auto-close ${profile_id} for pacing: ${error instanceof Error ? error.message : String(error)}`)
      })
      res.json({ ...response, session_closed_for_pacing: true })
      return
    }
    res.json(response)
  }).catch((error: unknown) => {
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
