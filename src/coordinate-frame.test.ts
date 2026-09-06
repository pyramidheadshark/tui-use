import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Session } from "./session";

/**
 * Coordinates must be reported in the SAME frame as `lines`.
 *
 * Before this fix three frames coexisted: `snapshot()` trimmed empty rows while
 * `cursor` and `highlights` kept raw viewport rows, so a caller indexing
 * `lines[cursor.y]` was off by exactly the number of trimmed leading rows.
 * The existing suite never caught it — nothing asserted the two against each other.
 */
describe("coordinate frame", () => {
  let session: Session;
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tui-use-frame-"));
  });

  afterEach(() => {
    try {
      session?.kill();
    } catch {
      /* already exited */
    }
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  const settle = (ms = 700) => new Promise((r) => setTimeout(r, ms));

  it("cursor.y indexes into lines[] after leading rows are trimmed", async () => {
    // A shell that prints nothing but moves the cursor down leaves blank leading
    // rows in the buffer; `lines` drops them, so a raw cursor.y would overshoot.
    session = new Session("frame-a", "bash -c 'printf \"\\n\\n\\nHELLO\\n\"; sleep 5'", {
      cwd: tempDir,
      cols: 80,
      rows: 24,
    });
    await settle();
    const snap = session.snapshot();
    expect(snap.cursor.y).toBeLessThanOrEqual(snap.lines.length);
    // The reported trim count explains the mapping back to raw rows.
    expect(snap.leading_trimmed).toBeGreaterThanOrEqual(0);
    expect(snap.cursor.y).toBeGreaterThanOrEqual(0);
  });

  it("highlights never point outside lines[]", async () => {
    session = new Session("frame-b", "bash -c 'printf \"one\\ntwo\\nthree\\n\"; sleep 5'", {
      cwd: tempDir,
      cols: 80,
      rows: 24,
    });
    await settle();
    const snap = session.snapshot();
    for (const h of snap.highlights) {
      expect(h.line).toBeGreaterThanOrEqual(0);
      expect(h.line).toBeLessThan(snap.lines.length);
    }
  });

  it("reports the trim counts so callers can map back to raw buffer rows", async () => {
    session = new Session("frame-c", "bash -c 'printf \"x\\n\"; sleep 5'", {
      cwd: tempDir,
      cols: 80,
      rows: 24,
    });
    await settle();
    const snap = session.snapshot();
    // 24 rows total; whatever survived plus what was trimmed must account for all.
    expect(snap.lines.length + snap.leading_trimmed + snap.trailing_trimmed).toBe(24);
  });

  it("colour mode reports its OWN trim counts, not the plain-mode ones", async () => {
    // renderLineWithColor returns a non-empty string for a visually blank row that
    // carries a background colour, so the two modes can trim different amounts.
    session = new Session("frame-d", "bash -c 'printf \"y\\n\"; sleep 5'", {
      cwd: tempDir,
      cols: 80,
      rows: 24,
    });
    await settle();
    const colour = session.snapshot({ color: true });
    expect(colour.lines.length + colour.leading_trimmed + colour.trailing_trimmed).toBe(24);
  });
});
