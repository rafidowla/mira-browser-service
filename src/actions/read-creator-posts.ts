/**
 * read-creator-posts.ts - Recent post reader for tracked LinkedIn creators.
 *
 * Purpose: Navigates to a creator's recent-activity page and extracts their
 * most recent posts via the selector-registry fallback chains (Canon H1.4).
 * Used by MIRA's creator intelligence pipeline to track content velocity and
 * identify breakout posts for inspiration. Every field's outcome is tracked
 * so an ExtractionConfidence report can distinguish "creator hasn't posted
 * recently" from "broken selector".
 *
 * Side Effects: Browser navigation; mutex acquire/release; on-failure DOM
 * snapshot to local disk only (Canon H1.4 item 3).
 * Deterministic: No. Concurrency: Mutex-protected.
 */

import type { Page } from 'playwright'
import { contextManager } from '../lib/context'
import { humanDelay, jitter, TimingConfig } from '../lib/timing'
import { extractField, CREATOR_POST_SELECTORS, LOGIN_CONFIRMED_MARKERS } from '../lib/selector-registry'
import { computeConfidence, shouldSnapshotOnLowConfidence, type ExtractionConfidence, type FieldOutcome } from '../lib/confidence'
import { detectAuthWall, captureFailureSnapshot, waitForPageSettled } from '../lib/read-action-support'
import type { AuthWallReason } from '../lib/auth-wall'

/** Structured representation of a creator's LinkedIn post. */
export interface CreatorPost {
  /** Post identifier from data attributes. */
  post_id: string
  /** Full text content of the post. */
  content_text: string
  /** Permalink URL to the post. */
  post_url: string
  /** Number of likes/reactions. */
  likes_count: number
  /** Number of comments. */
  comments_count: number
  /** Number of reposts. */
  reposts_count: number
  /** Relative or absolute time string as shown on LinkedIn. */
  posted_at: string
  /** True if the post contains media. */
  has_media: boolean
}

/** Result of a readCreatorPosts() invocation: extracted posts plus confidence/auth-wall state. */
export interface ReadCreatorPostsResult {
  posts: CreatorPost[]
  confidence: ExtractionConfidence
  auth_wall: boolean
  auth_wall_reason: AuthWallReason
}

/**
 * Extracts a single CreatorPost from a Playwright element handle, via the
 * selector-registry fallback chains.
 *
 * @param page - Active Playwright page.
 * @param selector - CSS selector identifying the post container element.
 * @param idx - Position index, used as a fallback post_id.
 * @returns The extracted CreatorPost and its per-field FieldOutcome list.
 *
 * Deterministic: No (live DOM). Side Effects: None (read-only).
 */
