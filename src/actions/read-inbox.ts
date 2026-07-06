/**
 * read-inbox.ts - LinkedIn messaging inbox reader.
 *
 * Purpose: Navigates to the operator's OWN LinkedIn messaging inbox and
 * extracts a list of conversations. This is the safest possible read — it is
 * the operator's own data, never a third-party profile or a search crawl —
 * but per build-plan §3/§6 it remains strictly on-demand (button-triggered),
 * never cron/scheduled. Best-effort extraction — all fields failsafe to "".
 *
 * Side Effects: Browser navigation; mutex acquire/release.
 * Deterministic: No. Concurrency: Mutex-protected.
 */

import type { Page } from 'playwright'
import { contextManager } from '../lib/context'
import { humanDelay, jitter, TimingConfig } from '../lib/timing'

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

/** LinkedIn messaging inbox URL. */
const INBOX_URL = 'https://www.linkedin.com/messaging/'

/**
 * Reads the operator's own LinkedIn messaging inbox for conversation summaries.
 *
 * @param profile_id - MIRA profile with an active browser context.
 * @param timing - TimingConfig for delays and scroll behaviour.
 * @param limit - Max conversations to return (default 20).
 * @returns Array of InboxConversation. Returns [] on mutex block, context error, or nav failure.
 *
 * Side Effects: Browser navigation; mutex acquire/release; console logging.
 * Error Behavior: All errors caught — returns [].
 */
export async function readInbox(
  profile_id: string,
  timing: TimingConfig,
  limit = 20,
): Promise<InboxConversation[]> {
  const context = contextManager.getContext(profile_id)
  if (!context) {
    console.warn(`[readInbox] No context for profile ${profile_id} — call /session/init first`)
    return []
  }

  if (!contextManager.acquireMutex(profile_id)) {
    console.warn(`[readInbox] Mutex blocked for profile ${profile_id}`)
    return []
  }

  let page: Page | null = null
  try {
    page = await context.newPage() as unknown as Page
    console.log(`[readInbox] Navigating to inbox for profile ${profile_id}`)

    await page.goto(INBOX_URL, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await humanDelay(timing.page_read_delay)

    const scrollPx = jitter(timing.scroll_amount)
    await page.evaluate((px: number) => window.scrollBy(0, px), scrollPx)
    await humanDelay(timing.action_delay)

    const conversations: InboxConversation[] = await page.$$eval(
      'li.msg-conversation-listitem',
      (els, lim) => els.slice(0, lim).map((el) => {
        const getText = (sel: string) => el.querySelector(sel)?.textContent?.trim() ?? ''
        const getAttr = (sel: string, attr: string) =>
          (el.querySelector(sel) as HTMLElement | null)?.getAttribute(attr) ?? ''

        return {
          conversation_url: getAttr('a.msg-conversation-listitem__link', 'href'),
          participant_name: getText('.msg-conversation-listitem__participant-names'),
          participant_urn: getAttr('a.msg-conversation-listitem__link', 'data-participant-urn'),
          headline: getText('.msg-conversation-card__message-snippet-body'),
          last_message_snippet: getText('.msg-conversation-card__message-snippet'),
          unread: el.classList.contains('msg-conversation-listitem--unread')
            || el.querySelector('.notification-badge--show') !== null,
          last_at: getText('.msg-conversation-listitem__time-stamp'),
        }
      }),
      limit,
    ).catch(() => [])

    console.log(`[readInbox] Extracted ${conversations.length} conversations for profile ${profile_id}`)
    return conversations

  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[readInbox] Error for profile ${profile_id}: ${message}`)
    return []
  } finally {
    await page?.close().catch(() => undefined)
    contextManager.releaseMutex(profile_id)
  }
}
