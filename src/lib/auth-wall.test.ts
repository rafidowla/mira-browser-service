/**
 * auth-wall.test.ts - Inline tests for classifyAuthWall() (Canon H1.4 item 4).
 *
 * Purpose: Validates auth-wall classification from sample HTML-derived
 * string signals (URL/title/body text/DOM-marker flags) — no live browser
 * required. Covers the three detectable shapes (login page, checkpoint/
 * challenge, empty authed shell) plus the normal/non-wall case, and the
 * precedence rule (checkpoint takes priority over login). Exports
 * runTests(), mirroring lib/timing.test.ts.
 *
 * Side Effects: Writes to stdout. Deterministic: Yes.
 */

import { classifyAuthWall, type AuthWallSignals } from './auth-wall'

/** Result summary returned by runTests(). */
export interface TestResult {
  passed: number
  failed: number
}

const BASE_SIGNALS: AuthWallSignals = {
  url: 'https://www.linkedin.com/feed/',
  title: 'LinkedIn',
  bodyTextSample: '',
  hasLoginFormMarker: false,
  hasChallengeMarker: false,
  hasPrimaryContentContainer: true,
}

/**
 * Runs all auth-wall classification tests and returns a result summary.
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
  // Test 1: a normal, fully-rendered feed page is not an auth wall
  // -----------------------------------------------------------------------
  console.log('\nTest 1: classifyAuthWall() — normal authenticated page')
  {
    const result = classifyAuthWall(BASE_SIGNALS)
    assert('auth_wall is false', result.auth_wall === false)
    assert('reason is null', result.reason === null)
  }

  // -----------------------------------------------------------------------
  // Test 2: URL-based login-wall detection
  // -----------------------------------------------------------------------
  console.log('\nTest 2: classifyAuthWall() — login wall via URL redirect')
  {
    const result = classifyAuthWall({
      ...BASE_SIGNALS,
      url: 'https://www.linkedin.com/uas/login?session_redirect=%2Ffeed%2F',
      title: 'LinkedIn Login, Sign in | LinkedIn',
      hasPrimaryContentContainer: false,
    })
    assert('auth_wall is true', result.auth_wall === true)
    assert('reason is "login_page"', result.reason === 'login_page')
  }

  // -----------------------------------------------------------------------
  // Test 3: DOM-marker-based login-wall detection (URL/title look normal)
  // -----------------------------------------------------------------------
  console.log('\nTest 3: classifyAuthWall() — login wall via DOM marker only')
  {
    const result = classifyAuthWall({
      ...BASE_SIGNALS,
      hasLoginFormMarker: true,
      hasPrimaryContentContainer: false,
    })
    assert('auth_wall is true', result.auth_wall === true)
    assert('reason is "login_page"', result.reason === 'login_page')
  }

  // -----------------------------------------------------------------------
  // Test 4: checkpoint/challenge page detection
  // -----------------------------------------------------------------------
  console.log('\nTest 4: classifyAuthWall() — security checkpoint/challenge page')
  {
    const result = classifyAuthWall({
      ...BASE_SIGNALS,
      url: 'https://www.linkedin.com/checkpoint/challenge/',
      title: "Let's do a quick security check",
      hasPrimaryContentContainer: false,
    })
    assert('auth_wall is true', result.auth_wall === true)
    assert('reason is "checkpoint"', result.reason === 'checkpoint')
  }

  // -----------------------------------------------------------------------
  // Test 5: checkpoint takes precedence over login when both markers present
  // -----------------------------------------------------------------------
  console.log('\nTest 5: classifyAuthWall() — checkpoint precedence over login markers')
  {
    const result = classifyAuthWall({
      ...BASE_SIGNALS,
      hasLoginFormMarker: true,
      hasChallengeMarker: true,
      hasPrimaryContentContainer: false,
    })
    assert('reason is "checkpoint", not "login_page"', result.reason === 'checkpoint')
  }

  // -----------------------------------------------------------------------
  // Test 6: empty authed shell — normal URL/title, but content never rendered
  // -----------------------------------------------------------------------
  console.log('\nTest 6: classifyAuthWall() — empty authed shell (silent session expiry)')
  {
    const result = classifyAuthWall({
      ...BASE_SIGNALS,
      hasPrimaryContentContainer: false,
    })
    assert('auth_wall is true', result.auth_wall === true)
    assert('reason is "empty_authed_shell"', result.reason === 'empty_authed_shell')
  }

  // -----------------------------------------------------------------------
  // Test 7: missing content container on a non-LinkedIn URL is NOT flagged
  // as an auth wall (wrong-URL bug, different class of problem)
  // -----------------------------------------------------------------------
  console.log('\nTest 7: classifyAuthWall() — missing container off-domain is not an auth wall')
  {
    const result = classifyAuthWall({
      ...BASE_SIGNALS,
      url: 'https://example.com/some-error-page',
      hasPrimaryContentContainer: false,
    })
    assert('auth_wall is false', result.auth_wall === false)
    assert('reason is null', result.reason === null)
  }

  // -----------------------------------------------------------------------
  // Test 8: body-text-only signal (no explicit DOM marker) still catches a login wall
  // -----------------------------------------------------------------------
  console.log('\nTest 8: classifyAuthWall() — body text substring catches a login wall')
  {
    const result = classifyAuthWall({
      ...BASE_SIGNALS,
      bodyTextSample: 'Welcome Back Sign in to LinkedIn to continue your professional journey.',
      hasPrimaryContentContainer: false,
    })
    assert('auth_wall is true', result.auth_wall === true)
    assert('reason is "login_page"', result.reason === 'login_page')
  }

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`)
  return { passed, failed }
}

// Run immediately when executed as main module
const { failed } = runTests()
if (failed > 0) process.exitCode = 1
