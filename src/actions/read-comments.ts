/**
 * read-comments.ts - LinkedIn post comment reader.
 *
 * Purpose: Navigates to a specific LinkedIn post URL and extracts structured
 * comment data. Best-effort extraction — missing fields return empty strings
 * or zero. Mutex-protected; releases on completion or error.
 *
 * Side Effects: Browser navigation; mutex acquire/release.
 * Deterministic: No. Concurrency: Mutex-protected.
 */

import type { Page } from 'playwright'
import { contextManager } from '../lib/context'
import { humanDelay, TimingConfig } from '../lib/timing'

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

/**
 * Reads comments from a specific LinkedIn post.
 *
 * @param profile_id - MIRA profile with an active browser context.
 * @param post_url - Full URL to the LinkedIn post.
 * @param timing - TimingConfig for delays.
 * @param limit - Max comments to return (default 20).
 * @returns Array of PostComment. Returns [] on error or mutex block.
 *
 * Side Effects: Browser navigation; mutex acquire/release; console logging.
 * Error Behavior: All errors caught — returns [].
 */
export async function readComments(
  profile_id: string,
  post_url: string,
  timing: TimingConfig,
  limit = 20,
): Promise<PostComment[]> {
  const context = contextManager.getContext(profile_id)
  if (!context) {
    console.warn(`[readComments] No context for profile ${profile_id}`)
    return []
  }
  if (!contextManager.acquireMutex(profile_id)) {
    console.warn(`[readComments] Mutex blocked for profile ${profile_id}`)
    return []
  }

  let page: Page | null = null
  try {
    page = await context.newPage() as unknown as Page
    await page.goto(post_url, { waitUntil: "domcontentloaded", timeout: 30000 })
    await humanDelay(timing.page_read_delay)

    const comments: PostComment[] = await page.$$eval(
      ".comments-comment-item",
      (els, lim) => els.slice(0, lim).map((el, idx) => {
        const getText = (sel: string) => el.querySelector(sel)?.textContent?.trim() ?? ""
        const getAttr = (sel: string, attr: string) => (el.querySelector(sel) as HTMLElement | null)?.getAttribute(attr) ?? ""
        const likesText = getText(".comments-comment-social-bar__reactions-count")
        const likesMatch = likesText.match(/\d+/)
        return {
          comment_id: el.getAttribute("data-id") ?? `comment-${idx}`,
          author_name: getText(".comments-post-meta__name span[aria-hidden=\"true\"]"),
          author_headline: getText(".comments-post-meta__headline"),
          author_profile_url: getAttr(".comments-post-meta__name a", "href"),
          comment_text: getText(".comments-comment-item__main-content"),
          likes_count: likesMatch ? parseInt(likesMatch[0], 10) : 0,
          posted_at: getText(".comments-comment-item__timestamp"),
          is_reply: el.closest(".comments-comment-item__inline-show-more-text") !== null
            || el.hasAttribute("data-is-reply"),
        }
      }),
      limit,
    ).catch(() => [])

    console.log(`[readComments] Extracted ${comments.length} comments from ${post_url}`)
    return comments

  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[readComments] Error: ${message}`)
    return []
  } finally {
    await page?.close().catch(() => undefined)
    contextManager.releaseMutex(profile_id)
  }
}
