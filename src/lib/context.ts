/**
 * context.ts - Multi-profile browser context manager.
 *
 * Purpose: Manages isolated Playwright BrowserContext instances per MIRA profile.
 * Each profile receives its own persistent session directory, deterministic
 * browser fingerprint, and timing configuration. A mutex ensures only one
 * profile executes actions at a time, preventing browser resource contention.
 *
 * Uses CloakBrowser (source-level fingerprint-patched Chromium) as the browser
 * engine. CloakBrowser is a drop-in Playwright replacement whose C++ patches
 * neutralise canvas/WebGL/audio fingerprinting, GPU/hardware reporting, WebRTC
 * leaks, and automation signals — a materially stronger anti-detection posture
 * than the JS-level playwright-extra + stealth plugin it replaces. Pinned to the
 * free v146 binary (see README); Pro/v148+ is not configured.
 *
 * Side Effects:
 *   - Creates ./sessions/{profile_id}/ directories on disk.
 *   - Launches Chromium browser processes (headless:false, requires display).
 *   - Maintains in-memory Map of active browser contexts.
 *
 * Deterministic: No (browser I/O). Concurrency: Mutex-protected per profile.
 */

import type { BrowserContext } from 'playwright'
import * as fs from 'fs'
import * as path from 'path'
import { DEFAULT_TIMING, mergeTimingConfig, TimingConfig, jitter } from './timing'
import { generateFingerprint } from './fingerprint'
import type { SessionStatus } from '../types'

// cloakbrowser is an ESM-only package (its exports map has no `require`
// condition). This service compiles to CommonJS, where a static `import` is
// emitted as require() and throws ERR_PACKAGE_PATH_NOT_EXPORTED against
// cloakbrowser. We load it via a genuine dynamic import() — wrapped in Function
// so TypeScript's commonjs transform doesn't rewrite it back into require().
const importCloakBrowser = new Function(
  'return import("cloakbrowser")'
) as () => Promise<typeof import('cloakbrowser')>

/**
 * Complete runtime state for a managed browser profile.
 * Stored in the ContextManager.contexts Map keyed by profile_id.
 */
export interface ProfileContext {
  /** MIRA profile identifier. */
  profile_id: string
  /** Active Playwright BrowserContext, or null if not yet initialised. */
  context: BrowserContext | null
  /** Lifecycle state of this profile session. */
  status: "uninitialised" | "active" | "idle" | "error"
  /** Absolute path to the persistent session directory on disk. */
  session_dir: string
  /** Resolved timing configuration for this profile. */
  timing_config: TimingConfig
  /** Timestamp of the last completed action, or null if never used. */
  last_active: Date | null
  /** Numeric seed derived from profile_id for fingerprint selection. */
  fingerprint_seed: number
  /** Actions completed in this session so far — see recordAction(). */
  actions_this_session: number
  /**
   * Randomised ceiling (from timing_config.max_actions_per_session) chosen
   * once when this session was launched. Once actions_this_session reaches
   * this, recordAction() signals the caller to close the session — a bounded
   * burst of activity per session, not an open-ended one.
   */
  session_action_budget: number
}

/**
 * Result of the navigation-free LinkedIn login check (getLinkedInLoginState).
 * `diagnostics` is deliberately verbose so a "still not connected" pilot
 * report is actionable (present-but-expired vs. absent cookie vs. no context)
 * instead of another round of guessing.
 */
export interface LinkedInLoginState {
  logged_in: boolean
  reason: 'no_context' | 'no_li_at' | 'cookie_expired' | 'check_error' | null
  diagnostics: {
    context_exists: boolean
    li_at_present?: boolean
    li_at_expired?: boolean
    linkedin_cookie_count?: number
    error?: string
  }
}

/** Minimal cookie shape (subset of Playwright's Cookie) needed for the login check. */
export interface LoginCookie {
  name: string
  value: string
  /** Unix seconds; -1 (or <= 0) means a session cookie with no expiry. */
  expires: number
}

/**
 * Pure evaluation of a LinkedIn cookie set into a login verdict — extracted
 * from getLinkedInLoginState so the logic (present / absent / expired) is
 * unit-testable without launching a real browser. `li_at` is LinkedIn's
 * primary auth cookie; its presence with a non-past expiry is the ground
 * truth for "logged in."
 *
 * @param cookies - Cookies for the linkedin.com domain from the context jar.
 * @param nowMs - Current time in ms (injectable for deterministic tests).
 */
