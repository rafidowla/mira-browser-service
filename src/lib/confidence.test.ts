/**
 * confidence.test.ts - Inline tests for computeConfidence() and
 * shouldSnapshotOnLowConfidence() (Canon H1.4).
 *
 * Purpose: Validates the confidence-bucketing math and the on-failure
 * snapshot trigger decision using plain FieldOutcome fixtures — no live
 * browser required. Exports runTests(), mirroring lib/timing.test.ts.
 *
 * Side Effects: Writes to stdout. Deterministic: Yes.
 */

import { computeConfidence, shouldSnapshotOnLowConfidence, type FieldOutcome } from './confidence'

/** Result summary returned by runTests(). */
export interface TestResult {
  passed: number
  failed: number
}

function outcome(field: string, missing: boolean, rank: number): FieldOutcome {
  return { field, missing, rank }
}

/**
 * Runs all confidence tests and returns a result summary.
 *
 * @returns TestResult with counts of passed and failed assertions.
 */
export function runTests(): TestResult {
  let passed = 0
  let failed = 0

  function assert(label: string, condition: boolean): void {
    if (condition) {
      console.log(`  PASS: ${label}`)
      passed++
    } else {
      console.error(`  FAIL: ${label}`)
      failed++
    }
  }

  // -----------------------------------------------------------------------
  // Test 1: zero items -> 'none' level, zero_items true, not itself an error
  // -----------------------------------------------------------------------
  console.log('\nTest 1: computeConfidence([]) — the "quiet feed" shape')
  {
    const result = computeConfidence([])
    assert('items_found is 0', result.items_found === 0)
    assert('zero_items is true', result.zero_items === true)
    assert('level is "none"', result.level === 'none')
    assert('field_fill_rate is 0', result.field_fill_rate === 0)
  }

  // -----------------------------------------------------------------------
  // Test 2: all fields present on all items -> 'high' confidence
  // -----------------------------------------------------------------------
  console.log('\nTest 2: computeConfidence() — all fields present -> high confidence')
  {
    const perfectItem: FieldOutcome[] = [
      outcome('author_name', false, 0),
      outcome('content_text', false, 0),
      outcome('post_url', false, 1),
    ]
    const result = computeConfidence([perfectItem, perfectItem, perfectItem])
    assert('items_found is 3', result.items_found === 3)
    assert('zero_items is false', result.zero_items === false)
    assert('field_fill_rate is 1', result.field_fill_rate === 1)
    assert('level is "high"', result.level === 'high')
    assert('fields_missing_on_all_items is empty', result.fields_missing_on_all_items.length === 0)
    assert('max_fallback_rank_used is 1', result.max_fallback_rank_used === 1)
  }

  // -----------------------------------------------------------------------
  // Test 3: one field missing on every item -> flagged in fields_missing_on_all_items
  // -----------------------------------------------------------------------
  console.log('\nTest 3: computeConfidence() — a field missing on every item is flagged')
  {
    const itemA: FieldOutcome[] = [outcome('author_name', false, 0), outcome('author_headline', true, -1)]
    const itemB: FieldOutcome[] = [outcome('author_name', false, 0), outcome('author_headline', true, -1)]
    const result = computeConfidence([itemA, itemB])
    assert(
      'fields_missing_on_all_items contains "author_headline"',
      result.fields_missing_on_all_items.includes('author_headline'),
    )
    assert(
      'fields_missing_on_all_items does not contain "author_name"',
      !result.fields_missing_on_all_items.includes('author_name'),
    )
    // 0.5 fill rate lands in the "medium" bucket (>= 0.4 threshold) — a field
    // missing on every item is still surfaced via fields_missing_on_all_items
    // regardless of the overall bucket, which is what the app actually acts on.
    assert('field_fill_rate is 0.5', result.field_fill_rate === 0.5)
    assert('level is "medium"', result.level === 'medium')
  }

  // -----------------------------------------------------------------------
  // Test 4: items found but every field missing on every item -> 'none' (broken selector)
  // -----------------------------------------------------------------------
  console.log('\nTest 4: computeConfidence() — items found but all fields empty -> "none" (broken selector signature)')
  {
    const brokenItem: FieldOutcome[] = [
      outcome('author_name', true, -1),
      outcome('content_text', true, -1),
    ]
    const result = computeConfidence([brokenItem, brokenItem])
    assert('items_found is 2', result.items_found === 2)
    assert('zero_items is false', result.zero_items === false)
    assert('field_fill_rate is 0', result.field_fill_rate === 0)
    assert('level is "none"', result.level === 'none')
  }

  // -----------------------------------------------------------------------
  // Test 5: medium confidence bucket boundary
  // -----------------------------------------------------------------------
  console.log('\nTest 5: computeConfidence() — medium confidence bucket (0.4 <= rate < 0.75)')
  {
    // 2 of 4 checks filled = 0.5 fill rate
    const item: FieldOutcome[] = [
      outcome('a', false, 0),
      outcome('b', false, 0),
      outcome('c', true, -1),
      outcome('d', true, -1),
    ]
    const result = computeConfidence([item])
    assert('field_fill_rate is 0.5', result.field_fill_rate === 0.5)
    assert('level is "medium"', result.level === 'medium')
  }

  // -----------------------------------------------------------------------
  // Test 6: shouldSnapshotOnLowConfidence() decision matrix
  // -----------------------------------------------------------------------
  console.log('\nTest 6: shouldSnapshotOnLowConfidence() decision matrix')
  {
    const quiet = computeConfidence([])
    assert('zero items, not proven benign -> snapshot', shouldSnapshotOnLowConfidence(quiet, false) === true)
    assert('zero items, proven benign (pageLooksEmpty) -> no snapshot', shouldSnapshotOnLowConfidence(quiet, true) === false)

    const highConf = computeConfidence([[outcome('a', false, 0)]])
    assert('high confidence, non-zero items -> no snapshot', shouldSnapshotOnLowConfidence(highConf) === false)

    const noneConf = computeConfidence([[outcome('a', true, -1)]])
    assert('none confidence, non-zero items -> snapshot', shouldSnapshotOnLowConfidence(noneConf) === true)

    const lowConf = computeConfidence([
      [outcome('a', false, 0), outcome('b', true, -1), outcome('c', true, -1), outcome('d', true, -1)],
    ])
    assert('low confidence -> snapshot', shouldSnapshotOnLowConfidence(lowConf) === true)
  }

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`)
  return { passed, failed }
}

// Run immediately when executed as main module
const { failed } = runTests()
if (failed > 0) process.exitCode = 1
