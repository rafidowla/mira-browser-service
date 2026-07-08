/**
 * read-feed.ts - LinkedIn home feed reader.
 *
 * Purpose: Navigates to the LinkedIn home feed and extracts structured post data
 * using Playwright. Acquisition of the mutex ensures only one profile is active
 * at a time. All field extraction goes through the selector-registry fallback
 * chains (Canon H1.4) — missing fields return empty strings or zero rather than
 * throwing, as LinkedIn DOM changes frequently, but every field's outcome is
 * tracked so an ExtractionConfidence report can distinguish "quiet feed" from
 * "broken selector" (surfaced via /api/browser-task).
 *
 * Side Effects: Browser navigation; mutex acquisition/release; on-failure DOM
 * snapshot to local disk only (Canon H1.4 item 3).
 * Deterministic: No (live browser content). Concurrency: Mutex-protected.
 */

import type { Page } from 'playwright'
import { contextManager } from '../lib/context'
import { humanDelay, jitter, TimingConfig } from '../lib/timing'
import { extractField, FEED_POST_SELECTORS, LOGIN_CONFIRMED_MARKERS } from '../lib/selector-registry'
import { computeConfidence, shouldSnapshotOnLowConfidence, type ExtractionConfidence, type FieldOutcome } from '../lib/confidence'
import { detectAuthWall, captureFailureSnapshot, waitForPageSettled } from '../lib/read-action-support'
import type { AuthWallReason } from '../lib/auth-wall'

/** Structured representation of a single LinkedIn feed post. */
export interface FeedPost {
  /** Stable post identifier extracted from data-id or post URL. */
  post_id: string
  /** Display name of the post author. */
  author_name: string
  /** Professional headline of the author. */
  author_headline: string
  /** URL to the author's LinkedIn profile. */
  author_profile_url: string
  /** Full text content of the post. */
  content_text: string
  /** Permalink URL to the post. */
  post_url: string
  /** Number of likes/reactions. */
  likes_count: number
  /** Number of comments. */
  comments_count: number
  /** Number of reposts/shares. */
  reposts_count: number
  /** Relative or absolute time string as shown on LinkedIn. */
  posted_at: string
  /** True if the post contains an image, video, or document. */
  has_media: boolean
}

/** Result of a readFeed() invocation: extracted posts plus confidence/auth-wall state. */
export interface ReadFeedResult {
  posts: FeedPost[]
  confidence: ExtractionConfidence
  auth_wall: boolean
  auth_wall_reason: AuthWallReason
}

/** LinkedIn home feed URL. */
const FEED_URL = "https://www.linkedin.com/feed/"

/**
 * Extracts a single FeedPost from a Playwright element handle, via the
 * selector-registry fallback chains, and records each field's outcome for
 * confidence computation.
 *
 * @param page - Active Playwright page.
 * @param selector - CSS selector identifying the post container element.
 * @returns The extracted FeedPost and its per-field FieldOutcome list.
 *
 * Deterministic: No (live DOM). Side Effects: None (read-only).
 */
