import { describe, expect, it } from "vitest";
import { haversine, segmentMeters } from "../src/index";
import cases from "../../shared/cases.json";

// The web page and the phone check the same cases: a rule changed in one copy only fails a test.
describe("rules shared with the web page and the phone", () => {
  it("measures distance the same way", () => {
    for (const [a, b, c, d, m] of cases.haversine) expect(haversine(a, b, c, d)).toBeCloseTo(m, 2);
  });
  it("counts a step between two fixes the same way", () => {
    for (const c of cases.segmentMeters as (number | null)[][]) {
      expect(segmentMeters(c[0]!, c[1]!, c[2], c[3], c[4], c[5]), JSON.stringify(c)).toBe(c[6]);
    }
  });
});
