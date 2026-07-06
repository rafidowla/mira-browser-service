/**
 * read-comments.ts - LinkedIn post comment reader.
 *
 * Purpose: Navigates to a specific LinkedIn post URL and extracts structured
 * comment data via the selector-registry fallback chains (Canon H1.4).
 * Missing fields return empty strings or zero rather than throwing; every
 * field's outcome is tracked so an ExtractionConfidence report can
 * distinguish "no comments" from "broken selector". Mutex-protected;
 * releases on completion or error.
 *
 * Side Effects: Browser navigation; mutex acquire/release; on-failure DOM
 * snapshot to local disk only (Canon H1.4 item 3).
 * Deterministic: No. Concurrency: Mutex-protected.
 */

import type { Page } from 'playwright'
import { contextManager } from '../lib/context'
import { humanDelay, TimingConfig } from '../lib/timing'
import { extractField, COMMENT_SELECTORS } from '../lib/selector-registry'
import { computeConfidence, shouldSnapshotOnLowConfidence, type ExtractionConfidence, type FieldOutcome } from '../lib/confidence'
import { detectAuthWall, captureFailureSnapshot } from '../lib/read-action-support'
import type { AuthWallReason } from '../lib/auth-wall'

/** Structured comment extracted from a LinkedIn post. */
export interface PostComment {
  /** Stable comment identifier from data attributes or position index. */
  comment_id: string
  /** Display name of the commenter. */
  author_name: string
  /** Professional headline of the commenter. */
  author_headline: string
  /** URL to the commenter's LinkedIn profile. */
  author_profile_url: string
  /** Full text of the comment. */
  comment_text: string
  /** Number of likes on this comment. */
  likes_count: number
  /** Relative or absolute time string as shown on LinkedIn. */
  posted_at: string
  /** True if this is a reply to another comment. */
  is_reply: boolean
}

/** Result of a readComments() invocation: extracted comments plus confidence/auth-wall state. */
export interface ReadCommentsResult {
  comments: PostComment[]
  confidence: ExtractionConfidence
  auth_wall: boolean
  auth_wall_reason: AuthWallReason
}

/**
 * Extracts a single PostComment from a Playwright element handle, via the
 * selector-registry fallback chains.
 *
 * @param page - Active Playwright page.
 * @param selector - CSS selector identifying the comment container element.
 * @param idx - Position index, used as a fallback comment_id.
 * @returns The extracted PostComment and its per-field FieldOutcome list.
 *
 * Deterministic: No (live DOM). Side Effects: None (read-only).
 */
async function extractComment(page: Page, selector: string, idx: number): Promise<{ comment: PostComment; outcomes: FieldOutcome[] }> {
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
          .$eval(`${selector} ${sel}`, (el, a) => (el as HTMLElement).getAttribute(a) ?? '', attr)
          .catch(() => undefined),
      '',
    ).then((r) => {
      outcomes.push({ field, missing: r.missing, rank: r.rank })
      return r.value
    })

  const idResult = await extractField<string>(
    ['data-id'],
    (attr) => page.$eval(selector, (el, a) => el.getAttribute(a) ?? '', attr).catch(() => undefined),
    `comment-${idx}`,
  )
  outcomes.push({ field: 'comment_id', missing: idResult.missing, rank: idResult.rank })
  const comment_id = idResult.missing ? `comment-${idx}` : idResult.value

  const author_name = await queryText('author_name', COMMENT_SELECTORS.author_name)
  const author_headline = await queryText('author_headline', COMMENT_SELECTORS.author_headline)
  const author_profile_url = await queryAttr('author_profile_url', COMMENT_SELECTORS.author_profile_url, 'href')
  const comment_text = await queryText('comment_text', COMMENT_SELECTORS.comment_text)
  const posted_at = await queryText('posted_at', COMMENT_SELECTORS.posted_at)

  const likesResult = await extractField<string>(
    COMMENT_SELECTORS.likes_count,
    (sel) => page.$eval(`${selector} ${sel}`, (el) => el.textContent?.trim() ?? '').catch(() => undefined),
    '',
  )
  outcomes.push({ field: 'likes_count', missing: likesResult.missing, rank: likesResult.rank })
  const likesMatch = likesResult.value.match(/\d+/)
  const likes_count = likesMatch ? parseInt(likesMatch[0], 10) : 0

  const is_reply = await page
    .$eval(
      selector,
      (el) => el.closest('.comments-comment-item__inline-show-more-text') !== null || el.hasAttribute('data-is-reply'),
    )
    .catch(() => false)

  const comment: PostComment = {
    comment_id,
    author_name,
    author_headline,
    author_profile_url,
    comment_text,
    likes_count,
    posted_at,
    is_reply,
  }

  return { comment, outcomes }
}

