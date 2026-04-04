/**
 * fingerprint.ts - Deterministic per-profile browser fingerprint generator.
 *
 * Purpose: Generates a stable, realistic browser fingerprint for each profile.
 * The same profile_id always produces the same fingerprint so sessions remain
 * consistent across restarts. Fingerprints are seeded from the profile_id string,
 * not random, to ensure repeatability without storing fingerprint state.
 *
 * Design: Uses a simple djb2-style string hash as a deterministic seed, then
 * selects from curated pools of realistic viewport sizes, user agents, and
 * timezones that match common enterprise LinkedIn users.
 *
 * No external I/O. Deterministic: Yes (same input -> same output).
 * Side Effects: None. Concurrency: Thread-safe (pure function).
 */

/**
 * Complete browser fingerprint for a managed browser profile.
 * All values are selected to match genuine enterprise Chrome users.
 */
export interface BrowserFingerprint {
  /** Browser viewport dimensions in pixels. */
  viewport: { width: number; height: number }
  /** Full Chrome user-agent string matching the viewport profile. */
  user_agent: string
  /** Browser locale — always en-US for consistency. */
  locale: string
  /** IANA timezone identifier. */
  timezone_id: string
  /** Preferred color scheme. */
  color_scheme: "light" | "dark"
}

/** Realistic viewport sizes covering the most common enterprise desktop resolutions. */
const VIEWPORTS: Array<{ width: number; height: number }> = [
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
  { width: 1536, height: 864 },
  { width: 1920, height: 1080 },
  { width: 1280, height: 800 },
]

/** Realistic Chrome user-agent strings for Windows and macOS enterprise users. */
const USER_AGENTS: string[] = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 11.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
]

/** Common US business timezones to match typical LinkedIn professional users. */
const TIMEZONES: string[] = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Phoenix",
]

/**
 * Computes a deterministic numeric seed from a string using djb2 hashing.
 *
 * @param input - The string to hash (typically a profile_id UUID).
 * @returns A non-negative 32-bit integer seed value.
 *
 * Deterministic: Yes. Side Effects: None. Performance: O(n) on input length.
 */
function hashString(input: string): number {
  let hash = 5381
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash) ^ input.charCodeAt(i)
  }
  return Math.abs(hash)
}

/**
 * Generates a deterministic browser fingerprint for the given profile.
 *
 * Purpose: Ensures each profile has a stable, consistent browser identity
 * across service restarts. The fingerprint is derived entirely from the
 * profile_id — no external state is required.
 *
 * @param profile_id - The MIRA profile identifier (typically a UUID).
 * @returns BrowserFingerprint with viewport, user agent, locale, timezone,
 *   and color scheme deterministically selected for this profile.
 *
 * Deterministic: Yes — same profile_id always returns the same fingerprint.
 * Side Effects: None. Performance: O(n) on profile_id length.
 */
export function generateFingerprint(profile_id: string): BrowserFingerprint {
  const seed = hashString(profile_id)

  const viewport = VIEWPORTS[seed % VIEWPORTS.length]
  const user_agent = USER_AGENTS[seed % USER_AGENTS.length]
  const timezone_id = TIMEZONES[seed % TIMEZONES.length]
  const color_scheme: "light" | "dark" = seed % 3 === 0 ? "dark" : "light"

  return {
    viewport,
    user_agent,
    locale: "en-US",
    timezone_id,
    color_scheme,
  }
}
