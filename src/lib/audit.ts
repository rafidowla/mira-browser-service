/**
 * audit.ts - In-memory append-only audit log for browser actions.
 *
 * Purpose: Records every browser action attempted by the service, whether
 * successful or failed. Provides the GET /audit endpoint with real data.
 * Will be persisted to SurrealDB in Block 3.6.
 *
 * Design: Simple append-only in-memory array. getAuditLog() returns a copy
 * to prevent external mutation of the log.
 *
 * Side Effects: logAudit() appends to module-level auditLog array.
 * Deterministic: No (timestamps and UUIDs). Concurrency: Safe (single-process).
 */

/**
 * A single audit log entry recording one browser action attempt.
 */
export interface AuditEntry {
  /** Unique identifier for this audit entry (crypto.randomUUID()). */
  id: string
  /** ISO 8601 timestamp of when the action was attempted. */
  timestamp: string
  /** MIRA profile identifier that executed the action. */
  profile_id: string
  /** Name of the action executed (e.g. "read-feed", "read-profile"). */
  action: string
  /** Whether the action completed successfully or failed. */
  result: "success" | "failure"
  /** Optional detail — error message on failure, summary on success. */
  detail?: string
}

/** Module-level append-only audit log. Never cleared during a session. */
const auditLog: AuditEntry[] = []

/**
 * Appends a new entry to the audit log.
 *
 * Purpose: Called by every action handler (read-feed, read-comments, etc.)
 * immediately after an action completes or fails, to maintain a complete
 * local record of all browser automation performed on the operator's behalf.
 *
 * @param entry - All fields except id and timestamp (generated automatically).
 *
 * Side Effects: Appends to module-level auditLog array.
 * Deterministic: No (generates UUID and timestamp).
 * Concurrency: Safe — single-process Node.js event loop.
 */
export function logAudit(entry: Omit<AuditEntry, "id" | "timestamp">): void {
  const fullEntry: AuditEntry = {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    ...entry,
  }
  auditLog.push(fullEntry)
  console.log(`[Audit] ${fullEntry.timestamp} | ${fullEntry.profile_id} | ${fullEntry.action} | ${fullEntry.result}${fullEntry.detail ? " | " + fullEntry.detail : ""}`)
}

/**
 * Returns a snapshot copy of the full audit log.
 *
 * Purpose: Provides the GET /audit endpoint with a safe, non-mutable copy
 * of all recorded actions. Returns a new array on every call.
 *
 * @returns AuditEntry[] — copy of the current audit log.
 *
 * Deterministic: Yes (given same state). Side Effects: None.
 * Performance: O(n) copy — acceptable for typical session sizes.
 */
export function getAuditLog(): AuditEntry[] {
  return [...auditLog]
}
