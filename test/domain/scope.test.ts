import assert from "node:assert/strict";
import { it } from "node:test";
import { catalogFor } from "../../src/domain/catalog.js";

it("excludes health, criminal, military, organization and government questions from this stage", () => {
  const ids = catalogFor({}).map((field) => field.id.toLowerCase()).join(" ");
  for (const excluded of ["health", "criminal", "tuberculosis", "military", "organization", "government", "police"]) {
    assert.equal(ids.includes(excluded), false, `unexpected sensitive field: ${excluded}`);
  }
});

