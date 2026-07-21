/**
 * login-check.test.ts - Inline tests for evaluateLoginCookies() (2026-07-11).
 *
 * Purpose: Validates the navigation-free LinkedIn login verdict from a cookie
 * set — the replacement for the fragile read-feed-based connection probe that
 * produced false "not connected" results on every pilot build. Covers: valid
 * li_at → logged in; absent li_at → not logged in (no_li_at); expired li_at →
 * not logged in (cookie_expired); session cookie (expires -1) → logged in;
 * empty-value li_at → not logged in. No live browser required. Exports
 * runTests(), mirroring the other lib/*.test.ts files.
 *
 * Side Effects: Writes to stdout. Deterministic: Yes (time is injected).
 */

import { evaluateLoginCookies, type LoginCookie } from './context'

export interface TestResult {
  passed: number
  failed: number
}

/** Fixed reference "now": 2026-07-11T00:00:00Z in ms. */
const NOW_MS = 1783641600000
const NOW_SEC = NOW_MS / 1000

export function runTests(): TestResult {
  let passed = 0
  let failed = 0

  function assert(label: string, condition: boolean): void {
    if (condition) {
      passed++
      console.log(`  PASS: ${label}`)
    } else {
      failed++
      console.log(`  FAIL: ${label}`)
    }
  }

  console.log('Test 1: valid li_at (future expiry) → logged in')
  {
    const cookies: LoginCookie[] = [
      { name: 'li_at', value: 'AQEDAT...', expires: NOW_SEC + 86400 },
      { name: 'JSESSIONID', value: 'ajax:123', expires: NOW_SEC + 86400 },
    ]
    const r = evaluateLoginCookies(cookies, NOW_MS)
    assert('logged_in is true', r.logged_in === true)
    assert('reason is null', r.reason === null)
    assert('li_at_present diagnostic true', r.diagnostics.li_at_present === true)
    assert('cookie count reported', r.diagnostics.linkedin_cookie_count === 2)
  }

  console.log('Test 2: no li_at → not logged in (no_li_at)')
  {
    const cookies: LoginCookie[] = [{ name: 'bcookie', value: 'v=2', expires: NOW_SEC + 86400 }]
    const r = evaluateLoginCookies(cookies, NOW_MS)
    assert('logged_in is false', r.logged_in === false)
    assert('reason is no_li_at', r.reason === 'no_li_at')
    assert('li_at_present diagnostic false', r.diagnostics.li_at_present === false)
  }

  console.log('Test 3: expired li_at → not logged in (cookie_expired)')
  {
    const cookies: LoginCookie[] = [{ name: 'li_at', value: 'stale', expires: NOW_SEC - 3600 }]
    const r = evaluateLoginCookies(cookies, NOW_MS)
    assert('logged_in is false', r.logged_in === false)
    assert('reason is cookie_expired', r.reason === 'cookie_expired')
    assert('li_at_expired diagnostic true', r.diagnostics.li_at_expired === true)
  }

  console.log('Test 4: session li_at (expires -1, no expiry) → logged in')
  {
    const cookies: LoginCookie[] = [{ name: 'li_at', value: 'session', expires: -1 }]
    const r = evaluateLoginCookies(cookies, NOW_MS)
    assert('logged_in is true', r.logged_in === true)
    assert('reason is null', r.reason === null)
    assert('li_at_expired diagnostic false', r.diagnostics.li_at_expired === false)
  }

  console.log('Test 5: empty-value li_at → not logged in')
  {
    const cookies: LoginCookie[] = [{ name: 'li_at', value: '', expires: NOW_SEC + 86400 }]
    const r = evaluateLoginCookies(cookies, NOW_MS)
    assert('logged_in is false', r.logged_in === false)
  }

  console.log('Test 6: empty cookie jar → not logged in, count 0')
  {
    const r = evaluateLoginCookies([], NOW_MS)
    assert('logged_in is false', r.logged_in === false)
    assert('reason is no_li_at', r.reason === 'no_li_at')
    assert('cookie count 0', r.diagnostics.linkedin_cookie_count === 0)
  }

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`)
  return { passed, failed }
}

runTests()
