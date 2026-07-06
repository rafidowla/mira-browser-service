/**
 * confidence.ts - Extraction-confidence computation for read actions (Canon H1.4).
 *
 * Purpose: A read action returning 0 items is ambiguous — it could mean "the
 * feed/inbox/comment thread is genuinely quiet" or "the selectors broke and
 * we're extracting nothing from a page full of content." This module turns
 * per-item, per-field fallback-rank data (from selector-registry.ts) into a
 * single ExtractionConfidence report that /api/browser-task can forward to
 * the app so the UI can tell those two cases apart (Canon H1.4 requirement).
 *
 * Pure and side-effect-free: it only aggregates numbers/ranks handed to it by
 * the action files after they've run extractField() across each item.
 *
 * Side Effects: None. Deterministic: Yes.
 */

/** Per-field outcome for a single extracted item, as produced by extractField(). */
export interface FieldOutcome {
  /** Field name (e.g. "author_name", "content_text"). */
  field: string
  /** True if every selector in the field's chain missed. */
  missing: boolean
  /** Fallback-chain rank that produced the value; -1 if missing. */
  rank: number
}

/** Confidence level bucket surfaced to the app/UI. */
export type ConfidenceLevel = 'high' | 'medium' | 'low' | 'none'

/**
 * Extraction-confidence report for one read action invocation.
 *
 * `items_found` distinguishes "quiet feed" (0 items, high confidence — the
 * container selector matched the page shell fine, there just isn't content)
 * from "broken selector" (0 items *and* low confidence, or >0 items but all
 * fields empty — the container selector itself is probably stale).
 */
export interface ExtractionConfidence {
  /** Number of items (posts/comments/conversations) the container selector found. */
  items_found: number
  /** Bucketed confidence level for quick UI branching. */
  level: ConfidenceLevel
  /** Fraction of (item × field) checks that resolved to a non-missing value, 0..1. */
  field_fill_rate: number
  /** Names of fields that were empty/missing on every item (empty array if none or no items). */
  fields_missing_on_all_items: string[]
  /** Highest (worst) fallback rank used by any successfully-extracted field, or -1 if none extracted. */
  max_fallback_rank_used: number
  /** True if the container/list selector itself found zero items. */
  zero_items: boolean
}

/**
 * Computes an ExtractionConfidence report from the per-item field outcomes
 * collected while extracting a batch of items (posts, comments, profiles-as-
 * a-single-item, or conversations).
 *
 * @param itemFieldOutcomes - One array of FieldOutcome per extracted item.
 *   An empty outer array means the container selector found zero items.
 * @returns ExtractionConfidence summarising fill rate, missing fields, and level.
 *
 * Deterministic: Yes. Side Effects: None.
 */
export function computeConfidence(itemFieldOutcomes: FieldOutcome[][]): ExtractionConfidence {
  const items_found = itemFieldOutcomes.length
  const zero_items = items_found === 0

  if (zero_items) {
    // Zero items is not automatically low confidence — a genuinely quiet feed
    // looks the same at this layer. Callers that also know the container
    // selector matched *something* on the page (e.g. the shell rendered)
    // should treat 'none'-with-zero-items as plausible; only pair this with
    // an auth-wall check or a thrown error to call it "broken".
    return {
      items_found: 0,
      level: 'none',
      field_fill_rate: 0,
      fields_missing_on_all_items: [],
      max_fallback_rank_used: -1,
      zero_items: true,
    }
  }

  const fieldNames = new Set<string>()
  for (const outcomes of itemFieldOutcomes) {
    for (const o of outcomes) fieldNames.add(o.field)
  }

  let totalChecks = 0
  let filledChecks = 0
  let maxRank = -1
  const missingCountByField = new Map<string, number>()

  for (const outcomes of itemFieldOutcomes) {
    for (const o of outcomes) {
      totalChecks++
      if (o.missing) {
        missingCountByField.set(o.field, (missingCountByField.get(o.field) ?? 0) + 1)
      } else {
        filledChecks++
        if (o.rank > maxRank) maxRank = o.rank
      }
    }
  }

  const field_fill_rate = totalChecks === 0 ? 0 : filledChecks / totalChecks

  const fields_missing_on_all_items = Array.from(fieldNames).filter(
    (field) => (missingCountByField.get(field) ?? 0) === items_found,
  )

  let level: ConfidenceLevel
  if (field_fill_rate >= 0.75) {
    level = 'high'
  } else if (field_fill_rate >= 0.4) {
    level = 'medium'
  } else if (field_fill_rate > 0) {
    level = 'low'
  } else {
    level = 'none'
  }

  return {
    items_found,
    level,
    field_fill_rate,
    fields_missing_on_all_items,
    max_fallback_rank_used: maxRank,
    zero_items: false,
  }
}

/**
 * Decides whether an ExtractionConfidence report is bad enough to warrant an
 * on-failure DOM snapshot for offline selector repair (Canon H1.4 item 3).
 *
 * Triggers on: zero items AND nothing to indicate a benign "quiet" read
 * (callers pass `pageLooksEmpty=false` when they have independent evidence,
 * e.g. a known "no results" marker, that zero items is expected), OR any
 * non-zero-item extraction where confidence is 'low' or 'none' (items were
 * found but fields came back empty — selectors are stale, not the content).
 *
 * @param confidence - The computed ExtractionConfidence.
 * @param pageLooksEmpty - True when the caller has independent evidence the
 *   page is legitimately empty (e.g. a "You're all caught up" marker). Only
 *   relevant when items_found === 0; defaults to false (be conservative —
 *   snapshot unless proven benign).
 */
export function shouldSnapshotOnLowConfidence(
  confidence: ExtractionConfidence,
  pageLooksEmpty = false,
): boolean {
  if (confidence.zero_items) {
    return !pageLooksEmpty
  }
  return confidence.level === 'low' || confidence.level === 'none'
}
