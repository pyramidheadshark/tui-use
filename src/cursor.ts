/**
 * cursor.ts
 *
 * Adjusts the raw xterm cursor position to account for lines that were
 * trimmed from the top (leading empty lines) or bottom (trailing empty lines)
 * of the snapshot. Without this correction, cursor.y points into the original
 * buffer coordinates, not the trimmed screen coordinates returned to callers.
 *
 * NOTE (restored 2026-09-05): this module ships in the published npm tarball
 * (dist/cursor.js, dist/cursor.d.ts) but was missing from src/ in the repo, and
 * nothing ever imported it. The coordinate bug it fixes is therefore still live:
 * `snapshot()` trims empty lines while `cursor`, `find` and `highlights` keep
 * reporting raw viewport rows, so callers that index into `lines[]` are off by
 * exactly the number of trimmed leading rows. Restored from the published dist
 * and wired into Session so the fix actually takes effect.
 */

/**
 * Adjust a raw buffer cursor position after trimming empty lines.
 *
 * @param raw             - Original cursor from terminal.buffer.active
 * @param leadingTrimmed  - Number of leading empty lines removed
 * @param trailingTrimmed - Number of trailing empty lines removed
 * @param totalRows       - Total rows in terminal (before trim)
 * @returns Adjusted cursor clamped to the visible screen
 */
export function adjustCursor(
  raw: { x: number; y: number },
  leadingTrimmed: number,
  trailingTrimmed: number,
  totalRows?: number
): { x: number; y: number } {
  let y = raw.y - leadingTrimmed;

  // If cursor was in the trailing trimmed area, clamp to last visible line
  if (totalRows !== undefined && trailingTrimmed > 0) {
    const lastVisible = totalRows - leadingTrimmed - trailingTrimmed - 1;
    if (y > lastVisible) y = lastVisible;
  }

  // Never go negative
  if (y < 0) y = 0;

  return { x: raw.x, y };
}