async function extractPost(page: Page, selector: string): Promise<{ post: FeedPost; outcomes: FieldOutcome[] }> {
  const outcomes: FieldOutcome[] = []

  const queryText = (field: string, chain: readonly string[]) =>
    extractField<string>(
      chain,
      (sel) => page.$eval(`${selector} ${sel}`, (el) => el.textContent?.trim() ?? '').catch(() => undefined),
      '',
    ).then((r) => {
      outcomes.push({ field, missing: r.missing, rank: r.rank })
      return r.value
    })

  const queryAttr = (field: string, chain: readonly string[], attr: string) =>
    extractField<string>(
      chain,
      (sel) =>
        page
          .$eval(`${selector} ${sel}`, (el, a) => (el as HTMLAnchorElement).getAttribute(a) ?? '', attr)
          .catch(() => undefined),
      '',
    ).then((r) => {
      outcomes.push({ field, missing: r.missing, rank: r.rank })
      return r.value
    })

  const post_id = await extractField<string>(
    ['data-id', 'data-urn'],
    (attr) => page.$eval(selector, (el, a) => el.getAttribute(a) ?? '', attr).catch(() => undefined),
    '',
  ).then((r) => {
    outcomes.push({ field: 'post_id', missing: r.missing, rank: r.rank })
    return r.value
  })

  const author_name = await queryText('author_name', FEED_POST_SELECTORS.author_name)
  const author_headline = await queryText('author_headline', FEED_POST_SELECTORS.author_headline)
  const author_profile_url = await queryAttr('author_profile_url', FEED_POST_SELECTORS.author_profile_url, 'href')

  const content_text = await queryText('content_text', FEED_POST_SELECTORS.content_text)

  const post_url = await queryAttr('post_url', FEED_POST_SELECTORS.post_url, 'href')
  const posted_at = await queryText('posted_at', FEED_POST_SELECTORS.posted_at)

  const socialCountsResult = await extractField<string>(
    FEED_POST_SELECTORS.social_counts,
    (sel) => page.$eval(`${selector} ${sel}`, (el) => el.textContent ?? '').catch(() => undefined),
    '',
  )
  outcomes.push({ field: 'social_counts', missing: socialCountsResult.missing, rank: socialCountsResult.rank })
  const numbers = socialCountsResult.value.match(/\d+(?:,\d+)*/g) ?? []
  const likes_count = numbers[0] ? parseInt(numbers[0].replace(/,/g, ''), 10) : 0
  const comments_count = numbers[1] ? parseInt(numbers[1].replace(/,/g, ''), 10) : 0
  const reposts_count = numbers[2] ? parseInt(numbers[2].replace(/,/g, ''), 10) : 0

  const mediaResult = await extractField<boolean>(
    FEED_POST_SELECTORS.media_marker,
    (sel) => page.$(`${selector} ${sel}`).then((el) => (el !== null ? true : undefined)).catch(() => undefined),
    false,
  )
  outcomes.push({ field: 'has_media', missing: mediaResult.missing, rank: mediaResult.rank })

  const post: FeedPost = {
    post_id,
    author_name,
    author_headline,
    author_profile_url,
    content_text,
    post_url,
    likes_count,
    comments_count,
    reposts_count,
    posted_at,
    has_media: mediaResult.value,
  }

  return { post, outcomes }
}

/**
 * Reads the LinkedIn home feed for the specified profile.
 *
 * Purpose: Primary data source for MIRA's feed monitoring. Returns up to
 * `limit` posts from the authenticated profile's feed, plus an
 * ExtractionConfidence report and explicit auth-wall state (Canon H1.4).
 * Uses human-like timing between navigation and extraction to reduce bot
 * detection signals.
 *
 * @param profile_id - MIRA profile identifier with an active browser context.
 * @param timing - TimingConfig controlling delays and scroll behaviour.
 * @param limit - Maximum posts to return (default 10).
 * @returns ReadFeedResult. Empty posts + 'none' confidence on mutex block,
 *   context error, or nav failure.
 *
 * Side Effects: Browser navigation; mutex acquire/release; console logging;
 * on-failure DOM snapshot to local disk only.
 * Deterministic: No. Error Behavior: All errors caught.
 * Concurrency: Mutex-protected; returns empty immediately if another profile active.
 */
