/**
 * read-action-support.ts - Shared post-navigation glue for read actions
 * (Canon H1.4): auth-wall detection + on-failure snapshot capture.
 *
 * Purpose: read-feed, read-comments, read-profile, read-creator-posts, and
 * read-inbox all need the same sequence after `page.goto()`: gather
 * AuthWallSignals from the live page, classify them, and — on either an
 * auth-wall or low extraction confidence — save a local DOM snapshot. This
 * module holds that glue once instead of five times so the policy (what
 * counts as an auth wall, when to snapshot) stays consistent across actions.
 *
 * The pure decision logic (classifyAuthWall, computeConfidence,
 * shouldSnapshotOnLowConfidence) lives in auth-wall.ts / confidence.ts and is
 * unit-tested there directly. This module is the thin Playwright-touching
 * wiring around it, so it is intentionally not unit-tested with fixtures —
 * it has no live-browser-independent logic of its own beyond delegation.
 *
 * Side Effects: DOM reads via Playwright; local file writes via snapshot.ts.
 * Deterministic: No (live page). Network: None beyond what the caller's
 * `page` already does — this module never makes an outbound HTTP call itself.
 */

import type { Page } from 'playwright'
import { classifyAuthWall, type AuthWallResult, type AuthWallSignals } from './auth-wall'
import { AUTH_WALL_SELECTORS } from './selector-registry'
import { saveSnapshot, type SnapshotReason } from './snapshot'
import type { ExtractionConfidence } from './confidence'

/**
 * Gathers AuthWallSignals from a live page and classifies them.
 *
 * @param page - Active Playwright page, already navigated.
 * @param primaryContentSelector - CSS selector for the content container the
 *   caller is about to extract from (e.g. the feed's post container, the
 *   inbox's conversation list). Used to detect the "empty authed shell" case.
 * @returns AuthWallResult. Never throws — any DOM-query failure is treated
 *   as "marker not present" rather than aborting the check.
 *
 * Side Effects: Read-only DOM queries. Deterministic: No (live page).
 */
export async function detectAuthWall(
  page: Page,
  primaryContentSelector: string,
): Promise<AuthWallResult> {
  const url = page.url()
  const title = await page.title().catch(() => '')
  const bodyTextSample = await page
    .$eval('body', (el) => el.textContent?.slice(0, 2000) ?? '')
    .catch(() => '')
  const hasLoginFormMarker = await anySelectorPresent(page, AUTH_WALL_SELECTORS.login_form)
  const hasChallengeMarker = await anySelectorPresent(page, AUTH_WALL_SELECTORS.checkpoint_challenge)
  const hasPrimaryContentContainer = await page
    .$(primaryContentSelector)
    .then((el) => el !== null)
    .catch(() => false)

  const signals: AuthWallSignals = {
    url,
    title,
    bodyTextSample,
    hasLoginFormMarker,
    hasChallengeMarker,
    hasPrimaryContentContainer,
  }
  return classifyAuthWall(signals)
}

async function anySelectorPresent(page: Page, selectors: readonly string[]): Promise<boolean> {
  for (const selector of selectors) {
    const found = await page.$(selector).then((el) => el !== null).catch(() => false)
    if (found) return true
  }
  return false
}

/**
 * Waits for the page to settle into one of its known states — real content
 * present, a login-form marker, or a checkpoint/challenge marker — before
 * `detectAuthWall` classifies it.
 *
 * Why this exists: LinkedIn is a client-rendered SPA. `page.goto(..., {
 * waitUntil: "domcontentloaded" })` fires once the initial HTML document
 * parses, well before React mounts and fetches feed/profile/inbox content.
 * Classifying immediately after that (previously: navigate + a fixed
 * ~1.5-4s human delay) can catch the page mid-load — an empty `id="root"`
 * shell with none of the real content yet — and misreport it as
 * `empty_authed_shell` (a "silently expired session") when the operator is
 * actually logged in and the page simply hasn't finished rendering (Canon
 * H1.4: selectors/timing were written blind against live LinkedIn).
 *
 * Polls for the content selector or the auth-wall marker selectors, instead
 * of `page.waitForSelector` — observed live against real LinkedIn: the
 * event-based wait did not reliably fire even when the element demonstrably
 * appeared in the DOM within the window (confirmed via on-failure snapshots
 * capturing it moments later). Direct `page.$()` polling matches exactly
 * what `detectAuthWall` itself uses to check presence, so "waitForPageSettled
 * says found" and "detectAuthWall says found" can never disagree.
 *
 * Never throws — if nothing appears within timeoutMs, it just returns, and
 * detectAuthWall classifies whatever DOM exists at that point.
 *
 * @param page - Active Playwright page, already navigated.
 * @param primaryContentSelector - The (possibly comma-joined) CSS selector
 *   for the content the caller is about to extract from.
 * @param timeoutMs - Max time to wait for a settled state. Default 30s —
 *   observed live: a cold-started browser (right after session/init) can take
 *   just over 15s for LinkedIn's nav chrome to mount; 30s gives real margin
 *   while staying bounded (never hangs).
 * @param pollIntervalMs - How often to re-check. Default 500ms.
 */
export async function waitForPageSettled(
  page: Page,
  primaryContentSelector: string,
  timeoutMs = 30000,
  pollIntervalMs = 500,
): Promise<void> {
  const markerSelectors = [...AUTH_WALL_SELECTORS.login_form, ...AUTH_WALL_SELECTORS.checkpoint_challenge]
  const selectors = [primaryContentSelector, ...markerSelectors]
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = await anySelectorPresent(page, selectors)
    if (found) return
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
  }
}

/**
 * Saves an on-failure snapshot if warranted, given the current confidence
 * report (or an unconditional reason like a thrown error / auth wall).
 * Wraps snapshot.ts's saveSnapshot with the page-content read.
 *
 * @param page - Active Playwright page to snapshot (page.content()).
 * @param action - Action name for the snapshot filename/meta.
 * @param profile_id - MIRA profile identifier for the snapshot filename/meta.
 * @param reason - Why the snapshot is being taken.
 * @param detail - Optional extra context (e.g. thrown error message).
 *
 * Side Effects: Local file write only (via snapshot.ts). Never throws.
 */
export async function captureFailureSnapshot(
  page: Page | null,
  action: string,
  profile_id: string,
  reason: SnapshotReason,
  detail?: string,
): Promise<void> {
  if (!page) return
  try {
    const html = await page.content()
    saveSnapshot(html, {
      action,
      profile_id,
      reason,
      url: page.url(),
      timestamp: new Date().toISOString(),
      detail,
    })
  } catch {
    // Never let snapshot capture failure affect the read action's own result.
  }
}

/** Serialisable confidence shape used on TaskResponse (mirrors types.ts). */
export type SerialisedConfidence = ExtractionConfidence
