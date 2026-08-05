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
    "parent1.deceased",
    "parent2.deceased",
    "contact.mailing_unit",
    "contact.mailing_street_number",
    "contact.mailing_street_name",
    "contact.mailing_city",
    "contact.mailing_province",
    "contact.mailing_postal_code",
    "contact.mailing_district",
    "contact.residential_same",
    "contact.residential_unit",
    "contact.residential_street_number",
    "contact.residential_street_name",
    "contact.residential_city",
    "contact.residential_province",
    "contact.residential_postal_code",
    "contact.mailing_same",
  ]) {
    assert.equal(ids.has(excluded), false, `unexpected client question: ${excluded}`);
  }
});

it("does not ask a separate deceased question for parents or children", () => {
  const ids = catalogFor({ "children.count": { fieldId: "children.count", value: 1, status: "CONFIRMED", source: "CHAT", confidence: 100, updatedAt: new Date().toISOString() } }).map((field) => field.id);
  assert.equal(ids.some((id) => id.endsWith(".deceased")), false);
});

it("uses one complete-name field instead of separate first and last names", () => {
  const ids = catalogFor({}).map((field) => field.id);
  assert.equal(ids.some((id) => id.endsWith(".first_names") || id.endsWith(".last_names")), false);
  for (const required of ["identity.full_name", "parent1.full_name", "parent2.full_name"]) {
    assert.equal(ids.includes(required), true, `missing complete-name field: ${required}`);
  }
});
