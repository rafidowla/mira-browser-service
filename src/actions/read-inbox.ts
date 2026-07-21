/**
 * read-inbox.ts - LinkedIn messaging inbox reader.
 *
 * Purpose: Navigates to the operator's OWN LinkedIn messaging inbox and
 * extracts a list of conversations via the selector-registry fallback chains
 * (Canon H1.4). This is the safest possible read — it is the operator's own
 * data, never a third-party profile or a search crawl — but per build-plan
 * §3/§6 it remains strictly on-demand (button-triggered), never cron/scheduled.
 * Every field's outcome is tracked so an ExtractionConfidence report can
 * distinguish "empty inbox" from "broken selector".
 *
 * Side Effects: Browser navigation; mutex acquire/release; on-failure DOM
 * snapshot to local disk only (Canon H1.4 item 3).
 * Deterministic: No. Concurrency: Mutex-protected.
 */

import type { Page } from 'playwright'
import { contextManager } from '../lib/context'
import { humanDelay, jitter, TimingConfig } from '../lib/timing'
import { extractField, INBOX_SELECTORS, LOGIN_CONFIRMED_MARKERS } from '../lib/selector-registry'
import { computeConfidence, shouldSnapshotOnLowConfidence, type ExtractionConfidence, type FieldOutcome } from '../lib/confidence'
import { detectAuthWall, captureFailureSnapshot, waitForPageSettled } from '../lib/read-action-support'
import type { AuthWallReason } from '../lib/auth-wall'

/** Summary of a single LinkedIn messaging conversation from the operator's own inbox. */
export interface InboxConversation {
  /** Full URL to this conversation thread in LinkedIn messaging. */
  conversation_url: string
  /** Display name of the other participant. */
  participant_name: string
  /** URL to the other participant's LinkedIn profile ("" if not resolvable). */
  participant_urn: string
  /** Professional headline of the other participant. */
  headline: string
  /** Preview text of the most recent message in the thread. */
  last_message_snippet: string
  /** True if the conversation has unread messages. */
  unread: boolean
  /** Relative or absolute time string as shown on LinkedIn for the last message. */
  last_at: string
}

/** Result of a readInbox() invocation: extracted conversations plus confidence/auth-wall state. */
export interface ReadInboxResult {
  conversations: InboxConversation[]
  confidence: ExtractionConfidence
  auth_wall: boolean
  auth_wall_reason: AuthWallReason
}

/** LinkedIn messaging inbox URL. */
const INBOX_URL = 'https://www.linkedin.com/messaging/'

/**
 * Extracts a single InboxConversation from a Playwright element handle, via
 * the selector-registry fallback chains.
 *
 * @param page - Active Playwright page.
 * @param selector - CSS selector identifying the conversation-row element.
 * @returns The extracted InboxConversation and its per-field FieldOutcome list.
 *
 * Deterministic: No (live DOM). Side Effects: None (read-only).
 */
async function extractConversation(page: Page, selector: string): Promise<{ conversation: InboxConversation; outcomes: FieldOutcome[] }> {
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

  const conversation_url = await queryAttr('conversation_url', INBOX_SELECTORS.conversation_link, 'href')
  const participant_urn = await queryAttr('participant_urn', INBOX_SELECTORS.conversation_link, 'data-participant-urn')
  const participant_name = await queryText('participant_name', INBOX_SELECTORS.participant_name)
  const headline = await queryText('headline', INBOX_SELECTORS.headline)
  const last_message_snippet = await queryText('last_message_snippet', INBOX_SELECTORS.last_message_snippet)
  const last_at = await queryText('last_at', INBOX_SELECTORS.last_at)

  const unread = await page
    .$eval(
      selector,
      (el) =>
        el.classList.contains('msg-conversation-listitem--unread') ||
        el.querySelector('.notification-badge--show') !== null,
    )
    .catch(() => false)

  const conversation: InboxConversation = {
    conversation_url,
    participant_name,
    participant_urn,
    headline,
    last_message_snippet,
    unread,
    last_at,
  }

  return { conversation, outcomes }
}

