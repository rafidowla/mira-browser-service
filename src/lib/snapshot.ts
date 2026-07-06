/**
 * snapshot.ts - On-failure DOM snapshot capture, local disk only (Canon H1.4
 * item 3).
 *
 * Purpose: When a read action's extraction confidence is low (see
 * confidence.ts) or the action throws, the live DOM that caused the miss is
 * gone the moment the page navigates away or the process restarts — exactly
 * the moment a human needs to see it to repair the selector chains in
 * selector-registry.ts. This module writes the page's outerHTML to a local,
 * gitignored `snapshots/` directory next to the service so the founder can
 * open it offline and diff against the live selectors during H1.4/H1.9
 * live-tuning sessions.
 *
 * Hard constraint: this NEVER uploads or transmits the snapshot anywhere.
 * It is a local file write only — no network call in this module, ever.
 *
 * Side Effects: Writes files under SNAPSHOTS_ROOT. Deterministic: No (I/O,
 * timestamps). Error Behavior: Never throws — a snapshot failure must not
 * take down the read action that triggered it.
 */

import * as fs from 'fs'
import * as path from 'path'

/** Base directory for on-failure snapshots — sibling of sessions/, gitignored. */
export const SNAPSHOTS_ROOT = path.join(process.cwd(), 'snapshots')

/** Reason a snapshot was captured — kept in the filename and a sidecar meta file. */
export type SnapshotReason = 'low_confidence' | 'thrown_error' | 'auth_wall'

/** Metadata written alongside each snapshot's HTML file. */
export interface SnapshotMeta {
  action: string
  profile_id: string
  reason: SnapshotReason
  url: string
  timestamp: string
  detail?: string
}

/**
 * Builds a filesystem-safe base filename (no extension) for a snapshot,
 * deterministic given the same inputs except for the timestamp component.
 *
 * Exported for testability — filename shape should not silently change
 * without a test noticing.
 *
 * @param action - The action name (e.g. "read-feed").
 * @param profile_id - MIRA profile identifier.
 * @param reason - Why the snapshot was taken.
 * @param timestamp - ISO timestamp; caller supplies it so tests are deterministic.
 * @returns A safe base filename, e.g. "read-feed_myprofile_low_confidence_2026-07-06T12-00-00-000Z".
 */
export function buildSnapshotBaseName(
  action: string,
  profile_id: string,
  reason: SnapshotReason,
  timestamp: string,
): string {
  const safe = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '_')
  const safeTimestamp = timestamp.replace(/[:.]/g, '-')
  return `${safe(action)}_${safe(profile_id)}_${reason}_${safeTimestamp}`
}

/**
 * Writes an HTML snapshot and its metadata sidecar to SNAPSHOTS_ROOT.
 *
 * Purpose: Offline selector repair — the founder (or a future session) can
 * open the saved .html file in a browser or editor and inspect exactly what
 * LinkedIn served, then update selector-registry.ts accordingly.
 *
 * @param html - Full page HTML (e.g. from `page.content()`).
 * @param meta - SnapshotMeta describing why/what/when.
 * @returns Absolute path to the written .html file, or null if the write failed.
 *
 * Side Effects: Creates SNAPSHOTS_ROOT if missing; writes two files.
 * Error Behavior: Catches all errors, logs a warning, returns null — never throws.
 * Network: None. This function makes no HTTP/network calls of any kind.
 */
export function saveSnapshot(html: string, meta: SnapshotMeta): string | null {
  try {
    fs.mkdirSync(SNAPSHOTS_ROOT, { recursive: true })
    const baseName = buildSnapshotBaseName(meta.action, meta.profile_id, meta.reason, meta.timestamp)
    const htmlPath = path.join(SNAPSHOTS_ROOT, `${baseName}.html`)
    const metaPath = path.join(SNAPSHOTS_ROOT, `${baseName}.meta.json`)

    fs.writeFileSync(htmlPath, html, 'utf-8')
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf-8')

    console.warn(`[snapshot] Saved on-failure DOM snapshot: ${htmlPath} (reason: ${meta.reason})`)
    return htmlPath
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[snapshot] Failed to save snapshot for ${meta.action}/${meta.profile_id}: ${message}`)
    return null
  }
}
