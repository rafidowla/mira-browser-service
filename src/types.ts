/**
 * types.ts - Shared type contracts for mira-browser-service.
 *
 * Purpose: Defines all request/response and domain interfaces used across
 * the service. Centralises the API surface contract so that server.ts and
 * future task handlers have a stable, typed foundation.
 *
 * No external I/O. Deterministic: Yes. Side Effects: None.
 */

/**
 * Inbound task execution request from the MIRA application.
 *
 * Inputs:
 *   - profile_id: Identifies which browser context to use.
 *   - action: The named operation to perform (e.g. 'read_feed', 'read_profile').
 *   - params: Optional action-specific parameters.
 */
export interface TaskRequest {
  /** Unique identifier of the MIRA profile whose browser context to use. */
  profile_id: string
  /** Named action to execute (e.g. 'read_feed', 'read_profile', 'read_comments'). */
  action: string
  /** Optional action-specific parameters. Schema is action-dependent. */
  params?: Record<string, unknown>
}

/**
 * Outbound response from a task execution attempt.
 *
 * Outputs:
 *   - success: Whether the task completed without error.
 *   - data: Action-specific result payload (present on success).
 *   - error: Human-readable error message (present on failure).
 */
export interface TaskResponse {
  /** True if the task completed successfully. */
  success: boolean
  /** Action-specific result payload. Shape varies by action. */
  data?: unknown
  /** Human-readable error description. Present only when success is false. */
  error?: string
}

/**
 * Single entry in the local audit log.
 *
 * Every task execution - successful or not - produces one AuditEntry.
 * Entries are written to the local filesystem and never transmitted externally.
 */
export interface AuditEntry {
  /** ISO 8601 timestamp of when the action was executed. */
  timestamp: string
  /** Profile ID the action was executed for. */
  profile_id: string
  /** The action that was requested. */
  action: string
  /** Whether the action succeeded or failed. */
  result: 'success' | 'failure'
  /** Optional human-readable detail for debugging (e.g. error message, URL reached). */
  detail?: string
}

/**
 * Current status of a managed browser session.
 *
 * Returned by POST /session/status.
 */
export interface SessionStatus {
  /** Profile ID this status describes. */
  profile_id: string
  /**
   * Lifecycle state of the session:
   *   - uninitialised: Browser context not yet created.
   *   - active: Currently executing a task.
   *   - idle: Initialised and ready, not currently executing.
   *   - error: In an error state; reinitialisation may be required.
   */
  status: 'uninitialised' | 'active' | 'idle' | 'error'
  /** ISO 8601 timestamp of the last completed action. Present when status is 'idle'. */
  last_active?: string
}
