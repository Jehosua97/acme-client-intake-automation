import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { crossFieldIssues, employmentCoverageIssues } from "../../src/domain/consistency.js";
import type { Answer } from "../../src/domain/types.js";

const answer = (fieldId: string, value: string | number): Answer => ({ fieldId, value, status: "CONFIRMED", source: "CHAT", updatedAt: new Date().toISOString() });

describe("cross-field consistency", () => {
  it("detects gaps in the required ten-year activity history", () => {
    const answers = {
      "employment.1.from": answer("employment.1.from", "2016-08"),
      "employment.1.until": answer("employment.1.until", "2020-01"),
      "employment.2.from": answer("employment.2.from", "2020-03"),
      "employment.2.until": answer("employment.2.until", "CURRENT"),
    };
    const issues = employmentCoverageIssues(answers, new Date("2026-08-05T00:00:00Z"));
    assert.equal(issues.some((issue) => issue.includes("02/2020")), true);
  });

  it("accepts overlapping intervals that cover all ten years", () => {
    const answers = {
      "employment.1.from": answer("employment.1.from", "2016-08"),
      "employment.1.until": answer("employment.1.until", "2021-06"),
      "employment.2.from": answer("employment.2.from", "2021-06"),
      "employment.2.until": answer("employment.2.until", "CURRENT"),
    };
    assert.deepEqual(employmentCoverageIssues(answers, new Date("2026-08-05T00:00:00Z")), []);
  });

  it("detects impossible passport and visit chronology", () => {
    const answers = {
      "identity.birth_date": answer("identity.birth_date", "2030-01-01"),
      "passport.issue_date": answer("passport.issue_date", "2025-01-01"),
      "passport.expiry_date": answer("passport.expiry_date", "2024-01-01"),
      "visit.from": answer("visit.from", "2027-06-01"),
      "visit.until": answer("visit.until", "2027-05-01"),
      "employment.1.from": answer("employment.1.from", "2010-01"),
      "employment.1.until": answer("employment.1.until", "CURRENT"),
    };
    assert.equal(crossFieldIssues(answers, new Date("2026-08-05T00:00:00Z")).length, 3);
  });
});
