/**
 * archive-message.ts - Archives one LinkedIn messaging conversation.
 *
 * Purpose: backs the "Clear junk" bulk action (founder request 2026-07-10,
 * scoped per Canon I-6 review — see
 * docs/mira-inbox-archive-write-review-2026-07-10.md in the mira repo).
 * MIRA already identifies + stages junk messages (read-only, unchanged);
 * this is the FIRST-EVER write action MIRA's browser service executes.
 * Scope is deliberately narrow: archive ONE conversation, nothing else —
 * no delete, no block, no report, no send. Human-triggered only — the app
 * calls this once per conversation in a capped batch (never from a
 * read/scan path, never scheduled).
 *
 * Archiving is reversible (LinkedIn's own archive semantics, not a delete)
 * and produces no public artifact — the risk profile that scoped review is
 * built on. It still runs through the same session pacing as every other
 * action (server.ts's recordAction() wraps every /task call uniformly) and
 * the same mutex/context-existence checks as open-url.ts.
 *
 * SELECTOR STATUS: best-effort, UNVERIFIED against live LinkedIn (Canon
 * H1.4 — every action starts this way; this one has never been exercised
 * against a real session at all). Needs a live test-account pass before
 * being trusted — a clean typecheck/unit-test run is not proof this clicks
 * the right thing on real LinkedIn's messaging UI.
 *
 * Side Effects: Browser navigation + clicks; mutex acquire/release;
 * on-failure DOM snapshot to local disk only.
 * Deterministic: No. Concurrency: Mutex-protected.
 * Error Behavior: All errors caught — returns { archived: false, reason }.
 */

import type { Locator, Page } from 'playwright'
import { contextManager } from '../lib/context'
import { humanDelay, TimingConfig } from '../lib/timing'
import { INBOX_ARCHIVE_SELECTORS } from '../lib/selector-registry'
import { detectAuthWall, waitForPageSettled, captureFailureSnapshot } from '../lib/read-action-support'

/** Result of a single archive-message attempt. */
export interface ArchiveMessageResult {
  /** Whether the conversation was actually archived. */
  archived: boolean
  /** The conversation URL that was targeted (echoed back). */
  conversation_url: string
  /** Why `archived` is false — absent when archived is true. */
  reason?: 'no_context' | 'mutex_blocked' | 'auth_wall' | 'control_not_found' | 'navigation_error'
}

const MORE_OPTIONS_SELECTOR = INBOX_ARCHIVE_SELECTORS.more_options_button.join(', ')

/**
 * Archives one conversation: navigates to it, opens the per-thread overflow
 * menu, and clicks "Archive". Never throws.
 *
 * @param profile_id - MIRA profile with an active browser context.
 * @param conversation_url - Full URL to the conversation thread to archive.
 * @param timing - TimingConfig for human-like settle delays between steps.
 */
export async function archiveMessage(
  profile_id: string,
  conversation_url: string,
  timing: TimingConfig,
): Promise<ArchiveMessageResult> {
  const context = contextManager.getContext(profile_id)
  if (!context) {
    console.warn(`[archiveMessage] No context for profile ${profile_id}`)
    return { archived: false, conversation_url, reason: 'no_context' }
  }
  if (!contextManager.acquireMutex(profile_id)) {
    console.warn(`[archiveMessage] Mutex blocked for profile ${profile_id}`)
    return { archived: false, conversation_url, reason: 'mutex_blocked' }
  }

  let page: Page | null = null
  try {
    page = (await context.newPage()) as unknown as Page
    await page.goto(conversation_url, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await waitForPageSettled(page, MORE_OPTIONS_SELECTOR)
    await humanDelay(timing.action_delay)

    const authWall = await detectAuthWall(page, MORE_OPTIONS_SELECTOR)
    if (authWall.auth_wall) {
      await captureFailureSnapshot(page, 'archive-message', profile_id, 'auth_wall', authWall.reason ? String(authWall.reason) : undefined)
      return { archived: false, conversation_url, reason: 'auth_wall' }
    }

    const moreButton = await findFirstVisible(page, INBOX_ARCHIVE_SELECTORS.more_options_button)
    if (!moreButton) {
      await captureFailureSnapshot(page, 'archive-message', profile_id, 'low_confidence', 'more-options control not found')
      return { archived: false, conversation_url, reason: 'control_not_found' }
    }
    await moreButton.click()
    await humanDelay(timing.action_delay)

    // Menu-item text is more stable than LinkedIn's churn-prone CSS classes
    // for a transient dropdown — matched by visible label, not a selector chain.
    const archiveItem = page.getByText('Archive', { exact: true }).first()
    const found = await archiveItem.count().catch(() => 0)
    if (found === 0) {
      await captureFailureSnapshot(page, 'archive-message', profile_id, 'low_confidence', 'Archive menu item not found')
      return { archived: false, conversation_url, reason: 'control_not_found' }
    }
    await archiveItem.click()
    await humanDelay(timing.action_delay)

    console.log(`[archiveMessage] Archived ${conversation_url} for profile ${profile_id}`)
    return { archived: true, conversation_url }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[archiveMessage] Error: ${message}`)
    await captureFailureSnapshot(page, 'archive-message', profile_id, 'thrown_error', message)
    return { archived: false, conversation_url, reason: 'navigation_error' }
  } finally {
    await page?.close().catch(() => undefined)
    contextManager.releaseMutex(profile_id)
  }
}

/** Returns the first selector in the chain whose element exists and is visible, or null. */
async function findFirstVisible(page: Page, selectors: readonly string[]): Promise<Locator | null> {
  for (const selector of selectors) {
    try {
      const locator = page.locator(selector).first()
      const visible = await locator.isVisible().catch(() => false)
      if (visible) return locator
    } catch {
      // try the next selector in the chain
    }
  }
  return null
}
