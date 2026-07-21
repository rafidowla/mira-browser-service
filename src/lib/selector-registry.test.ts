/**
 * selector-registry.test.ts - Inline tests for extractField() fallback
 * selection (Canon H1.4).
 *
 * Purpose: Validates that extractField() tries selectors in order, stops at
 * the first present value, records the correct rank, and reports `missing`
 * when every selector in the chain misses. No test framework required.
 * Exports runTests() which logs PASS/FAIL and returns { passed, failed },
 * mirroring lib/timing.test.ts's convention.
 *
 * Side Effects: Writes to stdout. Deterministic: Yes.
 */

import { extractField, LOGIN_CONFIRMED_MARKERS, type FieldQuery } from './selector-registry'

/** Result summary returned by runTests(). */
export interface TestResult {
  passed: number
  failed: number
}

/**
 * Runs all selector-registry tests and returns a result summary.
 *
 * @returns TestResult with counts of passed and failed assertions.
 */
export async function runTests(): Promise<TestResult> {
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
  // Test 0: LOGIN_CONFIRMED_MARKERS must stay obfuscation-resistant.
  // Live H1.4 validation (2026-07-10) found LinkedIn serving hashed CSS class
  // names, so a class/id-only logged-in marker (the old `#primary-nav`) never
  // matched and every quiet/empty feed tripped a false `empty_authed_shell`.
  // At least one marker must be a bare semantic tag (nav/main/header/...), which
  // survives class obfuscation, so "are we logged in / is the feed just empty"
  // stays reliable. Guards against regressing to a class/id-only marker set.
  // -----------------------------------------------------------------------
  console.log('\nTest 0: LOGIN_CONFIRMED_MARKERS includes an obfuscation-resistant semantic tag')
  {
    const hasSemanticTag = LOGIN_CONFIRMED_MARKERS.some((m) => /^[a-z][a-z0-9]*$/.test(m))
    assert('at least one bare semantic-tag marker (not only .class/#id)', hasSemanticTag)
    assert('includes <nav>', (LOGIN_CONFIRMED_MARKERS as readonly string[]).includes('nav'))
  }

  // -----------------------------------------------------------------------
  // Test 1: first selector hits -> rank 0, missing false
  // -----------------------------------------------------------------------
  console.log('\nTest 1: extractField() picks rank 0 when the first selector hits')
  {
    const chain = ['.a', '.b', '.c'] as const
    const fixture: Record<string, string> = { '.a': 'Alice' }
    const query: FieldQuery<string> = async (sel) => fixture[sel]
    const result = await extractField(chain, query, '')
    assert('value is "Alice"', result.value === 'Alice')
    assert('rank is 0', result.rank === 0)
    assert('missing is false', result.missing === false)
  }

  // -----------------------------------------------------------------------
  // Test 2: first selector misses, second hits -> rank 1
  // -----------------------------------------------------------------------
  console.log('\nTest 2: extractField() falls back to rank 1 when rank 0 misses')
  {
    const chain = ['.a', '.b', '.c'] as const
    const fixture: Record<string, string> = { '.b': 'Bob' }
    const query: FieldQuery<string> = async (sel) => fixture[sel]
    const result = await extractField(chain, query, '')
    assert('value is "Bob"', result.value === 'Bob')
    assert('rank is 1', result.rank === 1)
    assert('missing is false', result.missing === false)
  }

  // -----------------------------------------------------------------------
  // Test 3: all selectors miss -> missing true, rank -1, emptyValue returned
  // -----------------------------------------------------------------------
  console.log('\nTest 3: extractField() reports missing when every selector misses')
  {
    const chain = ['.a', '.b', '.c'] as const
    const query: FieldQuery<string> = async () => undefined
    const result = await extractField(chain, query, 'DEFAULT')
    assert('value is the emptyValue sentinel', result.value === 'DEFAULT')
    assert('rank is -1', result.rank === -1)
    assert('missing is true', result.missing === true)
  }

  // -----------------------------------------------------------------------
  // Test 4: empty-string values count as missing (whitespace-trimmed)
  // -----------------------------------------------------------------------
  console.log('\nTest 4: extractField() treats blank/whitespace strings as missing')
  {
    const chain = ['.a', '.b'] as const
    const fixture: Record<string, string> = { '.a': '   ', '.b': 'real value' }
    const query: FieldQuery<string> = async (sel) => fixture[sel]
    const result = await extractField(chain, query, '')
    assert('falls through blank rank 0 to rank 1', result.rank === 1)
    assert('value is "real value"', result.value === 'real value')
  }

  // -----------------------------------------------------------------------
  // Test 5: a selector that throws is treated as a miss, not a hard failure
  // -----------------------------------------------------------------------
  console.log('\nTest 5: extractField() treats a throwing query as a miss and continues')
  {
    const chain = ['.a', '.b'] as const
    const query: FieldQuery<string> = async (sel) => {
      if (sel === '.a') throw new Error('selector engine error')
      return 'survived'
    }
    const result = await extractField(chain, query, '')
    assert('falls through the throwing selector to rank 1', result.rank === 1)
    assert('value is "survived"', result.value === 'survived')
    assert('missing is false', result.missing === false)
  }

  // -----------------------------------------------------------------------
  // Test 6: numeric fields — 0 counts as present, NaN counts as missing
  // -----------------------------------------------------------------------
  console.log('\nTest 6: extractField() numeric semantics (0 present, NaN missing)')
  {
    const chain = ['.count'] as const
    const zeroQuery: FieldQuery<number> = async () => 0
    const zeroResult = await extractField(chain, zeroQuery, -1)
    assert('numeric 0 counts as present', zeroResult.missing === false && zeroResult.value === 0)

    const nanQuery: FieldQuery<number> = async () => NaN
    const nanResult = await extractField(chain, nanQuery, -1)
    assert('NaN counts as missing', nanResult.missing === true)
  }

  // -----------------------------------------------------------------------
  // Test 7: boolean false counts as present (e.g. is_reply: false is real data)
  // -----------------------------------------------------------------------
  console.log('\nTest 7: extractField() boolean semantics (false is present)')
  {
    const chain = ['.is_reply'] as const
    const query: FieldQuery<boolean> = async () => false
    const result = await extractField(chain, query, false)
    assert('boolean false counts as present', result.missing === false && result.rank === 0)
  }

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`)
  return { passed, failed }
}

// Run immediately when executed as main module
runTests().then(({ failed }) => {
  if (failed > 0) process.exitCode = 1
})