export function evaluateLoginCookies(cookies: LoginCookie[], nowMs: number): LinkedInLoginState {
  const liAt = cookies.find((c) => c.name === 'li_at')
  const nowSec = nowMs / 1000
  const expired = liAt ? liAt.expires > 0 && liAt.expires < nowSec : false
  const logged_in = Boolean(liAt && liAt.value && !expired)
  return {
    logged_in,
    reason: logged_in ? null : liAt ? 'cookie_expired' : 'no_li_at',
    diagnostics: {
      context_exists: true,
      li_at_present: Boolean(liAt),
      li_at_expired: expired,
      linkedin_cookie_count: cookies.length,
    },
  }
}

/** Base session directory — all profile dirs are children of this. */
const SESSIONS_ROOT = path.join(process.cwd(), "sessions")

/**
 * Reads MIRA_ACTIVE_HOURS_START / MIRA_ACTIVE_HOURS_END from the environment
 * and validates them. Active hours are a per-OPERATOR setting, not a global
 * constant — MIRA runs entirely on each operator's own machine, in their own
 * timezone (the check itself already reads that machine's local clock; see
 * isWithinActiveHours). A single hardcoded 8am-8pm window doesn't fit every
 * operator's actual daytime — flagged 2026-07-08 when a tester in a different
 * timezone was blocked by the fixed default outside his own normal hours.
 *
 * @returns The override {start, end}, or null if unset/invalid (falls back
 *   to DEFAULT_TIMING's 8-20). Invalid values are logged, never thrown —
 *   a config typo must not crash the whole service.
 */
function resolveActiveHoursOverride(): { start: number; end: number } | null {
  const startRaw = process.env.MIRA_ACTIVE_HOURS_START
  const endRaw = process.env.MIRA_ACTIVE_HOURS_END
  if (startRaw === undefined && endRaw === undefined) return null

  const start = startRaw !== undefined ? Number(startRaw) : DEFAULT_TIMING.active_hours.start
  const end = endRaw !== undefined ? Number(endRaw) : DEFAULT_TIMING.active_hours.end
  const valid =
    Number.isInteger(start) && Number.isInteger(end) &&
    start >= 0 && start <= 24 && end >= 0 && end <= 24 && start < end
  if (!valid) {
    console.warn(
      `[ContextManager] Ignoring invalid MIRA_ACTIVE_HOURS_START/END ` +
      `("${startRaw}"/"${endRaw}") — start must be < end, both 0-24. ` +
      `Falling back to the default ${DEFAULT_TIMING.active_hours.start}-${DEFAULT_TIMING.active_hours.end}.`
    )
    return null
  }
  return { start, end }
}

/**
 * DEFAULT_TIMING with any MIRA_ACTIVE_HOURS_* environment override applied.
 * Use this instead of importing DEFAULT_TIMING directly wherever active
 * hours are checked (server.ts's gates, initProfile's no-overrides fallback)
 * so the operator's configured window is honoured consistently everywhere.
 */
export const EFFECTIVE_DEFAULT_TIMING: TimingConfig = (() => {
  const override = resolveActiveHoursOverride()
  return override ? mergeTimingConfig(DEFAULT_TIMING, { active_hours: override }) : DEFAULT_TIMING
})()

/**
 * On-disk pacing state for a profile, written on session close and read on
 * the next session/init — deliberately on disk, not just in-memory, so the
 * inter-session gap survives a service restart (Canon: a same-day burst of
 * automated sessions is exactly the pattern that got a real account tagged
 * `uc=scraping` by LinkedIn's bot detection during 2026-07-08 live testing;
 * an in-memory-only timestamp would have been silently reset by every
 * ts-node-dev restart during that same testing, providing zero protection).
 */
interface PacingState {
  /** ISO timestamp of when the previous session's browser context closed. */
  lastSessionEndedAt: string
}

function pacingStatePath(session_dir: string): string {
  return path.join(session_dir, '.mira-pacing.json')
}

/** Never throws — a missing/corrupt file just means "no prior session". */
function readPacingState(session_dir: string): PacingState | null {
  try {
    const raw = fs.readFileSync(pacingStatePath(session_dir), 'utf8')
    return JSON.parse(raw) as PacingState
  } catch {
    return null
  }
}

