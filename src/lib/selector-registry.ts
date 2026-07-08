/**
 * selector-registry.ts - Central per-field selector fallback chains for all
 * LinkedIn read actions (Canon H1.4).
 *
 * Purpose: LinkedIn's DOM changes without notice and was never validated live
 * (Canon §3/§4 H1.4 — "written blind"). Rather than each action file hard-coding
 * a single inline selector per field, every field's extraction strategy lives
 * here as an ORDERED list of CSS selectors to try in turn: rank 0 is today's
 * best-effort guess, ranks 1+ are plausible alternates seeded ahead of live
 * tuning. When live-DOM tuning (the human-in-the-loop part of H1.4, driven by
 * the founder against the test account — see Canon I-5) finds a broken or
 * reordered selector, the fix is a one-line edit to a chain HERE, not a hunt
 * through five action files.
 *
 * This module is pure with respect to Playwright: it takes a caller-supplied
 * "query" function (`FieldQuery`) so its fallback-selection and confidence
 * logic can be unit-tested with plain fixtures/fakes — no live browser, no
 * Playwright import — while action files supply a real `page.$eval`-backed
 * query at runtime.
 *
 * Side Effects: None. Deterministic: Yes (given a deterministic query fn).
 */

/**
 * A single field's extraction result from trying its selector chain.
 * `rank` is the index into the chain that finally produced a non-empty
 * value (or -1 if every selector in the chain came back empty/failed).
 */
export interface FieldExtractionResult<T> {
  /** The extracted value (or the type's "empty" sentinel if all selectors missed). */
  value: T
  /** Index of the selector chain entry that produced `value`; -1 if none did. */
  rank: number
  /** True if every selector in the chain was tried and none produced a value. */
  missing: boolean
}

/**
 * Caller-supplied lookup function: given one CSS selector, return the
 * extracted value or `undefined`/empty-equivalent if the selector matched
 * nothing (or matched but had no usable content). Action files implement
 * this over `page.$eval`; tests implement it over a plain fixture map.
 */
export type FieldQuery<T> = (selector: string) => Promise<T | undefined>

/**
 * Determines whether an extracted candidate should count as "found" for
 * fallback-chain purposes. Strings must be non-empty after trim; numbers
 * must not be NaN; booleans and other values are always accepted once
 * defined (a selector that resolves to `false` is still a real finding,
 * e.g. `is_reply: false`).
 */
function isPresent<T>(value: T | undefined): value is T {
  if (value === undefined || value === null) return false
  if (typeof value === 'string') return value.trim().length > 0
  if (typeof value === 'number') return !Number.isNaN(value)
  return true
}

/**
 * Tries each selector in `chain`, in order, via `query`, and returns the
 * first present value along with the rank (chain index) it was found at.
 *
 * @param chain - Ordered CSS selector fallback chain for one field.
 * @param query - Lookup function (real DOM query or test fixture).
 * @param emptyValue - Sentinel returned when every selector misses.
 *
 * Deterministic: Given a deterministic `query`, yes. Side Effects: None
 * beyond whatever `query` does (a real query is read-only DOM access).
 */
export async function extractField<T>(
  chain: readonly string[],
  query: FieldQuery<T>,
  emptyValue: T,
): Promise<FieldExtractionResult<T>> {
  for (let rank = 0; rank < chain.length; rank++) {
    let candidate: T | undefined
    try {
      candidate = await query(chain[rank])
    } catch {
      candidate = undefined
    }
    if (isPresent(candidate)) {
      return { value: candidate, rank, missing: false }
    }
  }
  return { value: emptyValue, rank: -1, missing: true }
}

// ─── Per-action selector chains ─────────────────────────────────────────────
//
// Rank 0 = the pre-H1.4 best-effort selector already shipped. Rank 1+ are
// plausible alternates seeded for this task; live tuning against the test
// account (Canon I-5, H1.9) will re-order/replace/extend these based on what
// actually renders. Container selectors (used to enumerate items on a list
// page) are kept alongside field chains for the same action.

/** Selector chains for one LinkedIn feed post (readFeed). */
export const FEED_POST_SELECTORS = {
  /** Container selectors used to find each post's root element on the feed. */
  container: [
    'div.feed-shared-update-v2[data-id]',
    'div[data-id^="urn:li:activity:"]',
    'div[data-urn^="urn:li:activity:"]',
  ] as const,
  author_name: [
    '.update-components-actor__name span[aria-hidden="true"]',
    '.update-components-actor__name',
    '.update-components-actor__title span[aria-hidden="true"]',
  ] as const,
  author_headline: [
    '.update-components-actor__description span[aria-hidden="true"]',
    '.update-components-actor__description',
  ] as const,
  author_profile_url: [
    '.update-components-actor__meta a',
    '.update-components-actor__container a[href*="/in/"]',
  ] as const,
  content_text: [
    '.feed-shared-update-v2__description span[dir="ltr"]',
    '.update-components-text span[dir="ltr"]',
    '.update-components-update-v2__commentary span[dir="ltr"]',
  ] as const,
  post_url: [
    'a[href*="/feed/update/"]',
    'a.app-aware-link[href*="/posts/"]',
  ] as const,
  posted_at: [
    '.update-components-actor__sub-description span[aria-hidden="true"]',
    '.update-components-actor__sub-description',
  ] as const,
  social_counts: [
    '.social-details-social-counts',
    '.social-details-social-counts__social-proof-text',
  ] as const,
  media_marker: [
    '.update-components-image, .update-components-video, .document-s-container',
    '.update-components-linkedin-video, .feed-shared-external-video__container',
  ] as const,
} as const

