import { describe, it, expect } from "vitest";
import { adjustCursor } from "./cursor";

/**
 * These tests pin the module that shipped in the published tarball but was missing
 * from src/ and imported by nothing. See the header of cursor.ts.
 */
describe("adjustCursor", () => {
  it("shifts the row up by the number of trimmed leading lines", () => {
    expect(adjustCursor({ x: 4, y: 7 }, 3, 0, 24)).toEqual({ x: 4, y: 4 });
  });

  it("leaves the column untouched — only rows are trimmed", () => {
    expect(adjustCursor({ x: 11, y: 2 }, 2, 0, 24).x).toBe(11);
  });

  it("clamps a cursor that sat inside the trailing trimmed area", () => {
    // 24 rows, 2 trimmed at the top, 20 at the bottom => last visible row is 1.
    expect(adjustCursor({ x: 0, y: 23 }, 2, 20, 24)).toEqual({ x: 0, y: 1 });
  });

  it("never returns a negative row", () => {
    expect(adjustCursor({ x: 0, y: 1 }, 5, 0, 24).y).toBe(0);
  });

  it("is a no-op when nothing was trimmed", () => {
    expect(adjustCursor({ x: 3, y: 9 }, 0, 0, 24)).toEqual({ x: 3, y: 9 });
  });

  it("skips the clamp when totalRows is unknown", () => {
    // Without totalRows the last visible row cannot be computed, so clamping would
    // be a guess. Shifting still applies.
    expect(adjustCursor({ x: 0, y: 9 }, 2, 5)).toEqual({ x: 0, y: 7 });
  });
});