async function extractCreatorPost(page: Page, selector: string, idx: number): Promise<{ post: CreatorPost; outcomes: FieldOutcome[] }> {
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

  const idResult = await extractField<string>(
    ['data-id'],
    (attr) => page.$eval(selector, (el, a) => el.getAttribute(a) ?? '', attr).catch(() => undefined),
    `post-${idx}`,
  )
  outcomes.push({ field: 'post_id', missing: idResult.missing, rank: idResult.rank })
  const post_id = idResult.missing ? `post-${idx}` : idResult.value

  const content_text = await queryText('content_text', CREATOR_POST_SELECTORS.content_text)

  const post_url = await extractField<string>(
    CREATOR_POST_SELECTORS.post_url,
    (sel) =>
      page
        .$eval(`${selector} ${sel}`, (el) => (el as HTMLAnchorElement).href ?? '')
        .catch(() => undefined),
    '',
  ).then((r) => {
    outcomes.push({ field: 'post_url', missing: r.missing, rank: r.rank })
    return r.value
  })

  const posted_at = await queryText('posted_at', CREATOR_POST_SELECTORS.posted_at)

  const socialResult = await extractField<string>(
    CREATOR_POST_SELECTORS.social_counts,
    (sel) => page.$eval(`${selector} ${sel}`, (el) => el.textContent ?? '').catch(() => undefined),
    '',
  )
  outcomes.push({ field: 'social_counts', missing: socialResult.missing, rank: socialResult.rank })
  const nums = socialResult.value.match(/\d+(?:,\d+)*/g) ?? []
  const parseNum = (s: string) => parseInt(s.replace(/,/g, ''), 10)
  const likes_count = nums[0] ? parseNum(nums[0]) : 0
  const comments_count = nums[1] ? parseNum(nums[1]) : 0
  const reposts_count = nums[2] ? parseNum(nums[2]) : 0

  const mediaResult = await extractField<boolean>(
    CREATOR_POST_SELECTORS.media_marker,
    (sel) => page.$(`${selector} ${sel}`).then((el) => (el !== null ? true : undefined)).catch(() => undefined),
    false,
  )
  outcomes.push({ field: 'has_media', missing: mediaResult.missing, rank: mediaResult.rank })

  const post: CreatorPost = {
    post_id,
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
 * Reads recent posts from a tracked creator's LinkedIn activity page.
 *
 * @param profile_id - MIRA profile with an active browser context.
 * @param creator_linkedin_url - Base URL of the creator's LinkedIn profile.
 * @param timing - TimingConfig for delays.
 * @param limit - Max posts to return (default 5).
 * @returns ReadCreatorPostsResult with posts, ExtractionConfidence, and auth-wall state.
 *
 * Side Effects: Browser navigation; mutex acquire/release; console logging;
 * on-failure DOM snapshot to local disk only.
 * Error Behavior: All errors caught.
 */
export async function readCreatorPosts(
  profile_id: string,
  creator_linkedin_url: string,
  timing: TimingConfig,
  limit = 5,
): Promise<ReadCreatorPostsResult> {
  const emptyResult: ReadCreatorPostsResult = {
    posts: [],
    confidence: computeConfidence([]),
    auth_wall: false,
    auth_wall_reason: null,
  }

  const context = contextManager.getContext(profile_id)
  if (!context) {
    console.warn(`[readCreatorPosts] No context for profile ${profile_id}`)
    return emptyResult
  }
  if (!contextManager.acquireMutex(profile_id)) {
    console.warn(`[readCreatorPosts] Mutex blocked for profile ${profile_id}`)
    return emptyResult
  }

  let page: Page | null = null
  try {
    // Normalise URL and append recent-activity path
    const base = creator_linkedin_url.replace(/\/$/, "")
    const activityUrl = `${base}/recent-activity/all/`

    page = await context.newPage() as unknown as Page
    // Bring to front — see read-feed.ts for why (avoids background-tab throttling).
    await page.bringToFront().catch(() => undefined)
    console.log(`[readCreatorPosts] Navigating to ${activityUrl}`)
    await page.goto(activityUrl, { waitUntil: "domcontentloaded", timeout: 30000 })

    // Widened with LOGIN_CONFIRMED_MARKERS — see read-feed.ts for why.
    const authWallCheckSelector = [...CREATOR_POST_SELECTORS.container, ...LOGIN_CONFIRMED_MARKERS].join(', ')
    await waitForPageSettled(page, authWallCheckSelector)
    await humanDelay(timing.page_read_delay)

    const authWall = await detectAuthWall(page, authWallCheckSelector)
    if (authWall.auth_wall) {
      console.warn(`[readCreatorPosts] Auth wall detected for profile ${profile_id}: ${authWall.reason}`)
      await captureFailureSnapshot(page, 'read-creator-posts', profile_id, 'auth_wall', authWall.reason ?? undefined)
      return { posts: [], confidence: computeConfidence([]), auth_wall: true, auth_wall_reason: authWall.reason }
    }

    const scrollPx = jitter(timing.scroll_amount)
    await page.evaluate((px: number) => window.scrollBy(0, px), scrollPx)
    await humanDelay(timing.action_delay)

    let postSelectors: string[] = []
    for (const containerSel of CREATOR_POST_SELECTORS.container) {
      const count = await page.$$eval(containerSel, (els) => els.length).catch(() => 0)
      if (count > 0) {
        postSelectors = Array.from({ length: Math.min(count, limit) }, (_, i) => `${containerSel} >> nth=${i}`)
        break
      }
    }

    const posts: CreatorPost[] = []
    const allOutcomes: FieldOutcome[][] = []

    for (let idx = 0; idx < postSelectors.length; idx++) {
      const { post, outcomes } = await extractCreatorPost(page, postSelectors[idx], idx)
      posts.push(post)
      allOutcomes.push(outcomes)
    }

    const confidence = computeConfidence(allOutcomes)
    console.log(`[readCreatorPosts] Extracted ${posts.length} posts for ${creator_linkedin_url} (confidence: ${confidence.level})`)

    if (shouldSnapshotOnLowConfidence(confidence)) {
      await captureFailureSnapshot(page, 'read-creator-posts', profile_id, 'low_confidence')
    }

    return { posts, confidence, auth_wall: false, auth_wall_reason: null }

  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[readCreatorPosts] Error: ${message}`)
    await captureFailureSnapshot(page, 'read-creator-posts', profile_id, 'thrown_error', message)
    return emptyResult
  } finally {
    await page?.close().catch(() => undefined)
    contextManager.releaseMutex(profile_id)
  }
}
