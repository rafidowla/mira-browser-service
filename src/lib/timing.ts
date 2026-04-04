/**
 * timing.ts - Human-like timing configuration and delay utilities.
 *
 * Purpose: Provides the timing layer for all browser automation actions in
 * mira-browser-service. Every delay, navigation gap, and scroll amount is
 * randomised within a configurable range to produce natural, human-like
 * interaction patterns that avoid bot detection.
 *
 * Design intent: Timing is part of the trust model. Operators can inspect
 * DEFAULT_TIMING via GET /timing/defaults and understand exactly what
 * cadences MIRA uses on their accounts.
 *
 * No external I/O. Deterministic: No (Math.random). Side Effects: None.
 * Concurrency: Safe — all functions are stateless.
 */

/**
 * Inclusive range in consistent units.
 * Navigation/delay ranges are in milliseconds; inter_session_gap is in minutes.
 */
export interface TimingRange {
  /** Inclusive lower bound. */
  min: number
  /** Inclusive upper bound. */
  max: number
}

/**
 * Full timing configuration for a mira-browser-service session.
 *
 * All range fields are randomised per-call via jitter() to prevent
 * predictable bot-detectable patterns.
 */
export interface TimingConfig {
  /** Milliseconds to wait between page navigations. */
  navigation_delay: TimingRange
  /** Milliseconds to wait after page load before reading content. */
  page_read_delay: TimingRange
  /** Milliseconds to wait between individual actions on a page. */
  action_delay: TimingRange
  /** Minutes to wait between separate browser sessions. */
  inter_session_gap: TimingRange
  /** Local-time window (24h) during which sessions may run. */
  active_hours: { start: number; end: number }
  /** Number of actions to perform per session before pausing. */
  max_actions_per_session: TimingRange
  /** Pixels to scroll before reading page content. */
  scroll_amount: TimingRange
  /** Subtle mouse position randomisation to humanise cursor movement. */
  mouse_jitter: { enabled: boolean; radius: number }
}

/**
 * Default timing configuration.
 *
 * Calibrated to match typical human LinkedIn browsing patterns:
 * - Navigation gaps of 2-6 seconds
 * - Read delays of 1.5-4 seconds (simulates reading time)
 * - Sessions limited to 8-15 actions to avoid extended automated-looking runs
 * - Only runs between 08:00-20:00 local time
 */
export const DEFAULT_TIMING: TimingConfig = {
  navigation_delay:        { min: 2000, max: 6000 },
  page_read_delay:         { min: 1500, max: 4000 },
  action_delay:            { min: 800,  max: 2500 },
  inter_session_gap:       { min: 90,   max: 240  },
  active_hours:            { start: 8,  end: 20   },
  max_actions_per_session: { min: 8,    max: 15   },
  scroll_amount:           { min: 100,  max: 400  },
  mouse_jitter:            { enabled: true, radius: 5 },
}

/**
 * Returns a random integer within [range.min, range.max] inclusive.
 *
 * Purpose: Core randomisation primitive used by all delay functions.
 *
 * @param range - The inclusive min/max bounds.
 * @returns A random integer within the range.
 *
 * Deterministic: No. Side Effects: None.
 * Performance: O(1).
 */
export function jitter(range: TimingRange): number {
  return Math.floor(Math.random() * (range.max - range.min) + range.min)
}

/**
 * Returns a Promise that resolves after a randomised delay within the range.
 *
 * Purpose: Drop-in async delay used between browser actions to simulate
 * human think-time and reading latency.
 *
 * @param range - The min/max delay bounds in milliseconds.
 * @returns Promise<void> that resolves after jitter(range) milliseconds.
 *
 * Side Effects: Schedules a setTimeout; does not mutate state.
 * Deterministic: No (randomised delay duration).
 * Performance: Resolves in range.min to range.max ms.
 */
export function humanDelay(range: TimingRange): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, jitter(range)))
}

/**
 * Merges a base TimingConfig with partial overrides.
 *
 * Purpose: Allows per-profile timing customisation while keeping the
 * DEFAULT_TIMING as a safe baseline. Operators can tighten or loosen
 * individual timing windows without redefining the full config.
 *
 * @param base      - The baseline TimingConfig (typically DEFAULT_TIMING).
 * @param overrides - Partial overrides to apply on top of the base.
 * @returns A new TimingConfig with overrides applied. Base is not mutated.
 *
 * Deterministic: Yes. Side Effects: None. Concurrency: Safe.
 */
export function mergeTimingConfig(
  base: TimingConfig,
  overrides: Partial<TimingConfig>
): TimingConfig {
  return { ...base, ...overrides }
}

/**
 * Returns true if the current local hour falls within the configured
 * active_hours window (inclusive of start, exclusive of end).
 *
 * Purpose: Guards session execution so MIRA only runs during hours that
 * match natural human usage patterns for the operator's timezone.
 *
 * @param config - TimingConfig with active_hours.start and active_hours.end.
 * @returns boolean — true if current hour is within the active window.
 *
 * Deterministic: No (depends on system clock). Side Effects: None.
 */
export function isWithinActiveHours(config: TimingConfig): boolean {
  const hour = new Date().getHours()
  return hour >= config.active_hours.start && hour < config.active_hours.end
}
