import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Session } from "./session";

/**
 * `find` had three defects at once, all invisible to the existing suite:
 *  (a) the regexp carried no `g` flag and a single exec() ran per line, so at most
 *      ONE match per line was ever reported;
 *  (b) `col_end` was exclusive here while `Highlight.col_end` is documented and
 *      tested as inclusive — the same number meant two different columns;
 *  (c) `line` was a raw viewport row, so it disagreed with `snapshot().lines`.
 */
describe("find contract", () => {
  let session: Session;
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tui-use-find-"));
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

  const start = async (script: string, name: string) => {
    session = new Session(name, `bash -c '${script}; sleep 5'`, { cwd: tempDir, cols: 80, rows: 24 });
    await settle();
  };

  it("returns EVERY occurrence on a line, not just the first", async () => {
    await start('printf "aa bb aa bb aa\\n"', "find-multi");
    expect(session.find("aa").length).toBe(3);
  });

  it("col_end is inclusive — same convention as Highlight.col_end", async () => {
    await start('printf "xxABCxx\\n"', "find-inclusive");
    const [m] = session.find("ABC");
    expect(m).toBeDefined();
    // "ABC" starts at 2 and ends at 4 inclusive; exclusive would say 5.
    expect(m.col_end - m.col_start + 1).toBe(m.text.length);
  });

  it("line indexes into snapshot().lines", async () => {
    await start('printf "\\n\\nNEEDLE\\n"', "find-frame");
    const snap = session.snapshot();
    for (const m of session.find("NEEDLE")) {
      expect(m.line).toBeGreaterThanOrEqual(0);
      expect(m.line).toBeLessThan(snap.lines.length);
      expect(snap.lines[m.line]).toContain("NEEDLE");
    }
  });

  it("НЕГАТИВНЫЙ: zero-length pattern terminates instead of spinning forever", async () => {
    // With the `g` flag a zero-length match never advances lastIndex on its own.
    await start('printf "abc\\n"', "find-zero");
    const t0 = Date.now();
    session.find("x*");
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it("НЕГАТИВНЫЙ: invalid pattern still returns empty, not a throw", async () => {
    await start('printf "abc\\n"', "find-bad");
    expect(session.find("([")).toEqual([]);
  });
});
