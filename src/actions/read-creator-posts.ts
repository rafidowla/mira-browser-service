/**
 * read-creator-posts.ts - Recent post reader for tracked LinkedIn creators.
 *
 * Purpose: Navigates to a creator's recent-activity page and extracts their
 * most recent posts. Used by MIRA's creator intelligence pipeline to track
 * content velocity and identify breakout posts for inspiration.
 *
 * Side Effects: Browser navigation; mutex acquire/release.
 * Deterministic: No. Concurrency: Mutex-protected.
 */

import type { Page } from 'playwright'
import { contextManager } from '../lib/context'
import { humanDelay, jitter, TimingConfig } from '../lib/timing'

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

/**
 * Reads recent posts from a tracked creator's LinkedIn activity page.
 *
 * @param profile_id - MIRA profile with an active browser context.
 * @param creator_linkedin_url - Base URL of the creator's LinkedIn profile.
 * @param timing - TimingConfig for delays.
 * @param limit - Max posts to return (default 5).
 * @returns Array of CreatorPost. Returns [] on error or mutex block.
 *
 * Side Effects: Browser navigation; mutex acquire/release; console logging.
 * Error Behavior: All errors caught — returns [].
 */
export async function readCreatorPosts(
  profile_id: string,
  creator_linkedin_url: string,
  timing: TimingConfig,
  limit = 5,
): Promise<CreatorPost[]> {
  const context = contextManager.getContext(profile_id)
  if (!context) {
    console.warn(`[readCreatorPosts] No context for profile ${profile_id}`)
    return []
  }
  if (!contextManager.acquireMutex(profile_id)) {
    console.warn(`[readCreatorPosts] Mutex blocked for profile ${profile_id}`)
    return []
  }

  let page: Page | null = null
  try {
    // Normalise URL and append recent-activity path
    const base = creator_linkedin_url.replace(/\/$/, "")
    const activityUrl = `${base}/recent-activity/all/`

    page = await context.newPage() as unknown as Page
    console.log(`[readCreatorPosts] Navigating to ${activityUrl}`)
    await page.goto(activityUrl, { waitUntil: "domcontentloaded", timeout: 30000 })
    await humanDelay(timing.page_read_delay)

    const scrollPx = jitter(timing.scroll_amount)
    await page.evaluate((px: number) => window.scrollBy(0, px), scrollPx)
    await humanDelay(timing.action_delay)

    const posts: CreatorPost[] = await page.$$eval(
      "div[data-id]",
      (els, lim) => els.slice(0, lim).map((el, idx) => {
        const getText = (sel: string) => el.querySelector(sel)?.textContent?.trim() ?? ""
        const socialText = el.querySelector(".social-details-social-counts")?.textContent ?? ""
        const nums = socialText.match(/\d+(?:,\d+)*/g) ?? []
        const parseNum = (s: string) => parseInt(s.replace(/,/g, ""), 10)
        const postLink = el.querySelector("a[href*=\"/feed/update/\"]") as HTMLAnchorElement | null
        const hasMedia = !!el.querySelector(".update-components-image, .update-components-video, .document-s-container")
        return {
          post_id: el.getAttribute("data-id") ?? `post-${idx}`,
          content_text: getText(".feed-shared-update-v2__description span[dir=\"ltr\"]")
            || getText(".update-components-text span[dir=\"ltr\"]"),
          post_url: postLink?.href ?? "",
          likes_count: nums[0] ? parseNum(nums[0]) : 0,
          comments_count: nums[1] ? parseNum(nums[1]) : 0,
          reposts_count: nums[2] ? parseNum(nums[2]) : 0,
          posted_at: getText(".update-components-actor__sub-description span[aria-hidden=\"true\"]"),
          has_media: hasMedia,
        }
      }),
      limit,
    ).catch(() => [])

    console.log(`[readCreatorPosts] Extracted ${posts.length} posts for ${creator_linkedin_url}`)
    return posts

  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[readCreatorPosts] Error: ${message}`)
    return []
  } finally {
    await page?.close().catch(() => undefined)
    contextManager.releaseMutex(profile_id)
  }
}
