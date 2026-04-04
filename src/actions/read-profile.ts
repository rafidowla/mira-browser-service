/**
 * read-profile.ts - LinkedIn public profile reader.
 *
 * Purpose: Navigates to a LinkedIn profile URL and extracts enrichment data
 * for a target professional. Used by MIRA for creator intelligence and
 * audience research. Best-effort extraction — all fields failsafe to "".
 *
 * Side Effects: Browser navigation; mutex acquire/release.
 * Deterministic: No. Concurrency: Mutex-protected.
 */

import type { Page } from 'playwright'
import { contextManager } from '../lib/context'
import { humanDelay, jitter, TimingConfig } from '../lib/timing'

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

/**
 * Reads a public LinkedIn profile for enrichment data.
 *
 * @param profile_id - MIRA profile with an active browser context.
 * @param target_profile_url - Full URL to the LinkedIn profile to read.
 * @param timing - TimingConfig for delays and scroll behaviour.
 * @returns Populated LinkedInProfile. All fields default to "" on extraction failure.
 *
 * Side Effects: Browser navigation; mutex acquire/release; console logging.
 * Error Behavior: All errors caught — returns empty-string LinkedInProfile.
 */
export async function readProfile(
  profile_id: string,
  target_profile_url: string,
  timing: TimingConfig,
): Promise<LinkedInProfile> {
  const emptyProfile: LinkedInProfile = {
    profile_id: "", full_name: "", headline: "", location: "",
    about: "", current_company: "", current_role: "",
    connection_degree: "", follower_count: "",
    profile_url: target_profile_url,
  }

  const context = contextManager.getContext(profile_id)
  if (!context) {
    console.warn(`[readProfile] No context for profile ${profile_id}`)
    return emptyProfile
  }
  if (!contextManager.acquireMutex(profile_id)) {
    console.warn(`[readProfile] Mutex blocked for profile ${profile_id}`)
    return emptyProfile
  }

  let page: Page | null = null
  try {
    page = await context.newPage() as unknown as Page
    await page.goto(target_profile_url, { waitUntil: "domcontentloaded", timeout: 30000 })
    await humanDelay(timing.page_read_delay)

    const scrollPx = jitter(timing.scroll_amount)
    await page.evaluate((px: number) => window.scrollBy(0, px), scrollPx)
    await humanDelay(timing.action_delay)

    const getText = async (sel: string) =>
      page!.$eval(sel, (el) => el.textContent?.trim() ?? "").catch(() => "")

    const profile: LinkedInProfile = {
      profile_url: target_profile_url,
      profile_id: target_profile_url.match(/linkedin\.com\/in\/([^/?]+)/)?.[1] ?? "",
      full_name: await getText(".text-heading-xlarge"),
      headline: await getText(".text-body-medium.break-words"),
      location: await getText(".text-body-small.inline.t-black--light.break-words"),
      about: await getText("#about ~ .pvs-list__outer-container .visually-hidden"),
      current_company: await getText(".pv-text-details__right-panel .inline-show-more-text"),
      current_role: await getText(".experience-section .pv-entity__summary-info h3"),
      connection_degree: await getText(".dist-value"),
      follower_count: await getText(".pvs-header__subtitle span"),
    }

    console.log(`[readProfile] Extracted profile: ${profile.full_name} (${profile.headline})`)
    return profile

  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[readProfile] Error: ${message}`)
    return emptyProfile
  } finally {
    await page?.close().catch(() => undefined)
    contextManager.releaseMutex(profile_id)
  }
}
