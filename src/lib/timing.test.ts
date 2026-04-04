/**
 * timing.test.ts - Inline tests for the timing utility module.
 *
 * Purpose: Validates jitter(), mergeTimingConfig(), and isWithinActiveHours().
 * No test framework required. Exports runTests() which logs PASS/FAIL and
 * returns { passed, failed }.
 *
 * Side Effects: Writes to stdout. Deterministic: Mostly (jitter is probabilistic).
 */

import {
  jitter,
  mergeTimingConfig,
  isWithinActiveHours,
  DEFAULT_TIMING,
  TimingRange,
  TimingConfig,
} from './timing'

/** Result summary returned by runTests(). */
export interface TestResult {
  passed: number
  failed: number
}

/**
 * Runs all timing module tests and returns a result summary.
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

  const RANGE: TimingRange = { min: 1000, max: 3000 }

  // -----------------------------------------------------------------------
  // Test 1: jitter() stays within bounds across 20 calls
  // -----------------------------------------------------------------------
  console.log('\nTest 1: jitter() bounds (20 calls, range 1000-3000)')
  const values: number[] = []
  let allInBounds = true

  for (let i = 0; i < 20; i++) {
    const value = jitter(RANGE)
    values.push(value)
    if (value < RANGE.min || value > RANGE.max) {
      allInBounds = false
      console.error(`  Out of bounds at index ${i}: ${value}`)
    }
  }
  assert('All 20 jitter() values within [1000, 3000]', allInBounds)
  console.log(`  Values: ${values.join(', ')}`)

  // -----------------------------------------------------------------------
  // Test 2: No two consecutive values identical (probabilistic, warn only)
  // -----------------------------------------------------------------------
  console.log('\nTest 2: jitter() consecutive uniqueness (probabilistic)')
  let consecutiveDuplicates = 0
  for (let i = 1; i < values.length; i++) {
    if (values[i] === values[i - 1]) {
      consecutiveDuplicates++
      console.warn(`  WARN: consecutive duplicate at index ${i}: ${values[i]}`)
    }
  }
  if (consecutiveDuplicates === 0) {
    console.log('  PASS: No consecutive duplicates')
  } else {
    console.warn(`  WARN: ${consecutiveDuplicates} duplicate(s) — probabilistically acceptable`)
  }
  // Warn only — always count as passed
  passed++

  // -----------------------------------------------------------------------
  // Test 3: mergeTimingConfig() applies overrides correctly
  // -----------------------------------------------------------------------
  console.log('\nTest 3: mergeTimingConfig() overrides')
  const overrides: Partial<TimingConfig> = {
    navigation_delay: { min: 500, max: 1000 },
    active_hours: { start: 9, end: 17 },
  }
  const merged = mergeTimingConfig(DEFAULT_TIMING, overrides)

  assert(
    'navigation_delay overridden to { min:500, max:1000 }',
    merged.navigation_delay.min === 500 && merged.navigation_delay.max === 1000
  )
  assert(
    'active_hours overridden to { start:9, end:17 }',
    merged.active_hours.start === 9 && merged.active_hours.end === 17
  )
  assert(
    'page_read_delay preserved from DEFAULT_TIMING',
    merged.page_read_delay.min === DEFAULT_TIMING.page_read_delay.min &&
    merged.page_read_delay.max === DEFAULT_TIMING.page_read_delay.max
  )
  assert(
    'DEFAULT_TIMING.navigation_delay not mutated',
    DEFAULT_TIMING.navigation_delay.min === 2000
  )

  // -----------------------------------------------------------------------
  // Test 4: isWithinActiveHours() returns a boolean
  // -----------------------------------------------------------------------
  console.log('\nTest 4: isWithinActiveHours() type and boundary checks')
  const result = isWithinActiveHours(DEFAULT_TIMING)
  assert('isWithinActiveHours() returns a boolean', typeof result === 'boolean')

  const alwaysActive = mergeTimingConfig(DEFAULT_TIMING, {
    active_hours: { start: 0, end: 24 },
  })
  assert('isWithinActiveHours() true for start:0 end:24', isWithinActiveHours(alwaysActive) === true)

  const neverActive = mergeTimingConfig(DEFAULT_TIMING, {
    active_hours: { start: 0, end: 0 },
  })
  assert('isWithinActiveHours() false for start:0 end:0', isWithinActiveHours(neverActive) === false)

  // -----------------------------------------------------------------------
  // Summary
  // -----------------------------------------------------------------------
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`)
  return { passed, failed }
}

// Run immediately when executed as main module
runTests()
