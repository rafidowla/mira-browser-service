/**
 * read-profile.ts - LinkedIn public profile reader.
 *
 * Purpose: Navigates to a LinkedIn profile URL and extracts enrichment data
 * for a target professional, via the selector-registry fallback chains
 * (Canon H1.4). Used by MIRA for creator intelligence and audience research.
 * All fields failsafe to "" and every field's outcome is tracked so an
 * ExtractionConfidence report can distinguish a genuinely sparse profile from
 * a broken selector.
 *
 * Side Effects: Browser navigation; mutex acquire/release; on-failure DOM
 * snapshot to local disk only (Canon H1.4 item 3).
 * Deterministic: No. Concurrency: Mutex-protected.
 */

import type { Page } from 'playwright'
import { contextManager } from '../lib/context'
import { humanDelay, jitter, TimingConfig } from '../lib/timing'
import { extractField, PROFILE_SELECTORS, LOGIN_CONFIRMED_MARKERS } from '../lib/selector-registry'
import { computeConfidence, shouldSnapshotOnLowConfidence, type ExtractionConfidence, type FieldOutcome } from '../lib/confidence'
import { detectAuthWall, captureFailureSnapshot, waitForPageSettled } from '../lib/read-action-support'
import type { AuthWallReason } from '../lib/auth-wall'

/** Enrichment data extracted from a LinkedIn public profile page. */
export interface LinkedInProfile {
  /** LinkedIn profile identifier (extracted from URL slug). */
  profile_id: string
  /** Full display name. */
  full_name: string
  /** Professional headline. */
  headline: string
  /** Location string as shown on profile. */
  location: string
  /** About/summary section text. */
  about: string
  /** Current employer company name. */
  current_company: string
  /** Current job title/role. */
  current_role: string
  /** Connection degree (1st, 2nd, 3rd+). */
  connection_degree: string
  /** Follower count string (e.g. "12,345 followers"). */
  follower_count: string
  /** Full URL to this LinkedIn profile. */
  profile_url: string
}

/** Result of a readProfile() invocation: extracted profile plus confidence/auth-wall state. */
export interface ReadProfileResult {
  profile: LinkedInProfile
  confidence: ExtractionConfidence
  auth_wall: boolean
  auth_wall_reason: AuthWallReason
}

function emptyProfileFor(target_profile_url: string): LinkedInProfile {
  return {
    profile_id: "", full_name: "", headline: "", location: "",
    about: "", current_company: "", current_role: "",
    connection_degree: "", follower_count: "",
    profile_url: target_profile_url,
  }
}

/**
 * Content container used as the "empty authed shell" signal for profile
 * pages, widened with LOGIN_CONFIRMED_MARKERS — see read-feed.ts for why.
 */
const PROFILE_PRIMARY_CONTAINER = [
  'main.scaffold-layout__main',
  '.scaffold-layout__main',
  ...LOGIN_CONFIRMED_MARKERS,
].join(', ')

/**
 * Reads a public LinkedIn profile for enrichment data.
 *
 * @param profile_id - MIRA profile with an active browser context.
 * @param target_profile_url - Full URL to the LinkedIn profile to read.
 * @param timing - TimingConfig for delays and scroll behaviour.
 * @returns ReadProfileResult with the populated LinkedInProfile (fields default
 *   to "" on extraction failure), an ExtractionConfidence report treating the
 *   single profile as one "item" for fill-rate purposes, and auth-wall state.
 *
 * Side Effects: Browser navigation; mutex acquire/release; console logging;
 * on-failure DOM snapshot to local disk only.
 * Error Behavior: All errors caught.
 */
export async function readProfile(
  profile_id: string,
  target_profile_url: string,
  timing: TimingConfig,
): Promise<ReadProfileResult> {
  const emptyResult: ReadProfileResult = {
    profile: emptyProfileFor(target_profile_url),
    confidence: computeConfidence([]),
    auth_wall: false,
    auth_wall_reason: null,
  }

  const context = contextManager.getContext(profile_id)
  if (!context) {
    console.warn(`[readProfile] No context for profile ${profile_id}`)
    return emptyResult
  }
  if (!contextManager.acquireMutex(profile_id)) {
    console.warn(`[readProfile] Mutex blocked for profile ${profile_id}`)
    return emptyResult
  }

  let page: Page | null = null
  try {
    page = await context.newPage() as unknown as Page
    // Bring to front — see read-feed.ts for why (avoids background-tab throttling).
    await page.bringToFront().catch(() => undefined)
    await page.goto(target_profile_url, { waitUntil: "domcontentloaded", timeout: 30000 })
    await waitForPageSettled(page, PROFILE_PRIMARY_CONTAINER)
    await humanDelay(timing.page_read_delay)

    const authWall = await detectAuthWall(page, PROFILE_PRIMARY_CONTAINER)
    if (authWall.auth_wall) {
      console.warn(`[readProfile] Auth wall detected for profile ${profile_id}: ${authWall.reason}`)
      await captureFailureSnapshot(page, 'read-profile', profile_id, 'auth_wall', authWall.reason ?? undefined)
      return {
        profile: emptyProfileFor(target_profile_url),
        confidence: computeConfidence([]),
        auth_wall: true,
        auth_wall_reason: authWall.reason,
      }
    }

    const scrollPx = jitter(timing.scroll_amount)
    await page.evaluate((px: number) => window.scrollBy(0, px), scrollPx)
    await humanDelay(timing.action_delay)

    const outcomes: FieldOutcome[] = []
    const queryText = (field: string, chain: readonly string[]) =>
      extractField<string>(
        chain,
        (sel) => page!.$eval(sel, (el) => el.textContent?.trim() ?? '').catch(() => undefined),
        '',
      ).then((r) => {
        outcomes.push({ field, missing: r.missing, rank: r.rank })
        return r.value
      })

    const profile: LinkedInProfile = {
      profile_url: target_profile_url,
      profile_id: target_profile_url.match(/linkedin\.com\/in\/([^/?]+)/)?.[1] ?? "",
      full_name: await queryText('full_name', PROFILE_SELECTORS.full_name),
      headline: await queryText('headline', PROFILE_SELECTORS.headline),
      location: await queryText('location', PROFILE_SELECTORS.location),
      about: await queryText('about', PROFILE_SELECTORS.about),
      current_company: await queryText('current_company', PROFILE_SELECTORS.current_company),
      current_role: await queryText('current_role', PROFILE_SELECTORS.current_role),
      connection_degree: await queryText('connection_degree', PROFILE_SELECTORS.connection_degree),
      follower_count: await queryText('follower_count', PROFILE_SELECTORS.follower_count),
    }

    // A profile is one "item" for confidence purposes: its own field set.
    const confidence = computeConfidence([outcomes])
    console.log(`[readProfile] Extracted profile: ${profile.full_name} (${profile.headline}) (confidence: ${confidence.level})`)

    if (shouldSnapshotOnLowConfidence(confidence, /* pageLooksEmpty */ false)) {
      await captureFailureSnapshot(page, 'read-profile', profile_id, 'low_confidence')
    }

    return { profile, confidence, auth_wall: false, auth_wall_reason: null }

  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[readProfile] Error: ${message}`)
    await captureFailureSnapshot(page, 'read-profile', profile_id, 'thrown_error', message)
    return emptyResult
  } finally {
    await page?.close().catch(() => undefined)
    contextManager.releaseMutex(profile_id)
  }
}