/** Selector chains for one comment on a post (readComments). */
export const COMMENT_SELECTORS = {
  container: [
    '.comments-comment-item',
    '.comments-comment-entity',
  ] as const,
  author_name: [
    '.comments-post-meta__name span[aria-hidden="true"]',
    '.comments-post-meta__name',
  ] as const,
  author_headline: [
    '.comments-post-meta__headline',
    '.comments-post-meta__headline-text',
  ] as const,
  author_profile_url: [
    '.comments-post-meta__name a',
    '.comments-post-meta__actor-link',
  ] as const,
  comment_text: [
    '.comments-comment-item__main-content',
    '.comments-comment-item-content-body',
  ] as const,
  likes_count: [
    '.comments-comment-social-bar__reactions-count',
    '.comments-comment-social-bar__reaction-count',
  ] as const,
  posted_at: [
    '.comments-comment-item__timestamp',
    '.comments-comment-meta__timestamp',
  ] as const,
} as const

/** Selector chains for a public profile page (readProfile). */
export const PROFILE_SELECTORS = {
  full_name: [
    '.text-heading-xlarge',
    'h1.top-card-layout__title',
    'h1[class*="inline t-24"]',
  ] as const,
  headline: [
    '.text-body-medium.break-words',
    '.top-card-layout__headline',
  ] as const,
  location: [
    '.text-body-small.inline.t-black--light.break-words',
    '.top-card__subline-item',
  ] as const,
  about: [
    '#about ~ .pvs-list__outer-container .visually-hidden',
    'section.summary .core-section-container__content .visually-hidden',
  ] as const,
  current_company: [
    '.pv-text-details__right-panel .inline-show-more-text',
    '.top-card-layout__second-subline a',
  ] as const,
  current_role: [
    '.experience-section .pv-entity__summary-info h3',
    '.pvs-list__item--line-separated .display-flex.align-items-center span[aria-hidden="true"]',
  ] as const,
  connection_degree: [
    '.dist-value',
    '.top-card-layout__headline .dist-value',
  ] as const,
  follower_count: [
    '.pvs-header__subtitle span',
    '.top-card__subline-item:has-text("followers")',
  ] as const,
} as const

/** Selector chains for a creator's recent-activity post (readCreatorPosts). */
export const CREATOR_POST_SELECTORS = {
  container: [
    'div.feed-shared-update-v2[data-id]',
    'div[data-id]',
  ] as const,
  content_text: [
    '.feed-shared-update-v2__description span[dir="ltr"]',
    '.update-components-text span[dir="ltr"]',
  ] as const,
  post_url: [
    'a[href*="/feed/update/"]',
    'a.app-aware-link[href*="/posts/"]',
  ] as const,
  posted_at: [
    '.update-components-actor__sub-description span[aria-hidden="true"]',
    '.update-components-actor__sub-description',
  ] as const,
  social_counts: [
    '.social-details-social-counts',
    '.social-details-social-counts__social-proof-text',
  ] as const,
  media_marker: [
    '.update-components-image, .update-components-video, .document-s-container',
    '.update-components-linkedin-video, .feed-shared-external-video__container',
  ] as const,
} as const

/** Selector chains for one conversation row in the messaging inbox (readInbox). */
export const INBOX_SELECTORS = {
  container: [
    'li.msg-conversation-listitem',
    'li.msg-conversation-card',
  ] as const,
  conversation_link: [
    'a.msg-conversation-listitem__link',
    'a.msg-conversation-card__link',
  ] as const,
  participant_name: [
    '.msg-conversation-listitem__participant-names',
    '.msg-conversation-card__participant-names',
  ] as const,
  headline: [
    '.msg-conversation-card__message-snippet-body',
    '.msg-conversation-listitem__annotation',
  ] as const,
  last_message_snippet: [
    '.msg-conversation-card__message-snippet',
    '.msg-conversation-listitem__message-snippet',
  ] as const,
  last_at: [
    '.msg-conversation-listitem__time-stamp',
    '.msg-conversation-card__time-stamp',
  ] as const,
} as const

/**
 * Auth-wall / logged-out DOM markers, kept here (not in auth-wall.ts) as they
 * are also selector chains subject to the same live-tuning workflow — see
 * auth-wall.ts for the classification logic that consumes these.
 */
export const AUTH_WALL_SELECTORS = {
  login_form: [
    'form.login__form',
    '#login-form',
    'input#username',
  ] as const,
  checkpoint_challenge: [
    '#challenge-form',
    '.challenge-dialog',
    'div[data-test-id="challenge-page"]',
  ] as const,
} as const

/**
 * LinkedIn's persistent logged-in site chrome (nav bar), confirmed present
 * (as `#primary-nav`) on a real authenticated session even when a page's own
 * content selectors (e.g. FEED_POST_SELECTORS.container) haven't matched yet
 * or are stale against current markup. Used ONLY to widen auth-wall
 * classification's "is there real content" check — never as a substitute for
 * the real per-action content selectors used for actual data extraction, so
 * extraction-confidence reporting stays honest about what was actually
 * extracted (Canon H1.4). This is what lets "are we logged in" stay reliable
 * independent of feed/profile/inbox selector drift.
 */
export const LOGIN_CONFIRMED_MARKERS = ['#primary-nav'] as const
