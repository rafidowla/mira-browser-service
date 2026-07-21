/**
 * auth-wall.ts - Auth-wall / logged-out detection as a first-class result
 * state (Canon H1.4 item 4).
 *
 * Purpose: After any navigation, the browser service must be able to tell
 * "we're looking at the page we asked for" apart from three logged-out/
 * blocked shapes: (a) LinkedIn's login page, (b) a security checkpoint/
 * challenge page, or (c) an empty "authed shell" (chrome loaded, but the
 * content area LinkedIn only fills for a real session never populated).
 * MIRA's app layer (Canon H1.8, lib/reliability/scan-errors.ts) already
 * consumes an explicit `auth_wall: true` signal — this module is what
 * *produces* that signal on the browser-service side, so the app no longer
 * has to guess from error-message substrings alone.
 *
 * Pure with respect to Playwright: classification runs over plain strings
 * (URL, page title, body text, and a small set of DOM-presence flags the
 * caller has already checked) so it is unit-testable with fixture HTML/
 * strings, no live browser required. Action files gather those inputs from
 * a real `page` and hand them to `classifyAuthWall`.
 *
 * Side Effects: None. Deterministic: Yes.
 */

/** Which of the three auth-wall shapes was detected (or none). */
export type AuthWallReason = 'login_page' | 'checkpoint' | 'empty_authed_shell' | null

/** Result of classifying a navigated page for auth-wall/logged-out state. */
export interface AuthWallResult {
  /** True if any auth-wall shape was detected. */
  auth_wall: boolean
  /** Which shape, or null if the page looks like a normal authenticated page. */
  reason: AuthWallReason
}

/** Inputs gathered from the live page after navigation, used for classification. */
export interface AuthWallSignals {
  /** The page's current URL after navigation (post-redirect). */
  url: string
  /** document.title at read time. */
  title: string
  /** A slice of visible body text (lowercased comparisons are done internally). */
  bodyTextSample: string
  /** True if a login-form DOM marker (selector chain) was found on the page. */
  hasLoginFormMarker: boolean
  /** True if a checkpoint/challenge DOM marker (selector chain) was found. */
  hasChallengeMarker: boolean
  /**
   * True if the page's primary content container (the element the read
   * action is about to extract from — e.g. the feed's post list, the
   * inbox's conversation list) was present in the DOM at all. `false` here,
   * combined with everything else looking like a normal LinkedIn URL/title,
   * is the "empty authed shell" signature: the app chrome loaded but the
   * authenticated content never rendered (typical of a silently-expired
   * session that hasn't yet redirected to /login).
   */
  hasPrimaryContentContainer: boolean
}

const LOGIN_URL_MARKERS = ['/login', '/uas/login', '/authwall', 'session_redirect'] as const
const CHECKPOINT_URL_MARKERS = ['/checkpoint/', '/challenge'] as const

const LOGIN_TITLE_MARKERS = ['sign in', 'log in', 'login'] as const
const CHECKPOINT_TITLE_MARKERS = ['security verification', 'let\'s do a quick security check', 'checkpoint'] as const

const LOGIN_BODY_MARKERS = [
  'sign in to linkedin',
  'log in to linkedin',
  'welcome back',
  'new to linkedin? join now',
] as const
const CHECKPOINT_BODY_MARKERS = [
  'quick security check',
  'verify you\'re a human',
  'verify you are human',
  'unusual activity',
  'help us protect your account',
  // PerimeterX / bot-check signals. These are TEXT-based on purpose: LinkedIn
  // serves this account fully class-obfuscated (hashed classnames — PENDING
  // §3f), so the class/id checkpoint selectors can miss the challenge entirely
  // and a bot-check page then reads as a "quiet feed" (2026-07-11 detection
  // event: forced sign-out + CAPTCHA after every scan, reported as "0 posts").
  // Visible text survives class obfuscation. Chosen to not appear on a real
  // feed. NOTE: refine against the actual captured snapshot when available.
  'press & hold',
  'press and hold',
  'are you a robot',
  'complete a quick security check',
  'we detected unusual',
  'automated access',
] as const

/**
 * Classifies a navigated page as a login wall, a checkpoint/challenge page,
 * an empty authed shell, or a normal (non-auth-wall) page.
 *
 * Precedence: checkpoint > login > empty-shell. A checkpoint page can share
 * URL fragments with a login redirect chain, so checkpoint markers are
 * checked first to avoid mislabeling a security challenge as a plain login
 * prompt (the human-facing message differs — Canon H1.8 tells the user to
 * "log back in" for login_page, which would be confusing/wrong advice for a
 * challenge that requires solving a puzzle or waiting out a restriction).
 *
 * @param signals - AuthWallSignals gathered from the live page (or a test fixture).
 * @returns AuthWallResult with `auth_wall` and the specific `reason`.
 *
 * Deterministic: Yes. Side Effects: None.
 */
export function classifyAuthWall(signals: AuthWallSignals): AuthWallResult {
  const url = signals.url.toLowerCase()
  const title = signals.title.toLowerCase()
  const body = signals.bodyTextSample.toLowerCase()

  const isCheckpoint =
    signals.hasChallengeMarker ||
    CHECKPOINT_URL_MARKERS.some((m) => url.includes(m)) ||
    CHECKPOINT_TITLE_MARKERS.some((m) => title.includes(m)) ||
    CHECKPOINT_BODY_MARKERS.some((m) => body.includes(m))

  if (isCheckpoint) {
    return { auth_wall: true, reason: 'checkpoint' }
  }

  const isLoginPage =
    signals.hasLoginFormMarker ||
    LOGIN_URL_MARKERS.some((m) => url.includes(m)) ||
    LOGIN_TITLE_MARKERS.some((m) => title.includes(m)) ||
    LOGIN_BODY_MARKERS.some((m) => body.includes(m))

  if (isLoginPage) {
    return { auth_wall: true, reason: 'login_page' }
  }

  // Empty authed shell: none of the explicit login/checkpoint markers fired,
  // but the page never got the content container the read action needs.
  // Only worth flagging when the URL still looks like a LinkedIn page we
  // expected to land on (otherwise this is just "wrong URL", a different bug
  // class, not an auth-wall).
  const looksLikeLinkedIn = url.includes('linkedin.com')
  if (looksLikeLinkedIn && !signals.hasPrimaryContentContainer) {
    return { auth_wall: true, reason: 'empty_authed_shell' }
  }

  return { auth_wall: false, reason: null }
}

/** Human-facing detail strings per reason, for audit logs and error messages. */
export const AUTH_WALL_REASON_DETAIL: Record<Exclude<AuthWallReason, null>, string> = {
  login_page: 'LinkedIn returned a login page instead of the requested content — the session is logged out.',
  checkpoint: 'LinkedIn returned a security checkpoint/challenge page — manual verification is required.',
  empty_authed_shell:
    'LinkedIn returned its app shell but the expected content never rendered — likely a silently expired session.',
}
