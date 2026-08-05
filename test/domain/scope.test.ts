import assert from "node:assert/strict";
import { it } from "node:test";
import { catalogFor } from "../../src/domain/catalog.js";

it("excludes health, criminal, military, organization and government questions from this stage", () => {
  const ids = catalogFor({}).map((field) => field.id.toLowerCase()).join(" ");
  for (const excluded of ["health", "criminal", "tuberculosis", "military", "organization", "government", "police"]) {
    assert.equal(ids.includes(excluded), false, `unexpected sensitive field: ${excluded}`);
  }
});

it("excludes the questions removed from the client conversation", () => {
  const ids = new Set(catalogFor({}).map((field) => field.id));
  for (const excluded of [
    "workflow.passport_available",
    "identity.native_name",
    "identity.used_other_name",
    "identity.previous_name",
    "identity.sex",
    "passport.number",
    "passport.taiwan_personal_id",
    "passport.israeli_national",
    "residence.status_from",
    "residence.status_until",
  ]) {
    assert.equal(ids.has(excluded), false, `unexpected client question: ${excluded}`);
  }
});
