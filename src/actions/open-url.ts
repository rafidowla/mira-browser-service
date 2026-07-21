/**
 * open-url.ts - Opens a URL in the operator's authenticated context and LEAVES
 * the page open for the human to act in.
 *
 * Purpose: the drafts-first execution flow. MIRA never posts/comments/connects;
 * instead it opens the target LinkedIn post/profile in the operator's real,
 * authenticated, *headful* browser window so the human can paste a pre-copied
 * draft and post it themselves. This is a navigate/read-class action — it does
 * not scrape, extract, or submit anything.
 *
 * Unlike the read actions, this deliberately does NOT close the page: the
 * operator takes over in the same window. It requires the profile's context to
 * be launched headful (see CloakBrowser / build plan L1); on a headless context
 * the navigation still succeeds but there is nothing for the human to see.
 *
 * Side Effects: Browser navigation; opens a page that stays open; mutex
 * acquire/release. Deterministic: No. Concurrency: Mutex-protected (briefly).
 * Error Behavior: All errors caught — returns { opened: false }.
 */

import type { Page } from 'playwright'
import { contextManager } from '../lib/context'
import { humanDelay, TimingConfig } from '../lib/timing'

/** Result of an open-url navigate. */
export interface OpenUrlResult {
  /** Whether the page was opened in the operator's context. */
  opened: boolean
  /** The URL that was opened (echoed back). */
  url: string
  /** Why `opened` is false — absent when opened is true. */
  reason?: 'no_context' | 'mutex_blocked' | 'navigation_error'
}

/**
 * Opens target_url in the profile's authenticated context and leaves it open.
 *
 * @param profile_id - MIRA profile with an active browser context.
 * @param target_url - Full URL to open (a LinkedIn post or profile).
 * @param timing - TimingConfig for a small human-like settle delay.
 * @returns OpenUrlResult. { opened: false, reason } if no context / mutex blocked / error.
 *
 * Side Effects: Opens a new page (left open) and brings it to front.
 * Error Behavior: Catches all errors — never throws.
 */
export async function openUrl(
  profile_id: string,
  target_url: string,
  timing: TimingConfig,
): Promise<OpenUrlResult> {
  const context = contextManager.getContext(profile_id)
  if (!context) {
    console.warn(`[openUrl] No context for profile ${profile_id}`)
    return { opened: false, url: target_url, reason: 'no_context' }
  }
  if (!contextManager.acquireMutex(profile_id)) {
    console.warn(`[openUrl] Mutex blocked for profile ${profile_id}`)
    return { opened: false, url: target_url, reason: 'mutex_blocked' }
  }

  try {
    // Intentionally NOT closed in a finally — the operator acts in this page.
    const page = (await context.newPage()) as unknown as Page
    await page.goto(target_url, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await page.bringToFront().catch(() => undefined)
    await humanDelay(timing.action_delay)
    console.log(`[openUrl] Opened ${target_url} for profile ${profile_id}`)
    return { opened: true, url: target_url }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[openUrl] Error: ${message}`)
    return { opened: false, url: target_url, reason: 'navigation_error' }
  } finally {
    // Release the mutex immediately; the page stays open independently.
    contextManager.releaseMutex(profile_id)
  }
}