/**
 * Reads comments from a specific LinkedIn post.
 *
 * @param profile_id - MIRA profile with an active browser context.
 * @param post_url - Full URL to the LinkedIn post.
 * @param timing - TimingConfig for delays.
 * @param limit - Max comments to return (default 20).
 * @returns ReadCommentsResult with comments, ExtractionConfidence, and auth-wall state.
 *
 * Side Effects: Browser navigation; mutex acquire/release; console logging;
 * on-failure DOM snapshot to local disk only.
 * Error Behavior: All errors caught.
 */
export async function readComments(
  profile_id: string,
  post_url: string,
  timing: TimingConfig,
  limit = 20,
): Promise<ReadCommentsResult> {
  const emptyResult: ReadCommentsResult = {
    comments: [],
    confidence: computeConfidence([]),
    auth_wall: false,
    auth_wall_reason: null,
  }

  const context = contextManager.getContext(profile_id)
  if (!context) {
    console.warn(`[readComments] No context for profile ${profile_id}`)
    return emptyResult
  }
  if (!contextManager.acquireMutex(profile_id)) {
    console.warn(`[readComments] Mutex blocked for profile ${profile_id}`)
    return emptyResult
  }

  let page: Page | null = null
  try {
    page = await context.newPage() as unknown as Page
    await page.goto(post_url, { waitUntil: "domcontentloaded", timeout: 30000 })
    await humanDelay(timing.page_read_delay)

    const primaryContentSelector = COMMENT_SELECTORS.container[0]
    const authWall = await detectAuthWall(page, primaryContentSelector)
    if (authWall.auth_wall) {
      console.warn(`[readComments] Auth wall detected for profile ${profile_id}: ${authWall.reason}`)
      await captureFailureSnapshot(page, 'read-comments', profile_id, 'auth_wall', authWall.reason ?? undefined)
      return { comments: [], confidence: computeConfidence([]), auth_wall: true, auth_wall_reason: authWall.reason }
    }

    let commentSelectors: string[] = []
    for (const containerSel of COMMENT_SELECTORS.container) {
      const count = await page.$$eval(containerSel, (els) => els.length).catch(() => 0)
      if (count > 0) {
        commentSelectors = Array.from({ length: Math.min(count, limit) }, (_, i) => `${containerSel} >> nth=${i}`)
        break
      }
    }

    const comments: PostComment[] = []
    const allOutcomes: FieldOutcome[][] = []

    for (let idx = 0; idx < commentSelectors.length; idx++) {
      const { comment, outcomes } = await extractComment(page, commentSelectors[idx], idx)
      comments.push(comment)
      allOutcomes.push(outcomes)
    }

    const confidence = computeConfidence(allOutcomes)
    console.log(`[readComments] Extracted ${comments.length} comments from ${post_url} (confidence: ${confidence.level})`)

    if (shouldSnapshotOnLowConfidence(confidence)) {
      await captureFailureSnapshot(page, 'read-comments', profile_id, 'low_confidence')
    }

    return { comments, confidence, auth_wall: false, auth_wall_reason: null }

  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[readComments] Error: ${message}`)
    await captureFailureSnapshot(page, 'read-comments', profile_id, 'thrown_error', message)
    return emptyResult
  } finally {
    await page?.close().catch(() => undefined)
    contextManager.releaseMutex(profile_id)
  }
}