/**
 * Reads the operator's own LinkedIn messaging inbox for conversation summaries.
 *
 * @param profile_id - MIRA profile with an active browser context.
 * @param timing - TimingConfig for delays and scroll behaviour.
 * @param limit - Max conversations to return (default 20).
 * @returns ReadInboxResult with conversations, ExtractionConfidence, and auth-wall state.
 *
 * Side Effects: Browser navigation; mutex acquire/release; console logging;
 * on-failure DOM snapshot to local disk only.
 * Error Behavior: All errors caught.
 */
export async function readInbox(
  profile_id: string,
  timing: TimingConfig,
  limit = 20,
): Promise<ReadInboxResult> {
  const emptyResult: ReadInboxResult = {
    conversations: [],
    confidence: computeConfidence([]),
    auth_wall: false,
    auth_wall_reason: null,
  }

  const context = contextManager.getContext(profile_id)
  if (!context) {
    console.warn(`[readInbox] No context for profile ${profile_id} — call /session/init first`)
    return emptyResult
  }

  if (!contextManager.acquireMutex(profile_id)) {
    console.warn(`[readInbox] Mutex blocked for profile ${profile_id}`)
    return emptyResult
  }

  let page: Page | null = null
  try {
    page = await context.newPage() as unknown as Page
    // Bring to front — see read-feed.ts for why (avoids background-tab throttling).
    await page.bringToFront().catch(() => undefined)
    console.log(`[readInbox] Navigating to inbox for profile ${profile_id}`)

    await page.goto(INBOX_URL, { waitUntil: 'domcontentloaded', timeout: 30000 })

    // Widened with LOGIN_CONFIRMED_MARKERS — see read-feed.ts for why.
    const authWallCheckSelector = [...INBOX_SELECTORS.container, ...LOGIN_CONFIRMED_MARKERS].join(', ')
    await waitForPageSettled(page, authWallCheckSelector)
    await humanDelay(timing.page_read_delay)

    const authWall = await detectAuthWall(page, authWallCheckSelector)
    if (authWall.auth_wall) {
      console.warn(`[readInbox] Auth wall detected for profile ${profile_id}: ${authWall.reason}`)
      await captureFailureSnapshot(page, 'read-inbox', profile_id, 'auth_wall', authWall.reason ?? undefined)
      return { conversations: [], confidence: computeConfidence([]), auth_wall: true, auth_wall_reason: authWall.reason }
    }

    const scrollPx = jitter(timing.scroll_amount)
    await page.evaluate((px: number) => window.scrollBy(0, px), scrollPx)
    await humanDelay(timing.action_delay)

    let convoSelectors: string[] = []
    for (const containerSel of INBOX_SELECTORS.container) {
      const count = await page.$$eval(containerSel, (els) => els.length).catch(() => 0)
      if (count > 0) {
        convoSelectors = Array.from({ length: Math.min(count, limit) }, (_, i) => `${containerSel} >> nth=${i}`)
        break
      }
    }

    const conversations: InboxConversation[] = []
    const allOutcomes: FieldOutcome[][] = []

    for (const selector of convoSelectors) {
      const { conversation, outcomes } = await extractConversation(page, selector)
      conversations.push(conversation)
      allOutcomes.push(outcomes)
    }

    const confidence = computeConfidence(allOutcomes)
    console.log(`[readInbox] Extracted ${conversations.length} conversations for profile ${profile_id} (confidence: ${confidence.level})`)

    if (shouldSnapshotOnLowConfidence(confidence)) {
      await captureFailureSnapshot(page, 'read-inbox', profile_id, 'low_confidence')
    }

    return { conversations, confidence, auth_wall: false, auth_wall_reason: null }

  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[readInbox] Error for profile ${profile_id}: ${message}`)
    await captureFailureSnapshot(page, 'read-inbox', profile_id, 'thrown_error', message)
    return emptyResult
  } finally {
    await page?.close().catch(() => undefined)
    contextManager.releaseMutex(profile_id)
  }
}
