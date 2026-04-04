/**
 * context.ts - Multi-profile browser context manager.
 *
 * Purpose: Manages isolated Playwright BrowserContext instances per MIRA profile.
 * Each profile receives its own persistent session directory, deterministic
 * browser fingerprint, and timing configuration. A mutex ensures only one
 * profile executes actions at a time, preventing browser resource contention.
 *
 * Uses playwright-extra with the stealth plugin to reduce bot-detection signals.
 *
 * Side Effects:
 *   - Creates ./sessions/{profile_id}/ directories on disk.
 *   - Launches Chromium browser processes (headless:false, requires display).
 *   - Maintains in-memory Map of active browser contexts.
 *
 * Deterministic: No (browser I/O). Concurrency: Mutex-protected per profile.
 */

import { chromium } from 'playwright-extra'
import type { BrowserContext } from 'playwright'
import * as fs from 'fs'
import * as path from 'path'
import { DEFAULT_TIMING, mergeTimingConfig, TimingConfig } from './timing'
import { generateFingerprint } from './fingerprint'
import type { SessionStatus } from '../types'

// stealth plugin: CJS default export — use require for safe interop
// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
const StealthPlugin = require("puppeteer-extra-plugin-stealth") as any
chromium.use(StealthPlugin())

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
}

/** Base session directory — all profile dirs are children of this. */
const SESSIONS_ROOT = path.join(process.cwd(), "sessions")

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
      ? mergeTimingConfig(DEFAULT_TIMING, timing_overrides)
      : DEFAULT_TIMING

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
    }
    this.contexts.set(profile_id, profileCtx)

    try {
      console.log(`[ContextManager] Launching browser for profile ${profile_id}`)
      console.log(`[ContextManager] Session dir: ${session_dir}`)
      console.log(`[ContextManager] Fingerprint: ${fingerprint.viewport.width}x${fingerprint.viewport.height} ${fingerprint.timezone_id}`)

      const context = await chromium.launchPersistentContext(session_dir, {
        headless: false,
        viewport: fingerprint.viewport,
        userAgent: fingerprint.user_agent,
        locale: fingerprint.locale,
        timezoneId: fingerprint.timezone_id,
        colorScheme: fingerprint.color_scheme,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-blink-features=AutomationControlled",
        ],
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
    return this.contexts.get(profile_id)?.timing_config ?? DEFAULT_TIMING
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
