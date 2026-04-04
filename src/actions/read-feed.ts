/**
 * read-feed.ts - LinkedIn home feed reader.
 *
 * Purpose: Navigates to the LinkedIn home feed and extracts structured post data
 * using Playwright. Acquisition of the mutex ensures only one profile is active
 * at a time. All field extraction is best-effort — missing fields return empty
 * strings or zero rather than throwing, as LinkedIn DOM changes frequently.
 *
 * Side Effects: Browser navigation; mutex acquisition/release.
 * Deterministic: No (live browser content). Concurrency: Mutex-protected.
 */

import type { Page } from 'playwright'
import { contextManager } from '../lib/context'
import { humanDelay, jitter, TimingConfig } from '../lib/timing'

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

/** LinkedIn home feed URL. */
const FEED_URL = "https://www.linkedin.com/feed/"

/**
 * Extracts a single FeedPost from a Playwright element handle.
 *
 * Purpose: Isolates post extraction logic and ensures any individual field
 * failure does not abort the entire extraction. All errors are caught per-field.
 *
 * @param page - Active Playwright page.
 * @param selector - CSS selector identifying the post container element.
 * @returns Partially or fully populated FeedPost.
 *
 * Deterministic: No (live DOM). Side Effects: None (read-only).
 */
async function extractPost(page: Page, selector: string): Promise<FeedPost> {
  const post: FeedPost = {
    post_id: "", author_name: "", author_headline: "",
    author_profile_url: "", content_text: "", post_url: "",
    likes_count: 0, comments_count: 0, reposts_count: 0,
    posted_at: "", has_media: false,
  }

  try {
    // post_id from data-id attribute
    post.post_id = await page.$eval(
      selector,
      (el) => el.getAttribute("data-id") ?? el.getAttribute("data-urn") ?? "",
    ).catch(() => "")

    // author name
    post.author_name = await page.$eval(
      `${selector} .update-components-actor__name span[aria-hidden="true"]`,
      (el) => el.textContent?.trim() ?? "",
    ).catch(() => "")

    // author headline
    post.author_headline = await page.$eval(
      `${selector} .update-components-actor__description span[aria-hidden="true"]`,
      (el) => el.textContent?.trim() ?? "",
    ).catch(() => "")

    // author profile URL
    post.author_profile_url = await page.$eval(
      `${selector} .update-components-actor__meta a`,
      (el) => (el as HTMLAnchorElement).href ?? "",
    ).catch(() => "")

    // post text content
    post.content_text = await page.$eval(
      `${selector} .feed-shared-update-v2__description span[dir="ltr"]`,
      (el) => el.textContent?.trim() ?? "",
    ).catch(() => "")
    if (!post.content_text) {
      post.content_text = await page.$eval(
        `${selector} .update-components-text span[dir="ltr"]`,
        (el) => el.textContent?.trim() ?? "",
      ).catch(() => "")
    }

    // post URL from timestamp link
    post.post_url = await page.$eval(
      `${selector} a[href*="/feed/update/"]`,
      (el) => (el as HTMLAnchorElement).href ?? "",
    ).catch(() => "")

    // posted_at from time element
    post.posted_at = await page.$eval(
      `${selector} .update-components-actor__sub-description span[aria-hidden="true"]`,
      (el) => el.textContent?.trim() ?? "",
    ).catch(() => "")

    // engagement counts via aria-label parsing
    const socialCounts = await page.$eval(
      `${selector} .social-details-social-counts`,
      (el) => el.textContent ?? "",
    ).catch(() => "")

    // extract first number found in reaction/comment text
    const numbers = socialCounts.match(/\d+(?:,\d+)*/g) ?? []
    post.likes_count = numbers[0] ? parseInt(numbers[0].replace(/,/g, ""), 10) : 0
    post.comments_count = numbers[1] ? parseInt(numbers[1].replace(/,/g, ""), 10) : 0
    post.reposts_count = numbers[2] ? parseInt(numbers[2].replace(/,/g, ""), 10) : 0

    // has_media: check for image, video, or document components
    post.has_media = await page.$(
      `${selector} .update-components-image, ${selector} .update-components-video, ${selector} .document-s-container`,
    ).then((el) => el !== null).catch(() => false)

  } catch {
    // best-effort: partial data is acceptable
  }

  return post
}

/**
 * Reads the LinkedIn home feed for the specified profile.
 *
 * Purpose: Primary data source for MIRA's feed monitoring. Returns up to
 * `limit` posts from the authenticated profile's feed. Uses human-like
 * timing between navigation and extraction to reduce bot detection signals.
 *
 * @param profile_id - MIRA profile identifier with an active browser context.
 * @param timing - TimingConfig controlling delays and scroll behaviour.
 * @param limit - Maximum posts to return (default 10).
 * @returns Array of FeedPost. Returns [] on mutex block, context error, or nav failure.
 *
 * Side Effects: Browser navigation; mutex acquire/release; console logging.
 * Deterministic: No. Error Behavior: All errors caught — returns [].
 * Concurrency: Mutex-protected; returns [] immediately if another profile active.
 */
export async function readFeed(
  profile_id: string,
  timing: TimingConfig,
  limit = 10,
): Promise<FeedPost[]> {
  const context = contextManager.getContext(profile_id)
  if (!context) {
    console.warn(`[readFeed] No context for profile ${profile_id} — call /session/init first`)
    return []
  }

  if (!contextManager.acquireMutex(profile_id)) {
    console.warn(`[readFeed] Mutex blocked for profile ${profile_id}`)
    return []
  }

  let page: Page | null = null
  try {
    page = await context.newPage() as unknown as Page
    console.log(`[readFeed] Navigating to feed for profile ${profile_id}`)

    await page.goto(FEED_URL, { waitUntil: "domcontentloaded", timeout: 30000 })
    await humanDelay(timing.page_read_delay)

    // Human-like scroll before reading
    const scrollPx = jitter(timing.scroll_amount)
    await page.evaluate((px: number) => window.scrollBy(0, px), scrollPx)
    await humanDelay(timing.action_delay)

    // Collect post container selectors
    const postSelectors: string[] = await page.$$eval(
      "div[data-id]",
      (els) => els
        .filter((el) => el.classList.contains("feed-shared-update-v2") || el.getAttribute("data-id")?.startsWith("urn:li:activity:"))
        .map((el) => {
          const id = el.getAttribute("data-id") ?? el.getAttribute("data-urn") ?? ""
          return id ? `div[data-id="${id}"]` : ""
        })
        .filter(Boolean)
    ).catch(() => [])

    const limited = postSelectors.slice(0, limit)
    const posts: FeedPost[] = []

    for (const selector of limited) {
      const post = await extractPost(page, selector)
      posts.push(post)
    }

    console.log(`[readFeed] Extracted ${posts.length} posts for profile ${profile_id}`)
    return posts

  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[readFeed] Error for profile ${profile_id}: ${message}`)
    return []
  } finally {
    await page?.close().catch(() => undefined)
    contextManager.releaseMutex(profile_id)
  }
}