export async function readFeed(
  profile_id: string,
  timing: TimingConfig,
  limit = 10,
): Promise<ReadFeedResult> {
  const emptyResult: ReadFeedResult = {
    posts: [],
    confidence: computeConfidence([]),
    auth_wall: false,
    auth_wall_reason: null,
  }

  const context = contextManager.getContext(profile_id)
  if (!context) {
    console.warn(`[readFeed] No context for profile ${profile_id} — call /session/init first`)
    return emptyResult
  }

  if (!contextManager.acquireMutex(profile_id)) {
    console.warn(`[readFeed] Mutex blocked for profile ${profile_id}`)
    return emptyResult
  }

  let page: Page | null = null
  try {
    page = await context.newPage() as unknown as Page
    // Bring to front — a backgrounded tab gets Chrome's reduced-priority
    // throttling (delayed timers/rendering), which can make LinkedIn's SPA
    // content take far longer to hydrate than a foregrounded tab.
    await page.bringToFront().catch(() => undefined)
    console.log(`[readFeed] Navigating to feed for profile ${profile_id}`)

    await page.goto(FEED_URL, { waitUntil: "domcontentloaded", timeout: 30000 })

    // Full fallback chain, not just container[0] — otherwise a page whose
    // posts only match selector #2/#3 misreports as an empty authed shell.
    // Also widen with LOGIN_CONFIRMED_MARKERS (LinkedIn's stable nav chrome):
    // a real logged-in session can render the nav well before feed posts
    // finish loading (ads, slow XHRs), so requiring an actual post to appear
    // before saying "not an auth wall" produced false empty_authed_shell
    // reports on a genuinely-connected account. Extraction below still uses
    // FEED_POST_SELECTORS.container only, so confidence reporting stays honest.
    // NOTE (2026-07-08 live investigation): #primary-nav specifically did NOT
    // reliably match even on a confirmed-rendered, logged-in feed with real
    // content — it's kept here as a harmless best-effort OR-clause, but treat
    // it as unverified. Root cause of that day's false empty_authed_shell
    // turned out to be LinkedIn's own bot-detection (PerimeterX tagged the
    // session `uc=scraping`), not this selector — see PENDING.md §2. Replacing
    // #primary-nav with a verified marker is H1.4 test-account work, not
    // something to guess at again blind.
    const authWallCheckSelector = [...FEED_POST_SELECTORS.container, ...LOGIN_CONFIRMED_MARKERS].join(', ')
    await waitForPageSettled(page, authWallCheckSelector)
    await humanDelay(timing.page_read_delay)

    const authWall = await detectAuthWall(page, authWallCheckSelector)
    if (authWall.auth_wall) {
      console.warn(`[readFeed] Auth wall detected for profile ${profile_id}: ${authWall.reason}`)
      await captureFailureSnapshot(page, 'read-feed', profile_id, 'auth_wall', authWall.reason ?? undefined)
      return { posts: [], confidence: computeConfidence([]), auth_wall: true, auth_wall_reason: authWall.reason }
    }

    // Human-like scroll before reading
    const scrollPx = jitter(timing.scroll_amount)
    await page.evaluate((px: number) => window.scrollBy(0, px), scrollPx)
    await humanDelay(timing.action_delay)

    // Collect post container selectors via the registry's container chain
    let postSelectors: string[] = []
    for (const containerSel of FEED_POST_SELECTORS.container) {
      postSelectors = await page.$$eval(
        containerSel,
        (els) => els
          .map((el) => {
            const id = el.getAttribute("data-id") ?? el.getAttribute("data-urn") ?? ""
            return id ? `[data-id="${id}"], [data-urn="${id}"]` : ""
          })
          .filter(Boolean)
      ).catch(() => [])
      if (postSelectors.length > 0) break
    }

    const limited = postSelectors.slice(0, limit)
    const posts: FeedPost[] = []
    const allOutcomes: FieldOutcome[][] = []

    for (const selector of limited) {
      const { post, outcomes } = await extractPost(page, selector)
      posts.push(post)
      allOutcomes.push(outcomes)
    }

    const confidence = computeConfidence(allOutcomes)
    console.log(`[readFeed] Extracted ${posts.length} posts for profile ${profile_id} (confidence: ${confidence.level})`)

    if (shouldSnapshotOnLowConfidence(confidence)) {
      await captureFailureSnapshot(page, 'read-feed', profile_id, 'low_confidence')
    }

    return { posts, confidence, auth_wall: false, auth_wall_reason: null }

  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[readFeed] Error for profile ${profile_id}: ${message}`)
    await captureFailureSnapshot(page, 'read-feed', profile_id, 'thrown_error', message)
    return emptyResult
  } finally {
    await page?.close().catch(() => undefined)
    contextManager.releaseMutex(profile_id)
  }
}
