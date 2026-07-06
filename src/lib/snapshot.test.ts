/**
 * snapshot.test.ts - Inline tests for buildSnapshotBaseName() (Canon H1.4
 * item 3).
 *
 * Purpose: Validates the deterministic, filesystem-safe filename-building
 * logic for on-failure DOM snapshots — the pure part of snapshot.ts. Does
 * NOT test saveSnapshot() itself (that touches the real filesystem and is
 * exercised manually during live H1.4/H1.9 sessions); this file only checks
 * the naming contract stays stable and safe. Exports runTests(), mirroring
 * lib/timing.test.ts.
 *
 * Side Effects: Writes to stdout. Deterministic: Yes.
 */

import { buildSnapshotBaseName } from './snapshot'

/** Result summary returned by runTests(). */
export interface TestResult {
  passed: number
  failed: number
}

/**
 * Runs all snapshot filename tests and returns a result summary.
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
  // Test 1: basic shape includes action, profile, reason, and a safe timestamp
  // -----------------------------------------------------------------------
  console.log('\nTest 1: buildSnapshotBaseName() basic shape')
  {
    const name = buildSnapshotBaseName('read-feed', 'test-profile', 'low_confidence', '2026-07-06T12:00:00.000Z')
    assert('contains action', name.includes('read-feed'))
    assert('contains profile_id', name.includes('test-profile'))
    assert('contains reason', name.includes('low_confidence'))
    assert('has no colon characters (filesystem-unsafe on some OSes)', !name.includes(':'))
  }

  // -----------------------------------------------------------------------
  // Test 2: unsafe characters in profile_id are sanitised
  // -----------------------------------------------------------------------
  console.log('\nTest 2: buildSnapshotBaseName() sanitises unsafe characters')
  {
    const name = buildSnapshotBaseName('read-comments', '../../etc/passwd', 'thrown_error', '2026-07-06T12:00:00.000Z')
    assert('no path traversal characters survive', !name.includes('/') && !name.includes('..'))
  }

  // -----------------------------------------------------------------------
  // Test 3: deterministic given identical inputs
  // -----------------------------------------------------------------------
  console.log('\nTest 3: buildSnapshotBaseName() is deterministic')
  {
    const a = buildSnapshotBaseName('read-profile', 'p1', 'auth_wall', '2026-07-06T00:00:00.000Z')
    const b = buildSnapshotBaseName('read-profile', 'p1', 'auth_wall', '2026-07-06T00:00:00.000Z')
    assert('same inputs produce the same filename', a === b)
  }

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`)
  return { passed, failed }
}

// Run immediately when executed as main module
const { failed } = runTests()
if (failed > 0) process.exitCode = 1