/** Never throws — a failed write only loses the pacing guarantee for the
 * next session, it must not crash the (already-succeeded) close operation. */
function writePacingState(session_dir: string, state: PacingState): void {
  try {
    fs.writeFileSync(pacingStatePath(session_dir), JSON.stringify(state, null, 2))
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[ContextManager] Failed to write pacing state: ${message}`)
  }
}

/**
 * ContextManager - Manages the lifecycle of per-profile browser contexts.
 *
 * Purpose: Central registry for all Playwright browser contexts in the service.
 * Enforces the MAX_PROFILES limit, gates concurrent execution via a mutex,
 * and provides status inspection without exposing raw BrowserContext objects
 * to the HTTP layer.
 *
 * State Contract:
 *   - this.contexts: Map<profile_id, ProfileContext> — source of truth.
 *   - this.activeMutex: profile_id of the currently executing profile, or null.
 *
 * Concurrency: Single-process Node.js event loop.
 *   acquireMutex is synchronous — fine for single-threaded Node; would need
 *   an async queue for true concurrent multi-worker setups.
 */
export class ContextManager {
  private contexts: Map<string, ProfileContext>
  private activeMutex: string | null
  private maxProfiles: number

  /**
   * @param maxProfiles - Maximum number of concurrent profile contexts allowed.
   *   Additional initProfile() calls beyond this limit will throw.
   */
  constructor(maxProfiles: number) {
    this.contexts = new Map()
    this.activeMutex = null
    this.maxProfiles = maxProfiles
  }

  /**
   * Initialises a browser context for the given profile.
   *
   * Purpose: Creates or returns an existing ProfileContext. If the profile
   * is already initialised (any status except error), returns it immediately
   * without launching a second browser instance.
   *
   * @param profile_id - MIRA profile identifier.
   * @param timing_overrides - Optional per-profile timing overrides.
   * @returns The resolved ProfileContext for this profile.
   *
   * Side Effects:
   *   - Creates ./sessions/{profile_id}/ directory if it does not exist.
   *   - Launches a Chromium browser process.
   *   - Writes to this.contexts Map.
   *
   * Error Behavior: On launch failure, sets status to "error" and rethrows.
   * Throws: Error if MAX_PROFILES limit would be exceeded.
   */
  async initProfile(
    profile_id: string,
    timing_overrides?: Partial<TimingConfig>
  ): Promise<ProfileContext> {
    // Return existing context if already initialised and not errored
    const existing = this.contexts.get(profile_id)
    if (existing && existing.status !== "error") {
      console.log(`[ContextManager] Profile ${profile_id} already initialised (status: ${existing.status})`)
      return existing
    }

    // Enforce max profiles limit
    const activeCount = Array.from(this.contexts.values())
      .filter((ctx) => ctx.status !== "error").length
    if (activeCount >= this.maxProfiles) {
      throw new Error(
        `MAX_PROFILES limit (${this.maxProfiles}) reached. Close a profile before adding a new one.`
      )
    }

    const session_dir = path.join(SESSIONS_ROOT, profile_id)
    fs.mkdirSync(session_dir, { recursive: true })

    const timing_config = timing_overrides
      ? mergeTimingConfig(EFFECTIVE_DEFAULT_TIMING, timing_overrides)
      : EFFECTIVE_DEFAULT_TIMING

    // Inter-session pacing gate — checked BEFORE launching, using on-disk
    // state from the PREVIOUS session's close (see PacingState above for why
    // disk, not memory). A same-day burst of back-to-back sessions is exactly
    // the usage pattern that got a real account tagged `uc=scraping` by
    // LinkedIn's bot detection (2026-07-08 live investigation, PENDING.md §2).
    const pacing = readPacingState(session_dir)
    if (pacing?.lastSessionEndedAt) {
      const lastEndedMs = new Date(pacing.lastSessionEndedAt).getTime()
      const gapMinutes = jitter(timing_config.inter_session_gap)
      const availableAtMs = lastEndedMs + gapMinutes * 60_000
      if (!Number.isNaN(lastEndedMs) && Date.now() < availableAtMs) {
        const waitMinutes = Math.ceil((availableAtMs - Date.now()) / 60_000)
        throw new Error(
          `Session pacing: the previous session for profile ${profile_id} ended too ` +
          `recently. Next session available in ~${waitMinutes} more minute(s) ` +
          `(around ${new Date(availableAtMs).toLocaleTimeString()}). This gap exists ` +
          `so MIRA never looks like a bot running back-to-back automated sessions.`
        )
      }
    }

    const fingerprint = generateFingerprint(profile_id)

    // Create a placeholder entry immediately so status is visible
    const profileCtx: ProfileContext = {
      profile_id,
      context: null,
      status: "uninitialised",
      session_dir,
      timing_config,
      last_active: null,
      fingerprint_seed: hashProfileId(profile_id),
      actions_this_session: 0,
      // Randomised once per session (not a fixed number) — see recordAction().
      session_action_budget: jitter(timing_config.max_actions_per_session),
    }
    this.contexts.set(profile_id, profileCtx)

    try {
      console.log(`[ContextManager] Launching CloakBrowser for profile ${profile_id}`)
      console.log(`[ContextManager] Session dir: ${session_dir}`)
      console.log(`[ContextManager] Fingerprint seed: ${profileCtx.fingerprint_seed} (${fingerprint.viewport.width}x${fingerprint.viewport.height} ${fingerprint.timezone_id})`)

      // CloakBrowser owns the hard fingerprint surfaces (userAgent, canvas/WebGL/
      // audio, GPU, WebRTC, automation signals) via its C++ patches, keyed off a
      // deterministic per-profile seed so the identity is stable across restarts.
      // We still set honest context-level options (viewport, locale, timezone,
      // colorScheme) — those don't contradict the patched navigator. We do NOT
      // pass a hand-rolled userAgent: a UA that disagrees with CloakBrowser's
      // patched navigator would itself be a detection signal. (generateFingerprint
      // still supplies the viewport/locale/tz tables; its user_agent field is now
      // unused here by design.)
      // NOTE: the exact CloakBrowser launch-option surface (option names, the
      // --fingerprint arg) is validated blind here — confirm on the first live
      // run against the test account (H1.4/H1.5) before the real account.
      const { launchPersistentContext } = await importCloakBrowser()
      const context = await launchPersistentContext({
        // CloakBrowser takes a single options object (userDataDir inside it),
        // unlike Playwright's (userDataDir, options) — see cloakbrowser types.
        userDataDir: session_dir,
        headless: false,
        viewport: fingerprint.viewport,
        // locale/timezone go through CloakBrowser's top-level wrapper fields,
        // which route to undetectable binary flags. Passing them via Playwright
        // context options would use detectable CDP emulation (cloakbrowser
        // strips them there for exactly this reason).
        locale: fingerprint.locale,
        timezoneId: fingerprint.timezone_id,
        colorScheme: fingerprint.color_scheme,
        // stealthArgs:false → use our deterministic per-profile --fingerprint
        // seed instead of CloakBrowser's randomized default fingerprint args, so
        // a profile's identity is stable across restarts. The C++ source-level
        // patches stay active regardless of this flag.
        stealthArgs: false,
        // humanize: CloakBrowser's own mouse/keyboard/scroll humanization —
        // vendor-tested, more sophisticated than a hand-rolled jitter (see
        // timing.ts's mouse_jitter field, intentionally superseded, not
        // separately implemented). 'careful' over 'default': this drives a
        // real operator's account, not a throwaway — bias toward the more
        // conservative preset. Added 2026-07-08 after live testing showed
        // LinkedIn's PerimeterX bot-detection tagging this session's traffic
        // pattern `uc=scraping` — see PENDING.md §2.
        humanize: true,
        humanPreset: 'careful',
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          `--fingerprint=${profileCtx.fingerprint_seed}`,
        ],
        // Binary version intentionally unset → resolves to the free v146 tier.
        // Do NOT set licenseKey/browserVersion (or the CLOAKBROWSER_LICENSE_KEY
        // / CLOAKBROWSER_VERSION env vars) without the founder's Pro decision.
      })

      profileCtx.context = context as unknown as BrowserContext
      profileCtx.status = "idle"
      console.log(`[ContextManager] Profile ${profile_id} ready`)
    } catch (error: unknown) {
      profileCtx.status = "error"
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[ContextManager] Failed to launch browser for ${profile_id}: ${message}`)
      throw error
    }

    return profileCtx
  }

  /**
   * Attempts to acquire the execution mutex for the given profile.
   *
   * Purpose: Prevents two profiles from executing browser actions simultaneously,
   * reducing resource contention and making session timing more predictable.
   *
   * @param profile_id - The profile requesting execution rights.
   * @returns true if the mutex was acquired; false if another profile holds it.
   *
   * Deterministic: Yes. Side Effects: Mutates this.activeMutex on success.
   * Concurrency: Synchronous — safe in single-threaded Node.js event loop.
   */
  acquireMutex(profile_id: string): boolean {
    if (this.activeMutex === null || this.activeMutex === profile_id) {
      this.activeMutex = profile_id
      return true
    }
    console.warn(`[ContextManager] Mutex held by ${this.activeMutex}, rejected ${profile_id}`)
    return false
  }

  /**
   * Releases the execution mutex if held by the specified profile.
   *
   * Purpose: Called by task handlers after completing an action to free the
   * mutex for other profiles.
   *
   * @param profile_id - The profile releasing execution rights.
   *
   * Side Effects: Clears this.activeMutex if called by current holder.
   * Deterministic: Yes. Concurrency: Safe in single-threaded Node.js.
   */
  releaseMutex(profile_id: string): void {
    if (this.activeMutex === profile_id) {
      this.activeMutex = null
    }
  }

  /**
   * Records that one action was completed in this profile's current session,
   * and reports whether the session's randomised action budget has now been
   * reached (in which case the caller — server.ts's /task handler — should
   * close the profile, forcing a fresh inter_session_gap wait before the next
   * one). Bounds a session to a human-like burst of activity (8-15 actions by
   * default) rather than an unbounded run.
   *
   * @param profile_id - The profile that just completed an action.
   * @returns shouldClose (budget reached or profile unknown), plus the
   *   current count/budget for logging. Safe to call for an unknown
   *   profile_id — returns shouldClose:false rather than throwing.
   *
   * Deterministic: Yes (given prior state). Side Effects: Mutates the
   * profile's actions_this_session counter.
   */
  recordAction(profile_id: string): { shouldClose: boolean; actionsThisSession: number; budget: number } {
    const profileCtx = this.contexts.get(profile_id)
    if (!profileCtx) {
      return { shouldClose: false, actionsThisSession: 0, budget: 0 }
    }
    profileCtx.actions_this_session += 1
    return {
      shouldClose: profileCtx.actions_this_session >= profileCtx.session_action_budget,
      actionsThisSession: profileCtx.actions_this_session,
      budget: profileCtx.session_action_budget,
    }
  }

  /**
   * Returns the current SessionStatus for a given profile.
   *
   * Purpose: HTTP-safe status snapshot — does not expose raw BrowserContext.
   * Returns a default uninitialised status for unknown profile IDs.
   *
   * @param profile_id - The profile to inspect.
   * @returns SessionStatus from types.ts.
   */
  getStatus(profile_id: string): SessionStatus {
    const profileCtx = this.contexts.get(profile_id)
    if (!profileCtx) {
      return { profile_id, status: "uninitialised" }
    }
    return {
      profile_id: profileCtx.profile_id,
      status: profileCtx.status,
      last_active: profileCtx.last_active?.toISOString(),
      session_dir: profileCtx.session_dir,
      fingerprint_seed: profileCtx.fingerprint_seed,
    }
  }

  /**
   * Closes the browser context for the given profile and cleans up state.
   *
   * Purpose: Graceful shutdown of a single profile. Used for resource cleanup
   * or when a profile needs to be reinitialised from a clean state.
   *
   * @param profile_id - The profile to close.
   *
   * Side Effects: Closes Playwright BrowserContext; removes from this.contexts.
   * Error Behavior: Logs errors on context.close() failure; always removes from map.
   */
  async closeProfile(profile_id: string): Promise<void> {
    const profileCtx = this.contexts.get(profile_id)
    if (!profileCtx) return

    if (profileCtx.context) {
      try {
        await profileCtx.context.close()
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        console.error(`[ContextManager] Error closing context for ${profile_id}: ${message}`)
      }
    }

    // Record when this session ended so the NEXT initProfile() call can
    // enforce the inter-session gap — on disk, so it survives a service
    // restart (see PacingState).
    writePacingState(profileCtx.session_dir, { lastSessionEndedAt: new Date().toISOString() })

    this.contexts.delete(profile_id)
    if (this.activeMutex === profile_id) {
      this.activeMutex = null
    }
    console.log(`[ContextManager] Profile ${profile_id} closed`)
  }

  /**
   * Returns the raw BrowserContext for a profile, or null if uninitialised.
   *
   * Purpose: Used by action handlers to create new pages for browser automation.
   *
   * @param profile_id - Profile to retrieve the context for.
   * @returns BrowserContext instance or null.
   *
   * Deterministic: Yes. Side Effects: None.
   */
  getContext(profile_id: string): BrowserContext | null {
    return this.contexts.get(profile_id)?.context ?? null
  }

  /**
   * Navigation-free LinkedIn login check: inspects the profile's persistent
   * cookie jar for a valid `li_at` (LinkedIn's primary auth cookie, the
   * ground truth for "is this session logged in").
   *
   * Why this exists (2026-07-11): the connection check used to piggyback on
   * read-feed — navigate to the feed, then run auth-wall detection against a
   * feed-post-container selector that the read-feed code itself notes "won't
   * reliably match even on a confirmed-rendered, logged-in feed." A slow SPA
   * render, selector drift, or LinkedIn's `uc=scraping` bot-check serving a
   * checkpoint all produced a FALSE "not connected" for a user who had in
   * fact just logged in — the exact symptom a pilot tester hit on every
   * build. Cookie presence is the authoritative signal and needs zero
   * LinkedIn navigation, so it also removes the detection surface (and the
   * action-budget/active-hours cost) of scraping the feed just to check login.
   *
   * `li_at` is HttpOnly, so `context.cookies()` (the browser cookie jar, which
   * includes HttpOnly) sees it even though page JS can't. A present-but-stale
   * `li_at` (LinkedIn invalidated it server-side while it lingers in the jar)
   * can still read logged_in:true here — that's an acceptable, far rarer
   * failure than the current false-negative, and a real scan's own auth-wall
   * detection catches the stale case at scan time.
   *
   * @param profile_id - Profile whose cookie jar to inspect.
   * @returns LinkedInLoginState with logged_in + a diagnostics bundle (so a
   *   failure is actionable in a pilot report, not another guess). Never
   *   throws — a cookie-read failure becomes logged_in:false + reason.
   *
   * Side Effects: None (reads the in-memory/on-disk cookie jar; no navigation).
   */
  async getLinkedInLoginState(profile_id: string): Promise<LinkedInLoginState> {
    const profileCtx = this.contexts.get(profile_id)
    if (!profileCtx || !profileCtx.context) {
      return { logged_in: false, reason: 'no_context', diagnostics: { context_exists: false } }
    }
    try {
      const cookies = await profileCtx.context.cookies('https://www.linkedin.com')
      return evaluateLoginCookies(cookies as LoginCookie[], Date.now())
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`[ContextManager] Login cookie check failed for ${profile_id}: ${message}`)
      return { logged_in: false, reason: 'check_error', diagnostics: { context_exists: true, error: message } }
    }
  }

  /**
   * Returns the resolved TimingConfig for a profile, or DEFAULT_TIMING if unknown.
   *
   * Purpose: Used by action handlers to apply the correct per-profile timing.
   *
   * @param profile_id - Profile to retrieve timing for.
   * @returns TimingConfig for the profile, or DEFAULT_TIMING as fallback.
   *
   * Deterministic: Yes. Side Effects: None.
   */
  getTimingConfig(profile_id: string): TimingConfig {
    return this.contexts.get(profile_id)?.timing_config ?? EFFECTIVE_DEFAULT_TIMING
  }

  /**
   * Returns the current SessionStatus for all known profiles.
   *
   * Purpose: Used by GET /audit to expose the full set of active profiles
   * to the operator without exposing internal BrowserContext state.
   *
   * @returns Array of SessionStatus for all registered profiles.
   */
  listProfiles(): SessionStatus[] {
    return Array.from(this.contexts.keys()).map((id) => this.getStatus(id))
  }
}

/**
 * djb2-style hash for generating a numeric seed from profile_id.
 * Mirrors the implementation in fingerprint.ts for consistency.
 *
 * @param input - String to hash.
 * @returns Non-negative integer seed.
 */
function hashProfileId(input: string): number {
  let hash = 5381
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash) ^ input.charCodeAt(i)
  }
  return Math.abs(hash)
}

/** Singleton ContextManager instance shared across the Express server. */
export const contextManager = new ContextManager(
  parseInt(process.env.MAX_PROFILES ?? "5", 10)
)
